// Trade-signal dispatch → the Trading Intelligence paper-trader.
//
// Fires ONLY when the scalp console turns actionable: state TAKE_LONG/TAKE_SHORT with
// confidence > 75. Emitted ONCE PER EPISODE (on the transition into a qualifying
// state, or when confidence crosses the bar) — the analyzer recomputes every ~8s, so
// emitting on every poll would spam ~450 duplicate signals an hour.
//
// Exits are FIXED per the strategy: TP 200 points ($2.00), SL 100 points ($1.00) → 2:1 R.
// Entry uses the side you'd actually be filled at (ask for long, bid for short), so the
// spread is paid honestly rather than assumed away.
//
// Stored as a rolling list in ma_cache (no DDL needed); consumers poll /api/signals.

import { getSupabase } from '@/lib/supabase';
import { DISPATCH_TP_POINTS, type ScalpSignal } from './scalp';
import type { LevelsResult } from './levels';

const KEY = 'signals:recent';
const MAX_KEEP = 50;
export const MIN_CONFIDENCE = 75;
// Imported, NOT redeclared: this used to be a local 200 while scalp.ts screened for only
// 100pt of clear air, so setups with a wall 100-199pt away were dispatched into a target
// they could not reach. One constant now feeds both the filter and the trade.
export const TP_POINTS = DISPATCH_TP_POINTS;   // $2.00
export const SL_POINTS = 100;   // $1.00
const PT = 0.01;                // 1 point = $0.01 on XAUUSD

export interface TradeSignal {
  id: string;
  at: number;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  entry: number; tp: number; sl: number;
  tpPoints: number; slPoints: number;
  confidence: number;
  reason: string;
  spreadPoints: number | null;
  context: {
    m1: string; m5: string; higherBias: string;
    flipLevel: number | null;
    nearestResistance: number | null;
    nearestSupport: number | null;
    roomPoints: number | null;
  };
}

export function qualifies(s: ScalpSignal | null | undefined): boolean {
  return !!s && (s.state === 'TAKE_LONG' || s.state === 'TAKE_SHORT') && s.confidence > MIN_CONFIDENCE;
}

/** True only when the signal BECOMES actionable (new episode), not while it persists. */
export function shouldEmit(cur: ScalpSignal | null | undefined, prev: ScalpSignal | null | undefined): boolean {
  if (!qualifies(cur)) return false;
  const alreadyLive = !!prev && prev.state === cur!.state && qualifies(prev);
  return !alreadyLive;
}

export async function readSignals(sinceMs = 0, limit = 50): Promise<TradeSignal[]> {
  try {
    const { data } = await getSupabase().from('ma_cache').select('payload').eq('key', KEY).maybeSingle();
    const items: TradeSignal[] = ((data?.payload as any)?.items as TradeSignal[]) ?? [];
    return items.filter((s) => s.at > sinceMs).sort((a, b) => a.at - b.at).slice(-limit);
  } catch { return []; }
}

/** Pure: build the signal (entry/TP/SL) without touching the DB. */
export function buildSignal(
  scalp: ScalpSignal, bid: number | null, ask: number | null, price: number, levels: LevelsResult | null,
): TradeSignal | null {
  const long = scalp.state === 'TAKE_LONG';
  const entry = (long ? ask : bid) ?? price;   // fill side: pay the spread
  if (!entry || !Number.isFinite(entry) || entry <= 0) return null;

  const tpD = TP_POINTS * PT, slD = SL_POINTS * PT;
  const sig: TradeSignal = {
    id: `${Date.now()}-${long ? 'L' : 'S'}`,
    at: Date.now(),
    symbol: 'XAUUSD',
    direction: long ? 'LONG' : 'SHORT',
    entry,
    tp: long ? entry + tpD : entry - tpD,
    sl: long ? entry - slD : entry + slD,
    tpPoints: TP_POINTS, slPoints: SL_POINTS,
    confidence: scalp.confidence,
    reason: scalp.reason,
    spreadPoints: scalp.spreadPoints,
    context: {
      m1: scalp.m1, m5: scalp.m5, higherBias: scalp.higherBias,
      flipLevel: scalp.flipLevel,
      nearestResistance: levels?.nearestResistance?.price ?? null,
      nearestSupport: levels?.nearestSupport?.price ?? null,
      roomPoints: scalp.roomPoints,
    },
  };
  return sig;
}

export async function emitSignal(
  scalp: ScalpSignal, bid: number | null, ask: number | null, price: number, levels: LevelsResult | null,
): Promise<TradeSignal | null> {
  const sig = buildSignal(scalp, bid, ask, price, levels);
  if (!sig) return null;
  try {
    const sb = getSupabase();
    const { data } = await sb.from('ma_cache').select('payload').eq('key', KEY).maybeSingle();
    const items: TradeSignal[] = ((data?.payload as any)?.items as TradeSignal[]) ?? [];
    items.push(sig);
    await sb.from('ma_cache').upsert(
      { key: KEY, payload: { items: items.slice(-MAX_KEEP) }, updated_at: new Date().toISOString() },
      { onConflict: 'key' },
    );
  } catch { return null; }
  return sig;
}

// ── self-check (npx tsx src/lib/engine/signals.ts) ───────────────────────────
export function demo(): void {
  const assert = (c: boolean, m: string) => { if (!c) throw new Error('FAIL: ' + m); };
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  const sc = (state: string, confidence: number): any => ({
    state, confidence, reason: 'x', m1: 'up', m5: 'up', higherBias: 'up',
    spreadPoints: 28, flipLevel: 4000, roomPoints: 300,
  });

  // Gate: only TAKE_* above 75.
  assert(!qualifies(sc('WAIT', 99)), 'WAIT never qualifies');
  assert(!qualifies(sc('TAKE_LONG', 75)), '75 is not > 75');
  assert(qualifies(sc('TAKE_LONG', 76)), '76 qualifies');

  // Dedupe: fire on entry to the episode, stay silent while it persists.
  assert(shouldEmit(sc('TAKE_LONG', 80), sc('WAIT', 0)), 'WAIT→TAKE_LONG should emit');
  assert(!shouldEmit(sc('TAKE_LONG', 80), sc('TAKE_LONG', 80)), 'persisting episode must NOT re-emit');
  assert(shouldEmit(sc('TAKE_SHORT', 80), sc('TAKE_LONG', 80)), 'flip should emit');
  assert(shouldEmit(sc('TAKE_LONG', 80), sc('TAKE_LONG', 70)), 'confidence crossing 75 should emit');
  assert(!shouldEmit(sc('TAKE_LONG', 70), sc('WAIT', 0)), 'below the bar must not emit');

  // Exit math: LONG fills at ASK, TP +$2.00 (200pt), SL -$1.00 (100pt).
  const L = buildSignal(sc('TAKE_LONG', 80), 4020.00, 4020.28, 4020.14, null)!;
  assert(near(L.entry, 4020.28), `long enters at ask, got ${L.entry}`);
  assert(near(L.tp, 4022.28), `long TP = entry+2.00, got ${L.tp}`);
  assert(near(L.sl, 4019.28), `long SL = entry-1.00, got ${L.sl}`);
  assert(L.direction === 'LONG' && L.tpPoints === 200 && L.slPoints === 100, 'long fields');

  // SHORT fills at BID, TP -$2.00, SL +$1.00.
  const S = buildSignal(sc('TAKE_SHORT', 80), 4020.00, 4020.28, 4020.14, null)!;
  assert(near(S.entry, 4020.00), `short enters at bid, got ${S.entry}`);
  assert(near(S.tp, 4018.00), `short TP = entry-2.00, got ${S.tp}`);
  assert(near(S.sl, 4021.00), `short SL = entry+1.00, got ${S.sl}`);

  // R:R must be 2:1 both ways.
  assert(near(Math.abs(L.tp - L.entry) / Math.abs(L.entry - L.sl), 2), 'long R:R = 2');
  assert(near(Math.abs(S.entry - S.tp) / Math.abs(S.sl - S.entry), 2), 'short R:R = 2');

  console.log('signals.ts demo OK —',
    `LONG entry=${L.entry} tp=${L.tp} sl=${L.sl} | SHORT entry=${S.entry} tp=${S.tp} sl=${S.sl} | R:R 2:1, dedupe per episode`);
}

if (typeof require !== 'undefined' && require.main === module) demo();
