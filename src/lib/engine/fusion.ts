// Fusion: Mission Control macro regime + multi-timeframe technicals + forex news
// → one calibrated XAUUSD verdict. The macro score is a risk-asset regime; for
// GOLD specifically the liquidity/dollar/rate sub-signals are what matter, so we
// derive a gold-specific macro bias from those rather than the raw risk regime.
//
// Every weight/threshold below is a CALIBRATION KNOB — tune against outcomes.
// ponytail: first-cut mapping grounded in gold drivers; adjust weights with data.

import type { RegimeResult } from './regime';
import type { TechnicalResult } from './technical';
import type { NewsResult } from '@/lib/data/news';
import type { Spot } from '@/lib/data/price';

export interface FusionWeights {
  // gold macro bias = weighted avg of these (available components renormalised)
  wLiquidity: number; wDollar: number; wRates: number; wPulse: number;
  // final bias = wMacro*goldMacro + wTech*technical
  wMacro: number; wTech: number;
  dxyFull: number;   // DXY ROC % that = full-weight bearish gold
  ratesFull: number; // 10Y yield ROC % that = full-weight bearish gold
}

export const DEFAULT_WEIGHTS: FusionWeights = {
  wLiquidity: 0.4, wDollar: 0.25, wRates: 0.2, wPulse: 0.15,
  wMacro: 0.5, wTech: 0.5, dxyFull: 3, ratesFull: 8,
};

export type Direction = 'Bullish' | 'Bearish' | 'Neutral' | 'Unknown';

export interface Verdict {
  direction: Direction;
  bias: number;            // [-1,+1]
  confidence: number;      // 0..100
  goldMacroBias: number | null;
  technicalBias: number | null;
  macroRegime: RegimeResult['regime'];
  macroTotal: number | null;
  agreement: 'aligned' | 'divergent' | 'n/a';
  cautions: string[];
  spot: Spot | null;
  components: {
    liquidity: number | null; dollar: number | null; rates: number | null; pulse: number | null;
  };
  coverage: number;        // macro data coverage 0..1
  asOf: number;
}

const clamp = (x: number, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, x));

// Weighted mean over the entries whose value is non-null (renormalises weights).
function wmean(pairs: [number | null, number][]): number | null {
  let acc = 0, w = 0;
  for (const [v, wt] of pairs) if (v != null && !Number.isNaN(v)) { acc += v * wt; w += wt; }
  return w > 0 ? acc / w : null;
}

export function fuse(
  macro: RegimeResult,
  tech: TechnicalResult,
  news: NewsResult,
  spot: Spot | null,
  W: FusionWeights = DEFAULT_WEIGHTS,
  now = Date.now(),
): Verdict {
  const s = macro.signals;
  // Map each gold driver to [-1,+1] where +1 = bullish gold.
  const liquidity = s.liquidityScore != null ? clamp((s.liquidityScore - 50) / 50) : null; // expanding liquidity → +
  const dollar = s.dxyRoc21 != null ? clamp(-s.dxyRoc21 / W.dxyFull) : null;               // weaker dollar → +
  const rates = s.y10Roc != null ? clamp(-s.y10Roc / W.ratesFull) : null;                  // falling yields → +
  const pulse = s.pulse != null ? clamp(s.pulse / 2) : null;                               // improving pulse → +

  const goldMacroBias = wmean([
    [liquidity, W.wLiquidity], [dollar, W.wDollar], [rates, W.wRates], [pulse, W.wPulse],
  ]);
  const technicalBias = tech.available ? tech.bias : null;

  const bias = wmean([[goldMacroBias, W.wMacro], [technicalBias, W.wTech]]) ?? 0;

  // Agreement between the two independent views.
  let agreement: Verdict['agreement'] = 'n/a';
  if (goldMacroBias != null && technicalBias != null) {
    agreement = Math.sign(goldMacroBias) === Math.sign(technicalBias) || Math.abs(goldMacroBias) < 0.1 || Math.abs(technicalBias) < 0.1
      ? 'aligned' : 'divergent';
  }

  // Confidence: technical conviction + macro coverage + |bias| conviction, scaled
  // by agreement, trimmed by imminent high-impact news.
  const agreeFactor = agreement === 'divergent' ? 0.6 : 1;
  const newsFactor = news.eventRiskSoon ? 0.8 : 1;
  const convBias = Math.min(1, Math.abs(bias) * 1.6 + 0.35);
  let confidence = (0.45 * (tech.confidence / 100) + 0.30 * macro.coverage + 0.25 * convBias) * 100;
  confidence = Math.round(clamp(confidence * agreeFactor * newsFactor, 0, 100));

  const cautions: string[] = [];
  if (agreement === 'divergent') cautions.push('Macro and technicals disagree — expect chop / lower conviction.');
  if (news.eventRiskSoon) {
    const e = news.upcomingHighUSD[0];
    cautions.push(`High-impact USD event within 24h${e ? `: ${e.title}` : ''} — headline risk.`);
  }
  if (macro.coverage < 0.4) cautions.push(`Macro data coverage only ${Math.round(macro.coverage * 100)}% — thin inputs.`);
  if (macro.pulse.crash) cautions.push('Liquidity Pulse flagging a fast drawdown (flash-crash guard).');

  const direction: Direction =
    (goldMacroBias == null && technicalBias == null) ? 'Unknown'
      : bias > 0.15 ? 'Bullish' : bias < -0.15 ? 'Bearish' : 'Neutral';

  return {
    direction, bias, confidence,
    goldMacroBias, technicalBias,
    macroRegime: macro.regime, macroTotal: macro.total, agreement,
    cautions, spot,
    components: { liquidity, dollar, rates, pulse },
    coverage: macro.coverage, asOf: now,
  };
}

// ── self-check (npx tsx src/lib/engine/fusion.ts) ────────────────────────────
export function demo(): void {
  const assert = (c: boolean, m: string) => { if (!c) throw new Error('FAIL: ' + m); };
  const macro = (over: Partial<RegimeResult['signals']>): RegimeResult => ({
    total: 70, regime: 'NEUTRAL', buckets: [], pulse: { value: 0.5, prev: 0.4, crash: false, bad: false, available: true },
    coverage: 0.5, thresholds: {} as any,
    signals: { liquidityScore: 80, betaUs: 1, liqAlpha: 0.5, y10Roc: -2, dxyRoc21: -1.5, pulse: 0.8, ...over },
  });
  const tech = (bias: number, conf: number): TechnicalResult => ({ bias, label: 'Bullish', confidence: conf, timeframes: [], available: true });
  const noNews: NewsResult = { events: [], upcomingHighUSD: [], eventRiskSoon: false, source: 'none', at: 0 };

  // Bullish macro (liquidity up, dollar/yields down) + bullish tech → Bullish, confident.
  const v1 = fuse(macro({}), tech(0.6, 90), noNews, null);
  assert(v1.direction === 'Bullish' && v1.bias > 0.3, `expected bullish, got ${v1.direction} ${v1.bias.toFixed(2)}`);
  assert(v1.agreement === 'aligned', 'macro+tech both bullish → aligned');

  // Divergent: bullish macro, bearish tech → near-neutral, lower confidence.
  const v2 = fuse(macro({}), tech(-0.6, 90), noNews, null);
  assert(v2.agreement === 'divergent', 'opposite signs → divergent');
  assert(v2.confidence < v1.confidence, 'divergence should cut confidence');

  // Bearish macro (tight liquidity, strong dollar, rising yields).
  const v3 = fuse(macro({ liquidityScore: 20, dxyRoc21: 3, y10Roc: 8, pulse: -1 }), tech(-0.5, 80), noNews, null);
  assert(v3.direction === 'Bearish' && v3.bias < -0.3, `expected bearish, got ${v3.direction} ${v3.bias.toFixed(2)}`);

  // News risk trims confidence.
  const withNews: NewsResult = { events: [], upcomingHighUSD: [{ title: 'CPI', country: 'USD', impact: 'High', date: '', forecast: '', previous: '', goldRelevant: true }], eventRiskSoon: true, source: 'forexfactory', at: 0 };
  const v4 = fuse(macro({}), tech(0.6, 90), withNews, null);
  assert(v4.confidence < v1.confidence, 'imminent news should trim confidence');
  assert(v4.cautions.some((c) => c.includes('CPI')), 'news caution should mention the event');

  console.log('fusion.ts demo OK —',
    `bull=${v1.direction}/${v1.confidence}, divergent=${v2.direction}/${v2.confidence},`,
    `bear=${v3.direction}/${v3.bias.toFixed(2)}, news-trim=${v4.confidence}`);
}

if (typeof require !== 'undefined' && require.main === module) demo();
