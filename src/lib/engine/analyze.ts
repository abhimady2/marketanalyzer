// Orchestrator: macro inputs (cached) + fresh candles/news/spot → regime + technicals
// → S/R structure → fused verdict → scalp trigger → (AI) narrative + event outlook.
//
// FRESHNESS CONTRACT — nothing the user sees may be silently stale:
//   • price/candles/news/scalp/levels : recomputed every poll (~8s) from the MT5 feed
//   • macro inputs                    : cached MACRO_TTL (daily-cadence data), age reported
//   • AI narrative + event outlook    : SELF-HEALING — any poll where they're older than
//     NARRATIVE_TTL regenerates them inline, so they can't rot waiting on a cron/pinger
//     that may never fire. Every layer's age ships in `freshness` for the UI to show.

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
import { generateEventOutlook, type EventOutlook } from './outlook';
import { shouldEmit, emitSignal, type TradeSignal } from './signals';
import { getSupabase } from '@/lib/supabase';

export interface Snapshot {
  verdict: Verdict;
  scalp: ScalpSignal;
  lastSignal: TradeSignal | null;
  levels: LevelsResult;
  regime: RegimeResult;
  technical: TechnicalResult;
  news: { events: any[]; upcomingHighUSD: any[]; eventRiskSoon: boolean; source: string };
  headlines: Headline[];
  narrative: Narrative | null;
  outlook: EventOutlook | null;
  narrativeAt: number | null;
  freshness: { mt5AgeMs: number | null; macroAgeMs: number | null; narrativeAgeMs: number | null; newsSource: string };
  spark: number[];
  at: number;
  computeMs: number;
}

const CACHE_KEY = 'verdict:latest';
const INPUTS_KEY = 'macro:inputs';
const MACRO_TTL = 20 * 60 * 1000;      // macro sources are daily-cadence; 20m is not stale
const NARRATIVE_TTL = 10 * 60 * 1000;  // AI text/outlook self-heal past this

async function safe<T>(p: Promise<T>, fallback: T): Promise<T> { try { return await p; } catch { return fallback; } }
const emptyTF = (): Record<Timeframe, Candle[]> => ({ '1d': [], '4h': [], '1h': [], '15m': [] });

export async function getLatestSnapshot(): Promise<Snapshot | null> {
  try {
    const { data } = await getSupabase().from('ma_cache').select('payload').eq('key', CACHE_KEY).maybeSingle();
    return (data?.payload as Snapshot) ?? null;
  } catch { return null; }
}

// Macro inputs, cached (slow-moving + rate-limited sources), stale-fallback. Reports age.
async function getRegimeInputs(): Promise<{ inputs: RegimeInputs; ageMs: number }> {
  const sb = getSupabase();
  let cached: RegimeInputs | null = null; let cachedAge = 0;
  try {
    const { data } = await sb.from('ma_cache').select('payload, updated_at').eq('key', INPUTS_KEY).maybeSingle();
    if (data?.payload) {
      cached = data.payload as RegimeInputs;
      cachedAge = Date.now() - +new Date(data.updated_at);
      if (cachedAge < MACRO_TTL) return { inputs: cached, ageMs: cachedAge };
    }
  } catch { /* no cache */ }

  const [fred, crypto, equities, gm2] = await Promise.all([
    safe(fetchFred(), {}), safe(fetchCrypto(), {}), safe(fetchEquities(), {}), safe(fetchGlobalM2(), {}),
  ]);
  const inputs = { ...fred, ...crypto, ...equities, ...gm2 } as RegimeInputs;
  if (inputs.fedNow != null || inputs.spyNow != null || inputs.stablesNow != null) {
    try { await sb.from('ma_cache').upsert({ key: INPUTS_KEY, payload: inputs, updated_at: new Date().toISOString() }, { onConflict: 'key' }); } catch { /* best effort */ }
    return { inputs, ageMs: 0 };
  }
  return cached ? { inputs: cached, ageMs: cachedAge } : { inputs, ageMs: 0 };
}

export async function runAnalysis(withNarrative = false): Promise<Snapshot> {
  const t0 = Date.now();
  const prev = await getLatestSnapshot();
  // Self-healing: regenerate AI text/outlook whenever they'd otherwise be stale.
  const needNarrative = withNarrative || !prev?.narrativeAt || (Date.now() - prev.narrativeAt > NARRATIVE_TTL);

  const [inputsRes, candles, news, spot, freshHeadlines, mt5] = await Promise.all([
    getRegimeInputs(),
    safe(fetchAllTimeframes(), emptyTF()),
    safe(fetchNews(), { events: [], upcomingHighUSD: [], eventRiskSoon: false, source: 'none' as const, at: Date.now() }),
    safe(fetchSpot(), null),
    needNarrative ? safe(fetchHeadlines(), [] as Headline[]) : Promise.resolve([] as Headline[]),
    safe(readMt5Feed(), null),
  ]);

  const regime = computeRegime(inputsRes.inputs);
  const technical = computeTechnical(candles);
  const verdict = fuse(regime, technical, news, spot);

  // Structure (S/R zones) → then the fast scalp trigger, which uses it as a guard.
  const m1c = mt5?.candles?.['1m'] ?? [], m5c = mt5?.candles?.['5m'] ?? [];
  const livePrice = spot?.price ?? candles['15m']?.[candles['15m'].length - 1]?.c ?? 0;
  const mctx = microContext(m1c, m5c, technical, verdict.goldMacroBias);
  const levels = computeLevels({
    m15: candles['15m'] ?? [], h1: candles['1h'] ?? [], h4: candles['4h'] ?? [], d1: candles['1d'] ?? [],
    price: livePrice, microDir: mctx.microDir, higherBias: mctx.higherBias,
  });
  const scalp = computeScalp({
    m1: m1c, m5: m5c, technical, goldMacroBias: verdict.goldMacroBias,
    bid: mt5?.price?.bid ?? null, ask: mt5?.price?.ask ?? null,
    upcomingHighUSD: news.upcomingHighUSD, levels,
    prevState: prev?.scalp?.state ?? null, now: Date.now(),
  });

  // Dispatch a trade signal to the paper-trader the moment the scalp turns actionable
  // (>75% conviction). Once per episode — never re-fired while the same call persists.
  let lastSignal: TradeSignal | null = prev?.lastSignal ?? null;
  if (shouldEmit(scalp, prev?.scalp ?? null)) {
    const s = await safe(emitSignal(scalp, mt5?.price?.bid ?? null, mt5?.price?.ask ?? null, livePrice, levels), null);
    if (s) lastSignal = s;
  }

  // AI layer (narrative + next-event outlook) — raced together, only when needed.
  let narrative: Narrative | null = null;
  let outlook: EventOutlook | null = null;
  if (needNarrative) {
    const ev = news.upcomingHighUSD[0];
    const [nar, out] = await Promise.all([
      safe(generateNarrative(verdict, regime, technical, news, freshHeadlines), null),
      ev ? safe(generateEventOutlook(
        { title: ev.title, country: ev.country, impact: ev.impact, date: ev.date, forecast: ev.forecast, previous: ev.previous },
        { price: livePrice, macroBias: verdict.goldMacroBias, technical: technical.label, resistance: levels.nearestResistance?.price ?? null, support: levels.nearestSupport?.price ?? null },
      ), null) : Promise.resolve(null),
    ]);
    narrative = nar; outlook = out;
  }
  const narrativeAt = narrative ? Date.now() : (prev?.narrativeAt ?? null);
  narrative = narrative ?? prev?.narrative ?? null;
  outlook = outlook ?? prev?.outlook ?? null;
  const headlines = needNarrative ? freshHeadlines : (prev?.headlines ?? []);

  if (narrative?.live && narrative.live.impact === 'High' && narrative.live.label !== 'Neutral') {
    verdict.cautions.push(`Live headlines skew ${narrative.live.label.toLowerCase()} (high impact): ${narrative.live.summary}`);
  }
  if (levels.warning) verdict.cautions.push(levels.warning);

  const spark = (candles['15m']?.length ? candles['15m'] : candles['1h'] || []).slice(-96).map((c) => c.c);
  const at = Date.now();

  const snapshot: Snapshot = {
    verdict, scalp, lastSignal, levels, regime, technical,
    news: { events: news.events.slice(0, 12), upcomingHighUSD: news.upcomingHighUSD.slice(0, 6), eventRiskSoon: news.eventRiskSoon, source: news.source },
    headlines: headlines.slice(0, 10),
    narrative, outlook, narrativeAt,
    freshness: {
      mt5AgeMs: mt5?.ageMs ?? null,
      macroAgeMs: inputsRes.ageMs,
      narrativeAgeMs: narrativeAt ? at - narrativeAt : null,
      newsSource: news.source,
    },
    spark, at, computeMs: at - t0,
  };

  await safe(persist(snapshot), undefined);
  return snapshot;
}

async function persist(s: Snapshot): Promise<void> {
  const sb = getSupabase();
  await sb.from('ma_cache').upsert({ key: CACHE_KEY, payload: s, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  await sb.from('ma_analysis_snapshots').insert({ kind: 'verdict', payload: s });
}
