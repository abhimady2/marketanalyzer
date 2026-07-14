// Live XAUUSD spot price. Primary: gold-api.com (free, no key, real spot gold).
// Fallbacks: Stooq forex quote, then Binance PAXG last trade. All server-side.

export interface Spot { price: number; changePct: number | null; source: string; at: number; }

async function tryGoldApi(): Promise<Spot | null> {
  try {
    const r = await fetch('https://api.gold-api.com/price/XAU', { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const j: any = await r.json();
    const price = Number(j?.price);
    if (!Number.isFinite(price) || price <= 0) return null;
    return { price, changePct: null, source: 'gold-api.com', at: Date.now() };
  } catch { return null; }
}

async function tryStooq(): Promise<Spot | null> {
  try {
    // Symbol,Date,Time,Open,High,Low,Close,Volume
    const r = await fetch('https://stooq.com/q/l/?s=xauusd&f=sd2t2ohlcv&h&e=csv', { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const lines = (await r.text()).trim().split('\n');
    if (lines.length < 2) return null;
    const c = lines[1].split(',');
    const open = parseFloat(c[3]);
    const close = parseFloat(c[6]);
    if (!Number.isFinite(close) || close <= 0) return null;
    const changePct = Number.isFinite(open) && open > 0 ? ((close - open) / open) * 100 : null;
    return { price: close, changePct, source: 'stooq', at: Date.now() };
  } catch { return null; }
}

async function tryBinance(): Promise<Spot | null> {
  try {
    const r = await fetch('https://api.binance.com/api/v3/ticker/24hr?symbol=PAXGUSDT', { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const j: any = await r.json();
    const price = Number(j?.lastPrice);
    if (!Number.isFinite(price) || price <= 0) return null;
    return { price, changePct: Number(j?.priceChangePercent) ?? null, source: 'binance-paxg', at: Date.now() };
  } catch { return null; }
}

export async function fetchSpot(): Promise<Spot | null> {
  // Prefer the MT5 broker price when pushed within the last 90s.
  const { readMt5Feed } = await import('./mt5');
  const feed = await readMt5Feed();
  if (feed?.price && feed.ageMs < 90_000) {
    const mid = (feed.price.bid + feed.price.ask) / 2 || feed.price.last;
    if (mid > 0) return { price: mid, changePct: null, source: `mt5:${feed.symbol}`, at: feed.at };
  }
  return (await tryGoldApi()) || (await tryStooq()) || (await tryBinance());
}
