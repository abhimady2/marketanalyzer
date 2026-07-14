// Multi-timeframe XAUUSD candles. Source: Binance PAXG/USDT klines (no key, true
// OHLCV, native 15m/1h/4h/1d). PAXG = PAX Gold, tracks spot gold within a hair —
// for TREND direction (what we compute) it is functionally identical to XAUUSD.
// ponytail: PAXG-as-proxy for gold; the exact XAUUSD spot comes from price.ts.
// If the PAXG basis ever matters, swap in a keyed XAU/USD OHLC feed here.

export type Timeframe = '15m' | '1h' | '4h' | '1d';

export interface Candle { t: number; o: number; h: number; l: number; c: number; v: number; }

const BINANCE = 'https://api.binance.com/api/v3/klines';

async function get<T>(url: string, ms = 8000): Promise<T | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchCandles(tf: Timeframe, limit = 300): Promise<Candle[]> {
  const url = `${BINANCE}?symbol=PAXGUSDT&interval=${tf}&limit=${limit}`;
  const raw = await get<any[][]>(url);
  if (!raw || !Array.isArray(raw)) return [];
  // Binance kline: [openTime, open, high, low, close, volume, ...]
  return raw.map((k) => ({
    t: k[0],
    o: parseFloat(k[1]),
    h: parseFloat(k[2]),
    l: parseFloat(k[3]),
    c: parseFloat(k[4]),
    v: parseFloat(k[5]),
  })).filter((c) => Number.isFinite(c.c) && c.c > 0);
}

// Prefer fresh MT5 (real broker XAUUSD) candles; fall back to Binance PAXG per
// timeframe. MT5 "fresh" = pushed within 20 min (a stale VPS shouldn't freeze the site).
export async function fetchAllTimeframes(): Promise<Record<Timeframe, Candle[]>> {
  const { readMt5Feed } = await import('./mt5');
  const feed = await readMt5Feed();
  const MT5_FRESH_MS = 20 * 60 * 1000;
  const usable = feed && feed.ageMs < MT5_FRESH_MS ? feed.candles : null;

  const tfs: Timeframe[] = ['1d', '4h', '1h', '15m'];
  const out = {} as Record<Timeframe, Candle[]>;
  const need: Timeframe[] = [];
  for (const tf of tfs) {
    const c = usable?.[tf];
    if (c && c.length >= 30) out[tf] = c; else need.push(tf);
  }
  if (need.length) {
    const fetched = await Promise.all(need.map((tf) => fetchCandles(tf)));
    need.forEach((tf, i) => { out[tf] = fetched[i]; });
  }
  return out;
}
