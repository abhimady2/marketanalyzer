// Multi-timeframe XAUUSD technical trend. This is the TIMING/CONFIRMATION layer
// that the fusion step combines with the Mission Control macro regime + news.
// Per timeframe: EMA(20/50/200) alignment + RSI(14) + MACD(12,26,9) histogram +
// ADX(14) strength → a trend score in [-1,+1]. Timeframes weighted D1>H4>H1>M15.

import type { Candle, Timeframe } from '@/lib/data/candles';

// ── indicator math ────────────────────────────────────────────────────────
export function sma(v: number[], p: number): number | null {
  if (v.length < p) return null;
  let s = 0; for (let i = v.length - p; i < v.length; i++) s += v[i];
  return s / p;
}
export function ema(v: number[], p: number): number | null {
  if (v.length < p) return null;
  const k = 2 / (p + 1);
  let e = v.slice(0, p).reduce((a, b) => a + b, 0) / p; // seed with SMA
  for (let i = p; i < v.length; i++) e = v[i] * k + e * (1 - k);
  return e;
}
export function rsi(v: number[], p = 14): number | null {
  if (v.length < p + 1) return null;
  let gain = 0, loss = 0;
  for (let i = v.length - p; i < v.length; i++) {
    const d = v[i] - v[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  const avgG = gain / p, avgL = loss / p;
  if (avgL === 0) return 100;
  const rs = avgG / avgL;
  return 100 - 100 / (1 + rs);
}
// MACD histogram (last value): EMA12 - EMA26, signal EMA9 of that line.
export function macdHist(v: number[], fast = 12, slow = 26, sig = 9): number | null {
  if (v.length < slow + sig) return null;
  const line: number[] = [];
  const kF = 2 / (fast + 1), kS = 2 / (slow + 1);
  let eF = v.slice(0, fast).reduce((a, b) => a + b, 0) / fast;
  let eS = v.slice(0, slow).reduce((a, b) => a + b, 0) / slow;
  for (let i = 0; i < v.length; i++) {
    if (i >= fast) eF = v[i] * kF + eF * (1 - kF);
    if (i >= slow) eS = v[i] * kS + eS * (1 - kS);
    if (i >= slow) line.push(eF - eS);
  }
  const kSig = 2 / (sig + 1);
  let signal = line.slice(0, sig).reduce((a, b) => a + b, 0) / sig;
  for (let i = sig; i < line.length; i++) signal = line[i] * kSig + signal * (1 - kSig);
  return line[line.length - 1] - signal;
}
// ADX(14) via Wilder smoothing → trend strength (not direction).
export function adx(c: Candle[], p = 14): number | null {
  if (c.length < p * 2 + 1) return null;
  const tr: number[] = [], plusDM: number[] = [], minusDM: number[] = [];
  for (let i = 1; i < c.length; i++) {
    const up = c[i].h - c[i - 1].h, dn = c[i - 1].l - c[i].l;
    plusDM.push(up > dn && up > 0 ? up : 0);
    minusDM.push(dn > up && dn > 0 ? dn : 0);
    tr.push(Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c)));
  }
  const wilder = (arr: number[]) => {
    let s = arr.slice(0, p).reduce((a, b) => a + b, 0);
    const out = [s];
    for (let i = p; i < arr.length; i++) { s = s - s / p + arr[i]; out.push(s); }
    return out;
  };
  const trS = wilder(tr), pS = wilder(plusDM), mS = wilder(minusDM);
  const dx: number[] = [];
  for (let i = 0; i < trS.length; i++) {
    const pDI = 100 * (pS[i] / trS[i]), mDI = 100 * (mS[i] / trS[i]);
    const sum = pDI + mDI;
    dx.push(sum === 0 ? 0 : 100 * Math.abs(pDI - mDI) / sum);
  }
  if (dx.length < p) return null;
  let a = dx.slice(0, p).reduce((x, y) => x + y, 0) / p;
  for (let i = p; i < dx.length; i++) a = (a * (p - 1) + dx[i]) / p;
  return a;
}

// ── per-timeframe trend ─────────────────────────────────────────────────────
export interface TFTrend {
  tf: Timeframe;
  score: number;       // [-1,+1]
  label: 'Bullish' | 'Bearish' | 'Neutral';
  strength: number | null; // ADX
  available: boolean;
  signals: string[];
}

export function trendForTF(tf: Timeframe, candles: Candle[]): TFTrend {
  const closes = candles.map((c) => c.c);
  if (closes.length < 30) return { tf, score: 0, label: 'Neutral', strength: null, available: false, signals: [] };

  const price = closes[closes.length - 1];
  const e20 = ema(closes, 20), e50 = ema(closes, 50), e200 = ema(closes, 200);
  const r = rsi(closes, 14), h = macdHist(closes, 12, 26, 9), strength = adx(candles, 14);

  const parts: number[] = [];
  const signals: string[] = [];
  if (e20 != null && e50 != null) { const s = e20 > e50 ? 1 : -1; parts.push(s); signals.push(`EMA20 ${s > 0 ? '>' : '<'} EMA50`); }
  if (e50 != null && e200 != null) { const s = e50 > e200 ? 1 : -1; parts.push(s * 1.2); signals.push(`EMA50 ${s > 0 ? '>' : '<'} EMA200`); }
  if (e50 != null) { const s = price > e50 ? 1 : -1; parts.push(s); signals.push(`Price ${s > 0 ? 'above' : 'below'} EMA50`); }
  if (h != null) { const s = h > 0 ? 1 : -1; parts.push(s * 0.8); signals.push(`MACD ${s > 0 ? 'positive' : 'negative'}`); }
  if (r != null) { const s = r > 55 ? 1 : r < 45 ? -1 : 0; if (s) { parts.push(s * 0.6); signals.push(`RSI ${r.toFixed(0)}`); } }

  const raw = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.reduce((a) => a + 1, 0) : 0;
  // Normalise by max possible per-part weight (~1.2) so score stays within [-1,1].
  const score = Math.max(-1, Math.min(1, raw / 1.0));
  const label = score > 0.2 ? 'Bullish' : score < -0.2 ? 'Bearish' : 'Neutral';
  return { tf, score, label, strength, available: true, signals };
}

// ── multi-timeframe fusion ──────────────────────────────────────────────────
const TF_WEIGHTS: Record<Timeframe, number> = { '1d': 0.4, '4h': 0.3, '1h': 0.2, '15m': 0.1 };

export interface TechnicalResult {
  bias: number;            // [-1,+1] weighted across timeframes
  label: 'Bullish' | 'Bearish' | 'Neutral';
  confidence: number;      // 0..100 (agreement + trend strength)
  timeframes: TFTrend[];
  available: boolean;
}

export function computeTechnical(byTF: Record<Timeframe, Candle[]>): TechnicalResult {
  const order: Timeframe[] = ['1d', '4h', '1h', '15m'];
  const trends = order.map((tf) => trendForTF(tf, byTF[tf] || []));
  const avail = trends.filter((t) => t.available);
  if (avail.length === 0) return { bias: 0, label: 'Neutral', confidence: 0, timeframes: trends, available: false };

  let wSum = 0, biasAcc = 0;
  for (const t of avail) { const w = TF_WEIGHTS[t.tf]; wSum += w; biasAcc += t.score * w; }
  const bias = biasAcc / wSum;

  // Confidence: how aligned the timeframes are (share pointing the bias way) blended
  // with average ADX strength. Both matter — aligned but weak trend ≠ high confidence.
  const dir = Math.sign(bias) || 1;
  const agree = avail.filter((t) => Math.sign(t.score) === dir).length / avail.length;
  const adxs = avail.map((t) => t.strength).filter((x): x is number => x != null);
  const avgAdx = adxs.length ? adxs.reduce((a, b) => a + b, 0) / adxs.length : 15;
  const strengthFactor = Math.max(0, Math.min(1, (avgAdx - 15) / 25)); // ADX 15→0, 40→1
  const confidence = Math.round((0.6 * agree + 0.4 * strengthFactor) * Math.min(1, Math.abs(bias) * 1.5 + 0.4) * 100);

  const label = bias > 0.2 ? 'Bullish' : bias < -0.2 ? 'Bearish' : 'Neutral';
  return { bias, label, confidence, timeframes: trends, available: true };
}

// ── self-check (npx tsx src/lib/engine/technical.ts) ─────────────────────────
export function demo(): void {
  const assert = (c: boolean, m: string) => { if (!c) throw new Error('FAIL: ' + m); };
  const mk = (n: number, dir: number, start = 2000): Candle[] =>
    Array.from({ length: n }, (_, i) => {
      const base = start + dir * i * 2;
      return { t: i, o: base, h: base + 3, l: base - 3, c: base + dir * 1, v: 100 };
    });

  const up = { '1d': mk(260, 1), '4h': mk(260, 1), '1h': mk(260, 1), '15m': mk(260, 1) } as Record<Timeframe, Candle[]>;
  const down = { '1d': mk(260, -1, 3000), '4h': mk(260, -1, 3000), '1h': mk(260, -1, 3000), '15m': mk(260, -1, 3000) } as Record<Timeframe, Candle[]>;

  const ru = computeTechnical(up), rd = computeTechnical(down);
  assert(ru.label === 'Bullish' && ru.bias > 0.5, `uptrend should be bullish, got ${ru.label} ${ru.bias.toFixed(2)}`);
  assert(rd.label === 'Bearish' && rd.bias < -0.5, `downtrend should be bearish, got ${rd.label} ${rd.bias.toFixed(2)}`);
  assert(ru.confidence > 50, `strong aligned uptrend should be confident, got ${ru.confidence}`);
  assert(!computeTechnical({ '1d': [], '4h': [], '1h': [], '15m': [] } as any).available, 'empty candles → unavailable');

  console.log('technical.ts demo OK —',
    `up bias=${ru.bias.toFixed(2)} ${ru.label} conf=${ru.confidence},`,
    `down bias=${rd.bias.toFixed(2)} ${rd.label}`);
}

if (typeof require !== 'undefined' && require.main === module) demo();
