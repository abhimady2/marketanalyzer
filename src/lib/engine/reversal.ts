// Reversal Entry Zones — a 2.8×ATR confirmed-swing engine ported 1:1 from the Pine indicator
// and from the Python backtest that validated it. On GOLD H1 this is the first gold signal to
// beat random entries 100% of trials, hold out-of-sample (PF ~1.18–1.26), survive removing its
// top-5 trades (PF 1.12 broad-based), and make money in a DOWN year via shorts — i.e. a real
// trend-following edge, not a bull-market artifact. It replaces the M1/M5 scalp auto-dispatch,
// which measured as a coin flip (win rate ≈ the 33% random baseline, z=-0.27).
//
// It is NOT a fade: "BULLISH REVERSAL" confirms only AFTER price has already risen 2.8×ATR off a
// swing low, so the trade is *with* the newly-confirmed swing. The trigger is monotonic (once
// price has moved 2.8×ATR it stays moved), so evaluating on the live forming bar can bring the
// entry forward by up to an hour without repainting the decision.
//
// Timeframe matters: on H1 the 2.8×ATR(5) threshold is a real ~$8–12 swing; on M15 it's a
// ~$2–4 wiggle back in the noise floor (every M15 variant tested was a lottery). Run on H1.

import type { Candle } from '@/lib/data/candles';

// 'Low' preset from the indicator. presetATR dominates the threshold on gold; the pct and
// absolute floors only matter on tiny-priced or ultra-quiet instruments.
const PRESET_ATR = 2.8;
const PRESET_PCT = 0.015;
const CUSTOM_ABS = 0.05;
const AVG_LEN = 5;
const ATR_LEN = 5;
const FRESH_BARS = 1; // only emit a reversal confirmed on the current or just-closed bar

export interface ReversalSignal {
  dir: 'LONG' | 'SHORT' | null;
  pivotPrice: number | null; // the confirmed swing extreme
  atr: number;               // ATR(5) at the confirmation bar → sizes the 3×ATR stop
  fresh: boolean;            // confirmed within FRESH_BARS of the latest bar (not stale)
  key: string | null;        // dedupe signature: emit once per confirmed reversal
}

function emaSeries(v: number[], n: number): number[] {
  const k = 2 / (n + 1);
  const out: number[] = [];
  let e = v.length ? v[0] : 0;
  for (const x of v) { e = x * k + e * (1 - k); out.push(e); }
  return out;
}

function atrSeries(c: Candle[], n: number): number[] {
  const out: number[] = new Array(c.length).fill(0);
  const trs: number[] = [];
  for (let i = 0; i < c.length; i++) {
    const tr = i === 0 ? c[i].h - c[i].l
      : Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c));
    trs.push(tr);
    const from = Math.max(0, i - n + 1);
    let s = 0; for (let j = from; j <= i; j++) s += trs[j];
    out[i] = s / Math.min(i + 1, n);
  }
  return out;
}

// The confirmed-pivot swing engine. Returns the MOST RECENT confirmed reversal over the series.
export function computeReversal(h1: Candle[]): ReversalSignal {
  const none: ReversalSignal = { dir: null, pivotPrice: null, atr: 0, fresh: false, key: null };
  if (h1.length < 30) return none;

  const a = atrSeries(h1, ATR_LEN);
  const hi = emaSeries(h1.map((x) => x.h), AVG_LEN);
  const lo = emaSeries(h1.map((x) => x.l), AVG_LEN);

  let runHigh = hi[0], runLow = lo[0], swingDir = 1;
  let lastDir: 1 | -1 | 0 = 0, lastPivot = NaN, lastBar = -1, lastAtr = 0;

  for (let i = 1; i < h1.length; i++) {
    const thr = Math.max(h1[i].c * PRESET_PCT / 100, Math.max(CUSTOM_ABS, PRESET_ATR * a[i]));
    if (swingDir === 1) {
      if (hi[i] > runHigh) runHigh = hi[i];
      if (runHigh - lo[i] >= thr) {           // fell 2.8×ATR off the swing high → SHORT
        lastDir = -1; lastPivot = runHigh; lastBar = i; lastAtr = a[i];
        swingDir = -1; runLow = lo[i];
      }
    } else {
      if (lo[i] < runLow) runLow = lo[i];
      if (hi[i] - runLow >= thr) {            // rose 2.8×ATR off the swing low → LONG
        lastDir = 1; lastPivot = runLow; lastBar = i; lastAtr = a[i];
        swingDir = 1; runHigh = hi[i];
      }
    }
  }

  if (lastDir === 0) return none;
  const dir = lastDir === 1 ? 'LONG' : 'SHORT';
  return {
    dir,
    pivotPrice: lastPivot,
    atr: lastAtr,
    fresh: (h1.length - 1 - lastBar) <= FRESH_BARS,
    key: `${dir}@${lastPivot.toFixed(2)}`,
  };
}

// ── self-check (npx tsx src/lib/engine/reversal.ts) ──────────────────────────
export function demo(): void {
  const assert = (c: boolean, m: string) => { if (!c) throw new Error('FAIL: ' + m); };
  const bar = (p: number): Candle => ({ t: 0, o: p, h: p + 0.5, l: p - 0.5, c: p, v: 1 });
  // Base at 2000, ATR≈1 → threshold≈2.8. Ramp down 40 bars (establish a swing low), then ramp
  // up hard: once price rises 2.8 off the low, a LONG reversal must confirm on a recent bar.
  const down = Array.from({ length: 40 }, (_, i) => bar(2000 - i * 1.5));
  const up = Array.from({ length: 20 }, (_, i) => bar(2000 - 39 * 1.5 + (i + 1) * 3));
  const series = [...down, ...up];
  const r = computeReversal(series);
  assert(r.dir === 'LONG', `up-thrust off a low must confirm LONG, got ${r.dir}`);
  assert(r.atr > 0 && r.pivotPrice !== null, 'must carry ATR + pivot for sizing');
  // A long up-leg buries the confirmation mid-thrust → the tail is NOT fresh (correct: the
  // engine confirms ONCE, early). This is the stale case the live fresh-gate must reject.
  assert(!r.fresh, 'a reversal buried mid-thrust must be stale at the tail');

  // Freshness, robust to EMA timing: the shortest prefix that first shows LONG ends exactly at
  // the confirmation bar — evaluated there, it MUST be fresh (this is the live every-8s path).
  let k = 30;
  while (k < series.length && computeReversal(series.slice(0, k)).dir !== 'LONG') k++;
  assert(computeReversal(series.slice(0, k)).fresh, 'series ending at the confirmation bar must be fresh');

  // Mirror: ramp up then thrust down → SHORT.
  const s = computeReversal([
    ...Array.from({ length: 40 }, (_, i) => bar(2000 + i * 1.5)),
    ...Array.from({ length: 20 }, (_, i) => bar(2000 + 39 * 1.5 - (i + 1) * 3)),
  ]);
  assert(s.dir === 'SHORT', `down-thrust off a high must confirm SHORT, got ${s.dir}`);

  // Dedup key is stable for the same pivot, distinct across direction.
  assert(r.key === computeReversal(series).key, 'same series → same key');
  assert(r.key !== s.key, 'long and short keys must differ');

  console.log('reversal.ts demo OK —', `long=${r.dir}(${r.key}), short=${s.dir}(${s.key}), tailFresh=${r.fresh}`);
}

declare const require: any, module: any;
if (typeof require !== 'undefined' && require.main === module) demo();
