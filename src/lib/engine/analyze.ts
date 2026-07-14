// Orchestrator: fetch every free source in parallel → macro regime + technicals
// + news → fused gold verdict → (optional) AI narrative → persist snapshot.

import { fetchFred } from '@/lib/data/fred';
import { fetchCrypto } from '@/lib/data/crypto';
import { fetchEquities } from '@/lib/data/equities';
import { fetchAllTimeframes } from '@/lib/data/candles';
import { fetchNews } from '@/lib/data/news';
import { fetchSpot } from '@/lib/data/price';
import { fetchHeadlines, type Headline } from '@/lib/data/headlines';
import type { Candle, Timeframe } from '@/lib/data/candles';
import { computeRegime, type RegimeInputs, type RegimeResult } from './regime';
import { computeTechnical, type TechnicalResult } from './technical';
import { fuse, type Verdict } from './fusion';
import { generateNarrative, type Narrative } from './narrative';
import { getSupabase } from '@/lib/supabase';

export interface Snapshot {
  verdict: Verdict;
  regime: RegimeResult;
  technical: TechnicalResult;
  news: { events: any[]; upcomingHighUSD: any[]; eventRiskSoon: boolean; source: string };
  headlines: Headline[];
  narrative: Narrative | null;
  at: number;
  computeMs: number;
}

const CACHE_KEY = 'verdict:latest';
async function safe<T>(p: Promise<T>, fallback: T): Promise<T> { try { return await p; } catch { return fallback; } }
const emptyTF = (): Record<Timeframe, Candle[]> => ({ '1d': [], '4h': [], '1h': [], '15m': [] });

export async function getLatestSnapshot(): Promise<Snapshot | null> {
  try {
    const { data } = await getSupabase().from('ma_cache').select('payload').eq('key', CACHE_KEY).maybeSingle();
    return (data?.payload as Snapshot) ?? null;
  } catch { return null; }
}

export async function runAnalysis(withNarrative = false): Promise<Snapshot> {
  const t0 = Date.now();
  const [fred, crypto, equities, candles, news, spot, headlines] = await Promise.all([
    safe(fetchFred(), {}),
    safe(fetchCrypto(), {}),
    safe(fetchEquities(), {}),
    safe(fetchAllTimeframes(), emptyTF()),
    safe(fetchNews(), { events: [], upcomingHighUSD: [], eventRiskSoon: false, source: 'none' as const, at: Date.now() }),
    safe(fetchSpot(), null),
    safe(fetchHeadlines(), [] as Headline[]),
  ]);

  const inputs = { ...fred, ...crypto, ...equities } as RegimeInputs;
  const regime = computeRegime(inputs);
  const technical = computeTechnical(candles);
  const verdict = fuse(regime, technical, news, spot);

  let narrative: Narrative | null = null;
  if (withNarrative) narrative = await safe(generateNarrative(verdict, regime, technical, news, headlines), null);
  if (!narrative) { const prev = await getLatestSnapshot(); narrative = prev?.narrative ?? null; } // keep last good AI text

  // Live headlines only nudge the verdict when the AI flags a real, high-impact skew.
  if (narrative?.live && narrative.live.impact === 'High' && narrative.live.label !== 'Neutral') {
    verdict.cautions.push(`Live headlines skew ${narrative.live.label.toLowerCase()} (high impact): ${narrative.live.summary}`);
  }

  const snapshot: Snapshot = {
    verdict, regime, technical,
    news: { events: news.events.slice(0, 12), upcomingHighUSD: news.upcomingHighUSD.slice(0, 6), eventRiskSoon: news.eventRiskSoon, source: news.source },
    headlines: headlines.slice(0, 10),
    narrative, at: Date.now(), computeMs: Date.now() - t0,
  };

  await safe(persist(snapshot), undefined);
  return snapshot;
}

async function persist(s: Snapshot): Promise<void> {
  const sb = getSupabase();
  await sb.from('ma_cache').upsert({ key: CACHE_KEY, payload: s, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  await sb.from('ma_analysis_snapshots').insert({ kind: 'verdict', payload: s });
}
