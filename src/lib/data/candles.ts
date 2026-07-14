// Multi-timeframe XAUUSD candles. Preference chain per timeframe:
//   1) MT5 broker feed (real XAUUSD.sc, pushed by the EA) when fresh
//   2) Yahoo Finance GC=F (COMEX gold, US-region friendly) — resampled for 4h
//   3) Binance PAXG/USDT (works outside US regions)
// The deploy region (US) can't reach Binance but can reach Yahoo + FRED, so Yahoo
// is the public fallback and Binance only helps from non-US regions.

export type Timeframe = '15m' | '1h' | '4h' | '1d';
export interface Candle { t: number; o: number; h: number; l: number; c: number; v: number; }

const BINANCE = 'https://api.binance.com/api/v3/klines';
const YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart/GC=F';

async function getJson<T>(url: string, headers: Record<string, string> = {}, ms = 8000): Promise<T | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json', ...headers } });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch { return null; } finally { clearTimeout(timer); }
}

// ── Binance PAXG ──
export async function fetchCandles(tf: Timeframe, limit = 300): Promise<Candle[]> {
  const raw = await getJson<any[][]>(`${BINANCE}?symbol=PAXGUSDT&interval=${tf}&limit=${limit}`);
  if (!Array.isArray(raw)) return [];
  return raw.map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }))
    .filter((c) => Number.isFinite(c.c) && c.c > 0);
}

// ── Yahoo GC=F ──
const YMAP: Record<Exclude<Timeframe, '4h'>, [string, string]> = {
  '15m': ['15m', '1mo'], '1h': ['60m', '3mo'], '1d': ['1d', '2y'],
};
function resample4h(h1: Candle[]): Candle[] {
  const buckets = new Map<number, Candle[]>();
  for (const c of h1) {
    const b = Math.floor(c.t / (4 * 3600e3)) * (4 * 3600e3);
    (buckets.get(b) ?? buckets.set(b, []).get(b)!).push(c);
  }
  return [...buckets.entries()].sort((a, z) => a[0] - z[0]).map(([b, arr]) => {
    arr.sort((a, z) => a.t - z.t);
    return { t: b, o: arr[0].o, h: Math.max(...arr.map((x) => x.h)), l: Math.min(...arr.map((x) => x.l)), c: arr[arr.length - 1].c, v: arr.reduce((s, x) => s + x.v, 0) };
  });
}
export async function fetchYahoo(tf: Timeframe): Promise<Candle[]> {
  if (tf === '4h') return resample4h(await fetchYahoo('1h'));
  const [interval, range] = YMAP[tf];
  const j = await getJson<any>(`${YAHOO}?interval=${interval}&range=${range}`, { 'user-agent': 'Mozilla/5.0' });
  const r = j?.chart?.result?.[0];
  if (!r?.timestamp || !r.indicators?.quote?.[0]) return [];
  const q = r.indicators.quote[0];
  const out: Candle[] = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i];
    if (o == null || h == null || l == null || c == null) continue;
    out.push({ t: r.timestamp[i] * 1000, o, h, l, c, v: q.volume?.[i] || 0 });
  }
  return out;
}

async function publicCandles(tf: Timeframe): Promise<Candle[]> {
  const y = await fetchYahoo(tf);
  if (y.length >= 30) return y;
  return fetchCandles(tf); // Binance last (non-US regions)
}

export async function fetchAllTimeframes(): Promise<Record<Timeframe, Candle[]>> {
  const { readMt5Feed } = await import('./mt5');
  const feed = await readMt5Feed();
  const usable = feed && feed.ageMs < 20 * 60 * 1000 ? feed.candles : null;

  const tfs: Timeframe[] = ['1d', '4h', '1h', '15m'];
  const out = {} as Record<Timeframe, Candle[]>;
  const need: Timeframe[] = [];
  for (const tf of tfs) {
    const c = usable?.[tf];
    if (c && c.length >= 30) out[tf] = c; else need.push(tf);
  }
  if (need.length) {
    const fetched = await Promise.all(need.map((tf) => publicCandles(tf)));
    need.forEach((tf, i) => { out[tf] = fetched[i]; });
  }
  return out;
}
