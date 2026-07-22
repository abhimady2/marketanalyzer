// Scalp Console — calibrated for the $1 / 100-point continuous manual-scalp strategy.
// The FAST micro-trend (M1 + M5, from the MT5 broker feed) is the trigger; the
// higher timeframes + macro are only a "don't fight the tide" filter; high-impact
// events, chop (M1/M5 disagree) and a wide spread force STAND-ASIDE. Mode: Balanced
// — take when M1+M5 align and H1 isn't strongly opposed; wait near events / in chop.
//
// This is a permission/direction signal refreshed every ~10-20s, NOT a tick execution
// algo: $1 on gold is near the spread/noise floor, so it tilts odds, not certainty.

import type { Candle } from '@/lib/data/candles';
import { ema, type TechnicalResult } from './technical';
import type { LevelsResult } from './levels';

export type ScalpState = 'TAKE_LONG' | 'TAKE_SHORT' | 'WAIT';

export interface ScalpSignal {
  state: ScalpState;
  reason: string;
  microDir: 'up' | 'down' | 'mixed';
  m1: 'up' | 'down' | 'flat';
  m5: 'up' | 'down' | 'flat';
  higherBias: 'up' | 'down' | 'neutral';
  spreadPoints: number | null;   // (ask-bid) in points; 100 points = $1
  tpPoints: number;              // target: 100 points ($1)
  tpRealistic: boolean;
  minsToEvent: number | null;
  nextEvent: string | null;
  flipLevel: number | null;      // micro-trend invalidation price (M5 EMA21)
  flipped: boolean;              // direction changed vs the previous signal
  confidence: number;            // 0..100
  roomPoints: number | null;     // clear air to the level in the signalled direction
  wall: { price: number; kind: string; holdPct: number } | null; // the level in the way
  levelWarning: string | null;   // set when price is sitting on a key zone
  available: boolean;
}

// The target the auto-dispatcher actually trades. signals.ts imports THIS rather than
// declaring its own, because it previously declared 200 while the room filter below still
// screened for 100 — so setups with 100-199pt of room were dispatched into a wall they
// could never clear before TP. One constant, one target, no drift.
export const DISPATCH_TP_POINTS = 200;   // $2.00 on XAUUSD (0.01 = 1 point)
const TP_POINTS = 100;          // $1.00 — the MANUAL scalp target shown on the console
const EVENT_BLOCK_MIN = 15;     // Balanced: stand aside within 15 min of a high-impact event
const SPREAD_MAX_POINTS = 40;   // >20% of the 200-pt target = too costly
// A micro-trend has to actually BE a trend: the EMA9/21 spread must be at least this
// fraction of ATR. Without it a flat M1/M5 (spread ~5% of ATR = noise) still cleared the
// >75 confidence gate whenever the H1 tide bonus applied, dispatching coin-flips.
const MIN_ALIGN_STRENGTH = 0.15;

function atr(c: Candle[], p = 14): number | null {
  if (c.length < p + 1) return null;
  let s = 0;
  for (let i = c.length - p; i < c.length; i++) {
    s += Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c));
  }
  return s / p;
}

function micro(c: Candle[]): { dir: -1 | 0 | 1; strength: number; ema21: number | null } {
  const closes = c.map((x) => x.c);
  if (closes.length < 25) return { dir: 0, strength: 0, ema21: null };
  const e9 = ema(closes, 9)!, e21 = ema(closes, 21)!, a = atr(c, 14) || 1;
  const price = closes[closes.length - 1];
  const trendUp = e9 > e21, aboveE9 = price > e9;
  const dir: -1 | 0 | 1 = trendUp && aboveE9 ? 1 : !trendUp && !aboveE9 ? -1 : 0;
  return { dir, strength: Math.min(1, Math.abs(e9 - e21) / a), ema21: e21 };
}

const stateDir = (s: ScalpState) => s === 'TAKE_LONG' ? 'long' : s === 'TAKE_SHORT' ? 'short' : 'wait';

// The levels engine needs the micro/higher context, and the scalp engine needs the
// levels — so this exposes the context without a circular import.
export function microContext(
  m1: Candle[], m5: Candle[], technical: TechnicalResult, goldMacroBias: number | null,
): { microDir: 'up' | 'down' | 'mixed'; higherBias: 'up' | 'down' | 'neutral' } {
  const a = micro(m1), b = micro(m5);
  const align = a.dir !== 0 && a.dir === b.dir;
  const microDir = align ? (a.dir > 0 ? 'up' : 'down') : 'mixed';
  const h1 = technical.timeframes.find((t) => t.tf === '1h');
  const h1Dir = h1?.available ? Math.sign(h1.score) : 0;
  const macroDir = goldMacroBias != null ? Math.sign(goldMacroBias) : 0;
  const higherBias: 'up' | 'down' | 'neutral' = h1Dir > 0 || (h1Dir === 0 && macroDir > 0) ? 'up'
    : h1Dir < 0 || (h1Dir === 0 && macroDir < 0) ? 'down' : 'neutral';
  return { microDir, higherBias };
}

export interface ScalpArgs {
  m1: Candle[]; m5: Candle[];
  technical: TechnicalResult;
  goldMacroBias: number | null;
  bid: number | null; ask: number | null;
  upcomingHighUSD: { title: string; date: string }[];
  levels: LevelsResult | null;
  prevState: ScalpState | null;
  now: number;
}

export function computeScalp(a: ScalpArgs): ScalpSignal {
  const off = (reason: string): ScalpSignal => ({
    state: 'WAIT', reason, microDir: 'mixed', m1: 'flat', m5: 'flat', higherBias: 'neutral',
    spreadPoints: a.ask != null && a.bid != null ? Math.round((a.ask - a.bid) * 100) : null,
    tpPoints: TP_POINTS, tpRealistic: false, minsToEvent: null, nextEvent: null,
    flipLevel: null, flipped: false, confidence: 0,
    roomPoints: null, wall: null, levelWarning: a.levels?.warning ?? null, available: false,
  });

  if (a.m1.length < 25 || a.m5.length < 25) return off('Waiting for M1/M5 candles from the MT5 EA.');

  const m1 = micro(a.m1), m5 = micro(a.m5);
  const dirWord = (d: number) => d > 0 ? 'up' : d < 0 ? 'down' : 'flat';
  const align = m1.dir !== 0 && m1.dir === m5.dir;
  const microDir: ScalpSignal['microDir'] = align ? (m1.dir > 0 ? 'up' : 'down') : 'mixed';

  // Higher-TF filter: the H1 trend (blended with macro) as the tide.
  const h1 = a.technical.timeframes.find((t) => t.tf === '1h');
  const h1Dir = h1?.available ? Math.sign(h1.score) : 0;
  const macroDir = a.goldMacroBias != null ? Math.sign(a.goldMacroBias) : 0;
  const higherBias: ScalpSignal['higherBias'] = h1Dir > 0 || (h1Dir === 0 && macroDir > 0) ? 'up'
    : h1Dir < 0 || (h1Dir === 0 && macroDir < 0) ? 'down' : 'neutral';
  const strongHigher = !!h1?.available && Math.abs(h1.score) > 0.4 && (h1.strength ?? 0) > 22;
  const opposed = align && strongHigher && Math.sign(h1!.score) === -m1.dir;

  // Spread + events.
  const spreadPoints = a.ask != null && a.bid != null ? Math.round((a.ask - a.bid) * 100) : null;
  const spreadWide = spreadPoints != null && spreadPoints > SPREAD_MAX_POINTS;
  let minsToEvent: number | null = null; let nextEvent: string | null = null;
  for (const e of a.upcomingHighUSD) {
    const mins = (+new Date(e.date) - a.now) / 60000;
    if (mins >= 0 && (minsToEvent == null || mins < minsToEvent)) { minsToEvent = Math.round(mins); nextEvent = e.title; }
  }
  const eventSoon = minsToEvent != null && minsToEvent <= EVENT_BLOCK_MIN;

  // Balanced decision. Structure first: never scalp directionally INTO a wall, and
  // never take a 100-pt target without 100 pt of clear air.
  const atLevel = a.levels?.atLevel ?? null;
  let roomPoints: number | null = null;
  let wall: ScalpSignal['wall'] = null;

  const alignStrength = align ? (m1.strength + m5.strength) / 2 : 0;
  const weakAlign = align && alignStrength < MIN_ALIGN_STRENGTH;

  let state: ScalpState = 'WAIT'; let reason = '';
  if (eventSoon) reason = `${nextEvent} in ${minsToEvent}m — stand aside for the spike.`;
  else if (atLevel) reason = `Price is at ${atLevel.kind} ${atLevel.price.toFixed(2)} (tested ${atLevel.sample}×, ~${atLevel.holdPct}% hold) — it either rejects or breaks. No directional edge here; wait for the reaction.`;
  else if (!align) reason = m1.dir === m5.dir ? 'No micro-trend (M1/M5 flat) — wait.' : 'M1 and M5 disagree — chop, wait for alignment.';
  else if (weakAlign) reason = `M1/M5 both ${microDir} but barely — EMA9/21 spread is only ${Math.round(alignStrength * 100)}% of ATR (need ${Math.round(MIN_ALIGN_STRENGTH * 100)}%). That's drift, not a trend.`;
  else if (opposed) reason = `M1/M5 ${microDir} but H1 strongly ${higherBias === 'up' ? 'bullish' : 'bearish'} — don't scalp against the higher trend.`;
  else if (spreadWide) reason = `Spread ${spreadPoints}pt is wide vs the ${DISPATCH_TP_POINTS}-pt target — wait for it to tighten.`;
  else {
    const dir = m1.dir > 0 ? 1 : -1;
    const w = (dir > 0 ? a.levels?.nearestResistance : a.levels?.nearestSupport) ?? null;
    roomPoints = (dir > 0 ? a.levels?.roomLongPoints : a.levels?.roomShortPoints) ?? null;
    if (w) wall = { price: w.price, kind: w.kind, holdPct: w.holdPct };
    // Room must clear the target we actually TRADE (200pt), not the manual 100pt scalp.
    if (roomPoints != null && w && roomPoints < DISPATCH_TP_POINTS) {
      reason = `Only ${roomPoints}pt to ${w.kind} ${w.price.toFixed(2)} (~${w.holdPct}% hold) — not enough room for a ${DISPATCH_TP_POINTS}pt target.`;
    } else {
      state = dir > 0 ? 'TAKE_LONG' : 'TAKE_SHORT';
      const withTide = strongHigher && Math.sign(h1!.score) === m1.dir;
      reason = `M1+M5 aligned ${microDir}${withTide ? ', with the H1 trend' : ''}. Take $1 scalps ${dir > 0 ? 'long' : 'short'} while it holds`
        + (roomPoints != null && w ? ` — ${roomPoints}pt clear to ${w.kind} ${w.price.toFixed(2)}.` : '.');
    }
  }

  const flipLevel = m5.ema21;
  const prevDir = a.prevState ? stateDir(a.prevState) : null;
  const nowDir = stateDir(state);
  const flipped = !!prevDir && prevDir !== 'wait' && nowDir !== 'wait' && prevDir !== nowDir;

  const tpRealistic = state !== 'WAIT';
  // Confidence: micro alignment strength, boosted when the higher tide agrees, zeroed on WAIT.
  const tideBonus = state !== 'WAIT' && strongHigher && Math.sign(h1!.score) === m1.dir ? 0.2 : 0;
  const confidence = state === 'WAIT' ? 0 : Math.round(Math.min(100, (0.5 + Math.min(0.3, alignStrength) + tideBonus) * 100));

  return {
    state, reason, microDir, m1: dirWord(m1.dir) as any, m5: dirWord(m5.dir) as any, higherBias,
    spreadPoints, tpPoints: TP_POINTS, tpRealistic, minsToEvent, nextEvent,
    flipLevel, flipped, confidence,
    roomPoints, wall, levelWarning: a.levels?.warning ?? null, available: true,
  };
}

// ── self-check (npx tsx src/lib/engine/scalp.ts) ─────────────────────────────
export function demo(): void {
  const assert = (c: boolean, m: string) => { if (!c) throw new Error('FAIL: ' + m); };
  const ramp = (n: number, dir: number, start = 4000, slope = 0.5): Candle[] =>
    Array.from({ length: n }, (_, i) => { const b = start + dir * i * slope; return { t: i, o: b, h: b + 0.3, l: b - 0.3, c: b + dir * 0.2, v: 10 }; });
  const tech = (h1score: number, adx: number): TechnicalResult => ({
    bias: h1score, label: 'Neutral', confidence: 50, available: true,
    timeframes: [{ tf: '1h', score: h1score, label: h1score > 0 ? 'Bullish' : 'Bearish', strength: adx, available: true, signals: [] }] as any,
  });
  const base = { technical: tech(0, 10), goldMacroBias: 0, bid: 4000.0, ask: 4000.2, upcomingHighUSD: [], levels: null, prevState: null, now: 0 };
  const lvl = (over: Partial<import('./levels').LevelsResult>): import('./levels').LevelsResult => ({
    levels: [], nearestSupport: null, nearestResistance: null, atLevel: null, warning: null,
    roomLongPoints: null, roomShortPoints: null, available: true, ...over,
  });
  const zone = (price: number, kind: 'support' | 'resistance') => ({
    price, low: price - 1, high: price + 1, kind, strength: 70, touches: 3, rejections: 3, breaks: 1,
    sample: 4, holdPct: 70, breakPct: 30, reliability: 'medium' as const, distancePoints: 0,
    timeframes: ['1h'], lastTest: null, isRound: false,
  });

  // Aligned up-trend, calm higher-TF → TAKE_LONG.
  const up = computeScalp({ ...base, m1: ramp(40, 1), m5: ramp(40, 1) });
  assert(up.state === 'TAKE_LONG', `aligned up should take long, got ${up.state}`);

  // Aligned down → TAKE_SHORT.
  const dn = computeScalp({ ...base, m1: ramp(40, -1, 4000), m5: ramp(40, -1, 4000) });
  assert(dn.state === 'TAKE_SHORT', `aligned down should take short, got ${dn.state}`);

  // M1 up, M5 down → chop → WAIT.
  const chop = computeScalp({ ...base, m1: ramp(40, 1), m5: ramp(40, -1, 4000) });
  assert(chop.state === 'WAIT' && chop.microDir === 'mixed', 'disagreement should WAIT');

  // Aligned up but H1 strongly bearish → opposed → WAIT.
  const opp = computeScalp({ ...base, technical: tech(-0.6, 30), m1: ramp(40, 1), m5: ramp(40, 1) });
  assert(opp.state === 'WAIT', `counter-trend should WAIT, got ${opp.state}`);

  // Event in 5 min → WAIT.
  const ev = computeScalp({ ...base, m1: ramp(40, 1), m5: ramp(40, 1), upcomingHighUSD: [{ title: 'CPI', date: new Date(5 * 60000).toISOString() }] });
  assert(ev.state === 'WAIT' && /CPI/.test(ev.reason), 'imminent event should WAIT');

  // Wide spread → WAIT.
  const sp = computeScalp({ ...base, m1: ramp(40, 1), m5: ramp(40, 1), bid: 4000.0, ask: 4000.6 });
  assert(sp.state === 'WAIT' && /Spread/.test(sp.reason), 'wide spread should WAIT');

  // Flip detection: prev long, now short.
  const flip = computeScalp({ ...base, m1: ramp(40, -1, 4000), m5: ramp(40, -1, 4000), prevState: 'TAKE_LONG' });
  assert(flip.state === 'TAKE_SHORT' && flip.flipped, 'long→short should flag flipped');

  // Price sitting ON a key zone → directional edge gone → WAIT.
  const onLvl = computeScalp({ ...base, m1: ramp(40, 1), m5: ramp(40, 1), levels: lvl({ atLevel: zone(4010, 'resistance'), warning: 'at zone' }) });
  assert(onLvl.state === 'WAIT' && /rejects or breaks/.test(onLvl.reason), 'at a key zone should WAIT');

  // Wall too close for a 100-pt target → WAIT.
  const tight = computeScalp({ ...base, m1: ramp(40, 1), m5: ramp(40, 1), levels: lvl({ nearestResistance: zone(4010, 'resistance'), roomLongPoints: 40 }) });
  assert(tight.state === 'WAIT' && /not enough room/.test(tight.reason), `tight room should WAIT, got ${tight.state}`);

  // Plenty of clear air → takes, and reports the room.
  const roomy = computeScalp({ ...base, m1: ramp(40, 1), m5: ramp(40, 1), levels: lvl({ nearestResistance: zone(4030, 'resistance'), roomLongPoints: 300 }) });
  assert(roomy.state === 'TAKE_LONG' && roomy.roomPoints === 300, `roomy should take long, got ${roomy.state}`);

  // REGRESSION: 150pt of room used to pass (>= the old 100pt screen) and was then traded
  // with a 200pt target — a wall inside the TP. Must WAIT now.
  const wall150 = computeScalp({ ...base, m1: ramp(40, 1), m5: ramp(40, 1), levels: lvl({ nearestResistance: zone(4015, 'resistance'), roomLongPoints: 150 }) });
  assert(wall150.state === 'WAIT', `150pt room < ${DISPATCH_TP_POINTS}pt target must WAIT, got ${wall150.state}`);

  // REGRESSION: an aligned-but-flat micro-trend (EMA9/21 spread ~10% of ATR) used to clear
  // the >75 gate on the H1 tide bonus alone. That is noise, not a trend — must WAIT.
  const drift = computeScalp({ ...base, technical: tech(0.6, 30), goldMacroBias: 1, m1: ramp(60, 1, 4000, 0.01), m5: ramp(60, 1, 4000, 0.01) });
  assert(drift.state === 'WAIT' && /drift, not a trend/.test(drift.reason), `flat drift must WAIT, got ${drift.state} (${drift.reason})`);
  // ...while a genuinely strong trend with the tide behind it still fires, and scores high.
  assert(up.confidence > 75, `real trend must clear the dispatch gate, got ${up.confidence}`);

  console.log('scalp.ts demo OK —', `up=${up.state}(${up.confidence}), dn=${dn.state}, chop=${chop.state}, opp=${opp.state}, ev=${ev.state},`,
    `flip=${flip.flipped}, atLevel=${onLvl.state}, tightRoom=${tight.state}, roomy=${roomy.state}/${roomy.roomPoints}pt,`,
    `wall150=${wall150.state}, drift=${drift.state}`);
}

if (typeof require !== 'undefined' && require.main === module) demo();
