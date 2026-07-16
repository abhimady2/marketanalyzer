// Orchestrator: macro inputs (cached 30m) + fresh candles/news/spot → macro regime
// + technicals → fused gold verdict → (optional) AI narrative → persist snapshot.
// Macro data (FRED/CoinGecko/Yahoo-equities/global-M2) barely moves intraday and is
// rate-limited, so it's cached 30m; candles/price/news refresh every call for the
// live dashboard (they come mostly from the MT5 feed in Supabase — fast, no limits).

import { fetchFred } from '@/lib/data/fred';
import { fetchCrypto } from '@/lib/data/crypto';
import { fetchEquities } from '@/lib/data/equities';
import { fetchGlobalM2 } from '@/lib/data/globalm2';
import { fetchAllTimeframes } from '@/lib/data/candles';
import { fetchNews } from '@/lib/data/news';
import { fetchSpot } from '@/lib/data/price';
import { fetchHeadlines, type Headline } from '@/lib/data/headlines';
import { readMt5Feed } from '@/lib/data/mt5';
import type { Candle, Timeframe } from '@/lib/data/candles';
import { computeRegime, type RegimeInputs, type RegimeResult } from './regime';
import { computeTechnical, type TechnicalResult } from './technical';
import { fuse, type Verdict } from './fusion';
import { computeScalp, microContext, type ScalpSignal } from './scalp';
import { computeLevels, type LevelsResult } from './levels';
import { generateNarrative, type Narrative } from './narrative';
import { getSupabase } from '@/lib/supabase';

export interface Snapshot {
  verdict: Verdict;
  scalp: ScalpSignal;
  levels: LevelsResult;
  regime: RegimeResult;
  technical: TechnicalResult;
  news: { events: any[]; upcomingHighUSD: any[]; eventRiskSoon: boolean; source: string };
  headlines: Headline[];
  narrative: Narrative | null;
  spark: number[];   // recent 15m closes for the price sparkline
  at: number;
  computeMs: number;
}

const CACHE_KEY = 'verdict:latest';
const INPUTS_KEY = 'macro:inputs';
const INPUTS_TTL = 30 * 60 * 1000;

async function safe<T>(p: Promise<T>, fallback: T): Promise<T> { try { return await p; } catch { return fallback; } }
const emptyTF = (): Record<Timeframe, Candle[]> => ({ '1d': [], '4h': [], '1h': [], '15m': [] });

export async function getLatestSnapshot(): Promise<Snapshot | null> {
  try {
    const { data } = await getSupabase().from('ma_cache').select('payload').eq('key', CACHE_KEY).maybeSingle();
    return (data?.payload as Snapshot) ?? null;
  } catch { return null; }
}

// Macro inputs, cached 30m (slow-moving + rate-limited sources), stale-fallback.
async function getRegimeInputs(): Promise<RegimeInputs> {
  const sb = getSupabase();
  let cached: RegimeInputs | null = null;
  try {
    const { data } = await sb.from('ma_cache').select('payload, updated_at').eq('key', INPUTS_KEY).maybeSingle();
    if (data?.payload) { cached = data.payload as RegimeInputs; if (Date.now() - +new Date(data.updated_at) < INPUTS_TTL) return cached; }
  } catch { /* no cache */ }

  const [fred, crypto, equities, gm2] = await Promise.all([
    safe(fetchFred(), {}), safe(fetchCrypto(), {}), safe(fetchEquities(), {}), safe(fetchGlobalM2(), {}),
  ]);
  const inputs = { ...fred, ...crypto, ...equities, ...gm2 } as RegimeInputs;
  if (inputs.fedNow != null || inputs.spyNow != null || inputs.stablesNow != null) {
    try { await sb.from('ma_cache').upsert({ key: INPUTS_KEY, payload: inputs, updated_at: new Date().toISOString() }, { onConflict: 'key' }); } catch { /* best effort */ }
    return inputs;
  }
  return cached ?? inputs;
}

export async function runAnalysis(withNarrative = false): Promise<Snapshot> {
  const t0 = Date.now();
  // Fast layer (every poll): candles/news/spot come mostly from the MT5 feed in
  // Supabase — cheap. Headlines (Google News RSS) are only fetched on the narrative
  // runs to avoid rate-limiting; otherwise carried from the previous snapshot.
  const [inputs, candles, news, spot, freshHeadlines, mt5, prev] = await Promise.all([
    getRegimeInputs(),
    safe(fetchAllTimeframes(), emptyTF()),
    safe(fetchNews(), { events: [], upcomingHighUSD: [], eventRiskSoon: false, source: 'none' as const, at: Date.now() }),
    safe(fetchSpot(), null),
    withNarrative ? safe(fetchHeadlines(), [] as Headline[]) : Promise.resolve([] as Headline[]),
    safe(readMt5Feed(), null),
    getLatestSnapshot(),   // previous snapshot: narrative carry + scalp flip detection
  ]);

  const regime = computeRegime(inputs);
  const technical = computeTechnical(candles);
  const verdict = fuse(regime, technical, news, spot);

  // Structure (S/R zones) → then the fast scalp signal, which uses it as a guard.
  const m1c = mt5?.candles?.['1m'] ?? [], m5c = mt5?.candles?.['5m'] ?? [];
  const livePrice = spot?.price ?? candles['15m']?.[candles['15m'].length - 1]?.c ?? 0;
  const mctx = microContext(m1c, m5c, technical, verdict.goldMacroBias);
  const levels = computeLevels({
    m15: candles['15m'] ?? [], h1: candles['1h'] ?? [], h4: candles['4h'] ?? [], d1: candles['1d'] ?? [],
    price: livePrice, microDir: mctx.microDir, higherBias: mctx.higherBias,
  });

  // Fast scalp signal from the MT5 M1/M5 feed (the $1 / 100-point trigger).
  const scalp = computeScalp({
    m1: m1c, m5: m5c,
    technical, goldMacroBias: verdict.goldMacroBias,
    bid: mt5?.price?.bid ?? null, ask: mt5?.price?.ask ?? null,
    upcomingHighUSD: news.upcomingHighUSD, levels,
    prevState: prev?.scalp?.state ?? null, now: Date.now(),
  });

  let narrative: Narrative | null = withNarrative
    ? await safe(generateNarrative(verdict, regime, technical, news, freshHeadlines), null) : null;
  narrative = narrative ?? prev?.narrative ?? null;                     // keep last AI text
  const headlines = withNarrative ? freshHeadlines : (prev?.headlines ?? []); // carry on fast polls

  if (narrative?.live && narrative.live.impact === 'High' && narrative.live.label !== 'Neutral') {
    verdict.cautions.push(`Live headlines skew ${narrative.live.label.toLowerCase()} (high impact): ${narrative.live.summary}`);
  }

  const spark = (candles['15m']?.length ? candles['15m'] : candles['1h'] || []).slice(-96).map((c) => c.c);

  const snapshot: Snapshot = {
    verdict, scalp, levels, regime, technical,
    news: { events: news.events.slice(0, 12), upcomingHighUSD: news.upcomingHighUSD.slice(0, 6), eventRiskSoon: news.eventRiskSoon, source: news.source },
    headlines: headlines.slice(0, 10),
    narrative, spark, at: Date.now(), computeMs: Date.now() - t0,
  };

  await safe(persist(snapshot), undefined);
  return snapshot;
}

async function persist(s: Snapshot): Promise<void> {
  const sb = getSupabase();
  await sb.from('ma_cache').upsert({ key: CACHE_KEY, payload: s, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  await sb.from('ma_analysis_snapshots').insert({ kind: 'verdict', payload: s });
}
