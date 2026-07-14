import type { RegimeInputs } from '../engine/regime';

// Free/no-key crypto liquidity + market inputs. Never throws — nulls on failure.
async function get(url: string, kind: 'json' | 'text' = 'json'): Promise<any> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 8000);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { accept: '*/*' } });
    if (!r.ok) return null;
    return kind === 'json' ? await r.json() : await r.text();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export async function fetchCrypto(): Promise<Partial<RegimeInputs>> {
  const out: Partial<RegimeInputs> = {};
  const CG = 'https://api.coingecko.com/api/v3';

  // Stablecoin mcap history (tether + usdc), daily, $B, oldest→newest.
  try {
    const [t, u] = await Promise.all([
      get(`${CG}/coins/tether/market_chart?vs_currency=usd&days=120&interval=daily`),
      get(`${CG}/coins/usd-coin/market_chart?vs_currency=usd&days=120&interval=daily`),
    ]);
    const tc: [number, number][] = t?.market_caps ?? [];
    const uc: [number, number][] = u?.market_caps ?? [];
    if (tc.length) {
      const n = uc.length ? Math.min(tc.length, uc.length) : tc.length;
      const daily: number[] = [];
      for (let i = 0; i < n; i++) {
        const sum = tc[tc.length - n + i][1] + (uc.length ? uc[uc.length - n + i][1] : 0);
        daily.push(sum / 1e9);
      }
      out.stablesDaily = daily;
      out.stablesNow = daily[daily.length - 1];
      out.stablesPrevM = daily[Math.max(0, daily.length - 1 - 21)];
    }
  } catch {}

  // Global: stablecoin dominance.
  try {
    const g = await get(`${CG}/global`);
    const pct = g?.data?.market_cap_percentage;
    if (pct) {
      const dom = ['usdt', 'usdc', 'dai', 'busd', 'tusd', 'usde', 'fdusd'].reduce(
        (s, k) => s + (typeof pct[k] === 'number' ? pct[k] : 0), 0);
      if (dom > 0) out.stableDomNow = dom;
    }
    out.stableDom7dAgo = null; // no free history

    // total3 = total mcap - btc - eth mcap.
    const totalUsd = g?.data?.total_market_cap?.usd;
    if (typeof totalUsd === 'number') {
      const mk = await get(`${CG}/coins/markets?vs_currency=usd&ids=bitcoin,ethereum`);
      if (Array.isArray(mk)) {
        const btc = mk.find((c: any) => c.id === 'bitcoin')?.market_cap;
        const eth = mk.find((c: any) => c.id === 'ethereum')?.market_cap;
        if (typeof btc === 'number' && typeof eth === 'number') {
          out.total3Now = totalUsd - btc - eth;
        }
      }
    }
  } catch {}
  out.total3_7dAgo = null;

  // Binance klines: ETHBTC and BTCUSDT.
  try {
    const eb = await get('https://api.binance.com/api/v3/klines?symbol=ETHBTC&interval=1d&limit=10');
    if (Array.isArray(eb) && eb.length >= 8) {
      out.ethbtcNow = parseFloat(eb[eb.length - 1][4]);
      out.ethbtc7dAgo = parseFloat(eb[eb.length - 1 - 7][4]);
    }
  } catch {}
  try {
    const bu = await get('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=3');
    if (Array.isArray(bu) && bu.length >= 2) {
      out.btcNow = parseFloat(bu[bu.length - 1][4]);
      out.btcPrev1d = parseFloat(bu[bu.length - 2][4]);
    }
  } catch {}

  // Stooq COIN stock CSV.
  try {
    const csv = await get('https://stooq.com/q/d/l/?s=coin.us&i=d', 'text');
    if (typeof csv === 'string') {
      const rows = csv.trim().split('\n').slice(1).filter(Boolean);
      const close = (r: string) => parseFloat(r.split(',')[4]);
      if (rows.length >= 2) {
        const last = close(rows[rows.length - 1]);
        const prev = close(rows[rows.length - 2]);
        if (isFinite(last)) out.coinNow = last;
        if (isFinite(prev)) out.coinPrev1d = prev;
      }
    }
  } catch {}

  return out;
}
