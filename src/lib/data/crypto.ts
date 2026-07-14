import type { RegimeInputs } from '../engine/regime';

// Free/no-key crypto liquidity + market inputs. Never throws — nulls on failure.
// iad1-safe sources only: CoinGecko + Yahoo Finance chart (NO Binance/Stooq).
async function get(url: string, headers: Record<string, string> = {}): Promise<any> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 8000);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { accept: 'application/json', ...headers } });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

const lastNum = (a: any): number | null => (Array.isArray(a) && a.length ? a[a.length - 1] : null);

export async function fetchCrypto(): Promise<Partial<RegimeInputs>> {
  const out: Partial<RegimeInputs> = {};
  const CG = 'https://api.coingecko.com/api/v3';
  const YF_HDR = { 'user-agent': 'Mozilla/5.0' };

  // 5 CoinGecko calls + 1 Yahoo, all in parallel to minimise wall time.
  const [tether, usdc, eth, btc, global, markets, coin] = await Promise.all([
    get(`${CG}/coins/tether/market_chart?vs_currency=usd&days=120&interval=daily`),
    get(`${CG}/coins/usd-coin/market_chart?vs_currency=usd&days=120&interval=daily`),
    get(`${CG}/coins/ethereum/market_chart?vs_currency=usd&days=8&interval=daily`),
    get(`${CG}/coins/bitcoin/market_chart?vs_currency=usd&days=8&interval=daily`),
    get(`${CG}/global`),
    get(`${CG}/coins/markets?vs_currency=usd&ids=bitcoin,ethereum`),
    get('https://query1.finance.yahoo.com/v8/finance/chart/COIN?interval=1d&range=5d', YF_HDR),
  ]);

  // Stablecoin mcap (tether + usdc), daily, $B, oldest→newest.
  const tc: [number, number][] = tether?.market_caps ?? [];
  const uc: [number, number][] = usdc?.market_caps ?? [];
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

  // ETH/BTC ratio + BTC price, from prices[][1] (usd).
  const ep: [number, number][] = eth?.prices ?? [];
  const bp: [number, number][] = btc?.prices ?? [];
  if (ep.length && bp.length) {
    const eNow = ep[ep.length - 1][1], bNow = bp[bp.length - 1][1];
    if (bNow) out.ethbtcNow = eNow / bNow;
    const i7 = Math.max(0, Math.min(ep.length, bp.length) - 1 - 7);
    const e7 = ep[i7]?.[1], b7 = bp[i7]?.[1];
    if (e7 != null && b7) out.ethbtc7dAgo = e7 / b7;
  }
  if (bp.length >= 2) {
    out.btcNow = bp[bp.length - 1][1];
    out.btcPrev1d = bp[bp.length - 2][1];
  }

  // Stablecoin dominance % (sum of stablecoins) + total3 (alt mcap ex btc/eth).
  const pct = global?.data?.market_cap_percentage;
  if (pct) {
    const dom = ['usdt', 'usdc', 'dai', 'busd', 'tusd', 'usde', 'fdusd'].reduce(
      (s, k) => s + (typeof pct[k] === 'number' ? pct[k] : 0), 0);
    if (dom > 0) out.stableDomNow = dom;
  }
  out.stableDom7dAgo = null; // no free 7d-ago dominance

  const totalUsd = global?.data?.total_market_cap?.usd;
  if (typeof totalUsd === 'number' && Array.isArray(markets)) {
    const btcMc = markets.find((c: any) => c.id === 'bitcoin')?.market_cap;
    const ethMc = markets.find((c: any) => c.id === 'ethereum')?.market_cap;
    if (typeof btcMc === 'number' && typeof ethMc === 'number') out.total3Now = totalUsd - btcMc - ethMc;
  }
  out.total3_7dAgo = null; // no free history

  // COIN stock — last two closes from Yahoo chart.
  const closes: (number | null)[] = coin?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [];
  const valid = closes.filter((x): x is number => typeof x === 'number' && isFinite(x));
  const cNow = lastNum(valid);
  if (cNow != null) out.coinNow = cNow;
  if (valid.length >= 2) out.coinPrev1d = valid[valid.length - 2];

  return out;
}
