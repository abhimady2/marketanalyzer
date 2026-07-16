// Support/Resistance — built the way a discretionary trader actually reads structure:
//   1. Swing pivots (fractals) on M15/H1/H4/D1 — the raw structural turns.
//   2. Cluster nearby pivots into ZONES (a level is a band, never a line), weighted
//      by timeframe (a D1 turn outranks an M15 turn).
//   3. Walk real history and classify each test as a REJECTION or a BREAK.
//   4. Estimate hold/break from that base rate (Laplace-smoothed so a 1-test level
//      can't claim 100%), adjusted for touch-wear, approach momentum and trend.
//      Sample size + reliability are always reported — no oracle numbers.
//   5. Flag when price is AT a zone → directional edge is gone (reject-or-break).
//
// Honesty: with n=1..6 tests these are weak base rates, not guarantees. Reliability
// is surfaced so a 2-test "70%" is never read as a 200-test "70%".

import type { Candle } from '@/lib/data/candles';

export interface Level {
  price: number;            // zone centre
  low: number; high: number; // zone bounds
  kind: 'support' | 'resistance';
  strength: number;         // 0..100 structural significance
  touches: number;          // pivots that formed the zone
  rejections: number;       // historical tests that held
  breaks: number;           // historical tests that broke through
  sample: number;           // rejections + breaks
  holdPct: number;
  breakPct: number;
  reliability: 'low' | 'medium' | 'high';
  distancePoints: number;   // signed distance from price, in points (100 = $1)
  timeframes: string[];
  lastTest: number | null;
  isRound: boolean;
}

export interface LevelsResult {
  levels: Level[];                 // nearest-first
  nearestSupport: Level | null;
  nearestResistance: Level | null;
  atLevel: Level | null;           // price inside / hugging a zone
  warning: string | null;          // "no directional trades here"
  roomLongPoints: number | null;   // clear air up to nearest resistance
  roomShortPoints: number | null;  // clear air down to nearest support
  available: boolean;
}

const PT = 100;                   // 1.00 price = 100 points
const NEAR_POINTS = 25;           // within 25pt of a zone edge counts as "at" it
const TF_W: Record<string, number> = { '15m': 1, '1h': 1.6, '4h': 2.4, '1d': 3.2 };

function atr(c: Candle[], p = 14): number | null {
  if (c.length < p + 1) return null;
  let s = 0;
  for (let i = c.length - p; i < c.length; i++) s += Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c));
  return s / p;
}

interface Pivot { price: number; t: number; kind: 'high' | 'low'; w: number; tf: string; }

// Fractal swing: strictly the extreme of the k bars either side (k bars of confirmation).
function findPivots(c: Candle[], tf: string, k = 2): Pivot[] {
  const out: Pivot[] = [];
  const w = TF_W[tf] ?? 1;
  for (let i = k; i < c.length - k; i++) {
    let hi = true, lo = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (c[j].h >= c[i].h) hi = false;
      if (c[j].l <= c[i].l) lo = false;
    }
    if (hi) out.push({ price: c[i].h, t: c[i].t, kind: 'high', w, tf });
    if (lo) out.push({ price: c[i].l, t: c[i].t, kind: 'low', w, tf });
  }
  return out;
}

// Walk history: a test = consecutive bars intersecting the zone. Outcome decided by
// the first decisive close after the test (beyond the far edge = break, back to the
// approach side = rejection).
function scanTests(zLow: number, zHigh: number, c: Candle[]): { rejections: number; breaks: number; lastTest: number | null } {
  let rejections = 0, breaks = 0, lastTest: number | null = null;
  const margin = Math.max((zHigh - zLow) * 0.5, 0.01);
  let i = 0;
  while (i < c.length) {
    if (!(c[i].h >= zLow && c[i].l <= zHigh)) { i++; continue; }
    let side = 0; // +1 approached from above, -1 from below
    for (let j = i - 1; j >= 0; j--) { if (c[j].c > zHigh) { side = 1; break; } if (c[j].c < zLow) { side = -1; break; } }
    let j = i;
    while (j < c.length && c[j].h >= zLow && c[j].l <= zHigh) j++;
    let outcome: 'reject' | 'break' | null = null;
    for (let m = j; m < Math.min(j + 6, c.length); m++) {
      if (side === 1) { if (c[m].c < zLow - margin) { outcome = 'break'; break; } if (c[m].c > zHigh) { outcome = 'reject'; break; } }
      if (side === -1) { if (c[m].c > zHigh + margin) { outcome = 'break'; break; } if (c[m].c < zLow) { outcome = 'reject'; break; } }
    }
    if (side !== 0 && outcome) { outcome === 'break' ? breaks++ : rejections++; lastTest = c[Math.max(i, j - 1)].t; }
    i = Math.max(j, i + 1);
  }
  return { rejections, breaks, lastTest };
}

const isRoundPrice = (p: number, tol: number) => {
  const d10 = Math.abs(p - Math.round(p / 10) * 10);
  return d10 <= Math.max(tol * 0.6, 0.5);
};

export interface LevelsArgs {
  m15: Candle[]; h1: Candle[]; h4: Candle[]; d1: Candle[];
  price: number;
  microDir: 'up' | 'down' | 'mixed';   // current M1/M5 push
  higherBias: 'up' | 'down' | 'neutral';
}

export function computeLevels(a: LevelsArgs): LevelsResult {
  const off: LevelsResult = { levels: [], nearestSupport: null, nearestResistance: null, atLevel: null, warning: null, roomLongPoints: null, roomShortPoints: null, available: false };
  if (!a.h1.length || !a.price) return off;

  const atrH1 = atr(a.h1, 14) || 2;
  const tol = Math.max(0.5, Math.min(3, atrH1 * 0.25));   // zone half-width, $
  const window = Math.max(15, atrH1 * 8);                  // only levels near price matter

  const pivots = [
    ...findPivots(a.m15, '15m', 2), ...findPivots(a.h1, '1h', 2),
    ...findPivots(a.h4, '4h', 2), ...findPivots(a.d1, '1d', 2),
  ].filter((p) => Math.abs(p.price - a.price) <= window).sort((x, y) => x.price - y.price);
  if (!pivots.length) return off;

  // Cluster adjacent pivots into zones.
  const clusters: Pivot[][] = [];
  let cur: Pivot[] = [pivots[0]];
  for (let i = 1; i < pivots.length; i++) {
    if (pivots[i].price - cur[cur.length - 1].price <= tol) cur.push(pivots[i]);
    else { clusters.push(cur); cur = [pivots[i]]; }
  }
  clusters.push(cur);

  // History scan: H1 for the recent window, H4 for anything older (best resolution available).
  const h1Start = a.h1[0]?.t ?? 0;
  const h4Old = a.h4.filter((c) => c.t < h1Start);
  const now = Date.now();

  const levels: Level[] = clusters.map((cl) => {
    const wSum = cl.reduce((s, p) => s + p.w, 0);
    const centre = cl.reduce((s, p) => s + p.price * p.w, 0) / wSum;
    const low = centre - tol, high = centre + tol;
    const tRecent = scanTests(low, high, a.h1);
    const tOld = h4Old.length > 20 ? scanTests(low, high, h4Old) : { rejections: 0, breaks: 0, lastTest: null };
    const rejections = tRecent.rejections + tOld.rejections;
    const breaks = tRecent.breaks + tOld.breaks;
    const sample = rejections + breaks;
    const lastTest = tRecent.lastTest ?? tOld.lastTest;
    const tfs = [...new Set(cl.map((p) => p.tf))];
    const round = isRoundPrice(centre, tol);

    // Strength: timeframe-weighted pivot mass + touch count + recency + round-number pull.
    const newest = Math.max(...cl.map((p) => p.t));
    const ageDays = Math.max(0, (now - newest) / 864e5);
    const recency = Math.max(0, 20 - ageDays * 0.6);
    const strength = Math.round(Math.max(0, Math.min(100,
      Math.min(40, wSum * 7) + Math.min(25, cl.length * 5) + recency + (round ? 10 : 0) + Math.min(10, sample * 2))));

    // Break estimate: smoothed base rate, worn down by repeat tests, pushed by momentum/trend.
    const kind: Level['kind'] = centre >= a.price ? 'resistance' : 'support';
    const intoIt = (kind === 'resistance' && a.microDir === 'up') || (kind === 'support' && a.microDir === 'down');
    const withTrend = (kind === 'resistance' && a.higherBias === 'up') || (kind === 'support' && a.higherBias === 'down');
    let pBreak = (breaks + 1) / (sample + 2);
    pBreak += 0.02 * Math.min(cl.length, 6);
    if (intoIt) pBreak += 0.10;
    if (withTrend) pBreak += 0.08;
    pBreak -= 0.06 * (strength / 100);
    pBreak = Math.max(0.05, Math.min(0.95, pBreak));

    const breakPct = Math.round(pBreak * 100);
    const reliability: Level['reliability'] = sample >= 5 ? 'high' : sample >= 2 ? 'medium' : 'low';

    return {
      price: centre, low, high, kind, strength, touches: cl.length,
      rejections, breaks, sample, holdPct: 100 - breakPct, breakPct, reliability,
      distancePoints: Math.round((centre - a.price) * PT),
      timeframes: tfs, lastTest, isRound: round,
    };
  })
    // Keep meaningful structure only.
    .filter((l) => l.strength >= 25)
    .sort((x, y) => Math.abs(x.distancePoints) - Math.abs(y.distancePoints));

  const resistances = levels.filter((l) => l.kind === 'resistance').sort((x, y) => x.distancePoints - y.distancePoints);
  const supports = levels.filter((l) => l.kind === 'support').sort((x, y) => y.distancePoints - x.distancePoints);
  const nearestResistance = resistances[0] ?? null;
  const nearestSupport = supports[0] ?? null;

  // At a zone? (inside it, or hugging within NEAR_POINTS of an edge)
  const atLevel = levels.find((l) =>
    a.price >= l.low - NEAR_POINTS / PT && a.price <= l.high + NEAR_POINTS / PT && l.strength >= 45) ?? null;

  const warning = atLevel
    ? `Price is at ${atLevel.kind} ${atLevel.price.toFixed(2)} (strength ${atLevel.strength}, tested ${atLevel.sample}×). Directional edge is gone here — it either rejects or breaks. Wait for the reaction.`
    : null;

  return {
    levels: levels.slice(0, 8),
    nearestSupport, nearestResistance, atLevel, warning,
    roomLongPoints: nearestResistance ? Math.abs(nearestResistance.distancePoints) : null,
    roomShortPoints: nearestSupport ? Math.abs(nearestSupport.distancePoints) : null,
    available: true,
  };
}

// ── self-check (npx tsx src/lib/engine/levels.ts) ────────────────────────────
export function demo(): void {
  const assert = (c: boolean, m: string) => { if (!c) throw new Error('FAIL: ' + m); };
  // Build a series that repeatedly rejects 4030 (resistance) and holds 4000 (support).
  const c: Candle[] = [];
  let t = 0;
  const bar = (o: number, h: number, l: number, cl: number) => c.push({ t: t += 3600e3, o, h, l, c: cl, v: 100 });
  for (let cycle = 0; cycle < 4; cycle++) {
    bar(4005, 4012, 4003, 4010); bar(4010, 4022, 4008, 4020);
    bar(4020, 4030.5, 4018, 4028);      // tags 4030 zone
    bar(4028, 4029, 4014, 4016);        // rejected back down
    bar(4016, 4018, 4004, 4006);
    bar(4006, 4008, 3999.5, 4002);      // tags 4000 zone
    bar(4002, 4014, 4001, 4012);        // held, back up
  }
  const r = computeLevels({ m15: c, h1: c, h4: c, d1: c, price: 4016, microDir: 'mixed', higherBias: 'neutral' });
  assert(r.available, 'levels should compute');
  assert(r.levels.length > 0, 'should find zones');
  assert(!!r.nearestResistance && r.nearestResistance.price > 4016, 'resistance must sit above price');
  assert(!!r.nearestSupport && r.nearestSupport.price < 4016, 'support must sit below price');
  const res = r.nearestResistance!;
  assert(res.rejections > 0, `repeated rejections should be counted, got r=${res.rejections} b=${res.breaks}`);
  assert(res.holdPct + res.breakPct === 100, 'hold+break must total 100');
  assert(res.sample >= 1 && ['low', 'medium', 'high'].includes(res.reliability), 'sample/reliability reported');

  // Price parked on a strong zone → warning fires.
  const at = computeLevels({ m15: c, h1: c, h4: c, d1: c, price: res.price, microDir: 'up', higherBias: 'up' });
  assert(!!at.atLevel && !!at.warning, 'standing on a zone should warn');

  console.log('levels.ts demo OK —',
    `zones=${r.levels.length}, R=${res.price.toFixed(2)} hold ${res.holdPct}%/break ${res.breakPct}% (n=${res.sample}, ${res.reliability}),`,
    `S=${r.nearestSupport!.price.toFixed(2)}, roomLong=${r.roomLongPoints}pt`);
}

if (typeof require !== 'undefined' && require.main === module) demo();
