// Reads the latest MT5 EA push from ma_cache ('mt5:feed'). candles.ts and price.ts
// prefer this real-broker XAUUSD data over Binance/gold-api when it's fresh.
import { getSupabase } from '@/lib/supabase';
import type { Candle } from './candles';

export interface Mt5Feed {
  symbol: string;
  price: { bid: number; ask: number; last: number; time: number } | null;
  candles: Record<string, Candle[]> | null; // keyed by tf incl '1m'/'5m' for scalp
  news: any[] | null; // MT5 economic calendar events
  at: number;
  ageMs: number;
}

export async function readMt5Feed(): Promise<Mt5Feed | null> {
  try {
    const { data } = await getSupabase()
      .from('ma_cache').select('payload, updated_at').eq('key', 'mt5:feed').maybeSingle();
    const p: any = data?.payload;
    if (!p) return null;
    const at = typeof p.at === 'number' ? p.at : +new Date(data!.updated_at);
    return {
      symbol: p.symbol || 'XAUUSD',
      price: p.price ?? null,
      candles: p.candles ?? null,
      news: Array.isArray(p.news) ? p.news : null,
      at,
      ageMs: Date.now() - at,
    };
  } catch {
    return null;
  }
}
