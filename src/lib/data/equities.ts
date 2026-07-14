import type { RegimeInputs } from '../engine/regime';

// Yahoo Finance chart API per US ticker (no key). Works from Vercel iad1.
// Everything guarded per-ticker: a failed/short fetch nulls only its dependent fields.
// Requires a browser user-agent or Yahoo returns 403/429.

const TICKERS = ['ANET', 'NVDA', 'LRCX', 'AMAT', 'KLAC', 'ASML', 'SPY', 'VST', 'XLU', 'URNM', 'LEU', 'SRUUF'] as const;
type Ticker = (typeof TICKERS)[number];

interface Bar { t: number; close: number; volume: number; }

async function timedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try { return await fetch(url, { ...init, signal: ctl.signal }); }
  finally { clearTimeout(timer); }
}

// Fetch 1y daily bars; oldest→newest, skip null closes, keep last ~120.
async function fetchYahoo(ticker: string): Promise<Bar[]> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1y`;
    const res = await timedFetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
    if (!res.ok) return [];
    const j = await res.json() as {
      chart?: { result?: [{ timestamp?: number[]; indicators?: { quote?: [{ close?: (number | null)[]; volume?: (number | null)[] }] } }] };
    };
    const r = j.chart?.result?.[0];
    const ts = r?.timestamp, q = r?.indicators?.quote?.[0];
    if (!ts || !q?.close) return [];
    const bars: Bar[] = [];
    for (let i = 0; i < ts.length; i++) {
      const close = q.close[i];
      if (close == null || !Number.isFinite(close) || close <= 0) continue;
      const vol = q.volume?.[i];
      bars.push({ t: ts[i], close, volume: vol != null && Number.isFinite(vol) ? vol : 0 });
    }
    return bars.slice(-120);
  } catch {
    return [];
  }
}

const sma = (a: number[], n: number): number | null => (a.length >= n ? a.slice(-n).reduce((s, x) => s + x, 0) / n : null);

// Align two bar series by timestamp, return matched close pairs oldest→newest.
function alignBy<T extends { t: number }>(a: T[], b: T[]): [T[], T[]] {
  const bm = new Map(b.map((x) => [x.t, x]));
  const ax: T[] = [], bx: T[] = [];
  for (const x of a) { const y = bm.get(x.t); if (y) { ax.push(x); bx.push(y); } }
  return [ax, bx];
}

// ratioNow/Sma/Prev of numBars/denBars aligned by timestamp. SMA over `n` of the ratio series.
function ratioTriple(num: Bar[] | null, den: Bar[] | null, n: number): [number | null, number | null, number | null] {
  if (!num || !den) return [null, null, null];
  const [a, b] = alignBy(num, den);
  if (a.length < n + 1) return [null, null, null];
  const ratio: number[] = [];
  for (let i = 0; i < a.length; i++) ratio.push(b[i].close !== 0 ? a[i].close / b[i].close : NaN);
  const now = ratio[ratio.length - 1], prev = ratio[ratio.length - 2];
  if (!Number.isFinite(now) || !Number.isFinite(prev)) return [null, null, null];
  const clean = ratio.filter(Number.isFinite);
  return [now, sma(clean, n), prev];
}

// Pearson correlation of two aligned close series over the last `n` bars.
function pearson(x: number[], y: number[], n: number): number | null {
  if (x.length < n || y.length < n) return null;
  const a = x.slice(-n), b = y.slice(-n);
  const mx = a.reduce((s, v) => s + v, 0) / n, my = b.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = a[i] - mx, dy = b[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  const den = Math.sqrt(sxx * syy);
  return den !== 0 ? sxy / den : null;
}

export async function fetchEquities(): Promise<Partial<RegimeInputs>> {
  const out: Partial<RegimeInputs> = {};
  try {
    const results = await Promise.all(TICKERS.map((t) => fetchYahoo(t)));
    const bars = {} as Record<Ticker, Bar[]>;
    TICKERS.forEach((t, i) => { bars[t] = results[i]; });

    const b = (t: Ticker) => (bars[t].length ? bars[t] : null);
    const anet = b('ANET'), nvda = b('NVDA');
    const lrcx = b('LRCX'), amat = b('AMAT'), klac = b('KLAC'), asml = b('ASML');
    const spy = b('SPY'), vst = b('VST'), xlu = b('XLU');

    // digest = ANET/NVDA, SMA 20
    [out.digestNow, out.digestSma, out.digestPrev] = ratioTriple(anet, nvda, 20);

    // fab = (LRCX+AMAT+KLAC+ASML)/SPY, SMA 20 — sum WFE aligned by timestamp first.
    let wfe: Bar[] | null = null;
    if (lrcx && amat && klac && asml) {
      const am = new Map(amat.map((x) => [x.t, x.close]));
      const km = new Map(klac.map((x) => [x.t, x.close]));
      const sm = new Map(asml.map((x) => [x.t, x.close]));
      wfe = [];
      for (const x of lrcx) {
        const av = am.get(x.t), kv = km.get(x.t), sv = sm.get(x.t);
        if (av != null && kv != null && sv != null) wfe.push({ t: x.t, close: x.close + av + kv + sv, volume: 0 });
      }
    }
    [out.fabNow, out.fabSma, out.fabPrev] = ratioTriple(wfe, spy, 20);

    // util = VST/XLU, SMA 20
    [out.utilNow, out.utilSma, out.utilPrev] = ratioTriple(vst, xlu, 20);

    // URNM
    const urnm = b('URNM');
    if (urnm && urnm.length >= 22) {
      out.urnmNow = urnm[urnm.length - 1].close;
      out.urnm21dAgo = urnm[urnm.length - 22].close;
      const vols = urnm.map((x) => x.volume);
      out.urnmVol = vols[vols.length - 1];
      out.urnmVolAvg = sma(vols, 20);
    } else { out.urnmNow = out.urnm21dAgo = out.urnmVol = out.urnmVolAvg = null; }

    // SPY
    if (spy && spy.length >= 22) { out.spyNow = spy[spy.length - 1].close; out.spy21dAgo = spy[spy.length - 22].close; }
    else { out.spyNow = out.spy21dAgo = null; }

    // LEU: last close + ~20-week SMA (SMA of last 100 daily closes)
    const leu = b('LEU');
    if (leu) { out.leuNow = leu[leu.length - 1].close; out.leuSma20w = sma(leu.map((x) => x.close), 100); }
    else { out.leuNow = out.leuSma20w = null; }

    // aiCorr (VST vs NVDA, 60 aligned bars); vstNow, vstSma20
    if (vst && nvda) {
      const [va, na] = alignBy(vst, nvda);
      out.aiCorr = pearson(va.map((x) => x.close), na.map((x) => x.close), 60);
    } else out.aiCorr = null;
    if (vst) { out.vstNow = vst[vst.length - 1].close; out.vstSma20 = sma(vst.map((x) => x.close), 20); }
    else { out.vstNow = out.vstSma20 = null; }

    // sruuf last close; ux1 stays null (term-premium unavailable)
    const sruuf = b('SRUUF');
    out.sruuf = sruuf ? sruuf[sruuf.length - 1].close : null;
  } catch {
    // graceful degradation — return whatever we have
  }
  return out;
}
