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
import type { ScalpSignal } from './scalp';
import type { LevelsResult } from './levels';

const KEY = 'signals:recent';
const MAX_KEEP = 50;
export const MIN_CONFIDENCE = 75;
export const TP_POINTS = 200;   // $2.00
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

export async function emitSignal(
  scalp: ScalpSignal, bid: number | null, ask: number | null, price: number, levels: LevelsResult | null,
): Promise<TradeSignal | null> {
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
