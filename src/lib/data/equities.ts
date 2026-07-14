import type { RegimeInputs } from '../engine/regime';
import { createHash } from 'node:crypto';

// Stooq daily CSV per US ticker (no key). Rows OLDEST→NEWEST.
// Everything guarded per-ticker: a failed/short fetch nulls only its dependent fields.
// Stooq now fronts the CSV endpoint with a SHA-256 proof-of-work JS challenge on some
// IPs. We solve it with stdlib crypto and reuse the resulting auth cookie for all tickers.
// (Datacenter IPs may still get "Access denied" on the download API itself — that just
// degrades to [] like any other miss; a normal/residential IP serves the CSV.)

const BASE = 'https://stooq.com';
const TICKERS = ['anet', 'nvda', 'lrcx', 'amat', 'klac', 'asml', 'spy', 'vst', 'xlu', 'urnm', 'leu', 'sruuf'] as const;
type Ticker = (typeof TICKERS)[number];

interface Bar { close: number; volume: number; }

const cookieHdr = (setCookies: string[]) => setCookies.map((c) => c.split(';')[0]).join('; ');
const getSetCookie = (r: Response): string[] => (r.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];

async function timedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try { return await fetch(url, { ...init, signal: ctl.signal }); }
  finally { clearTimeout(timer); }
}

// If `html` is the PoW challenge page, solve it and return the auth cookie string; else ''.
async function solveChallenge(html: string, seedCookies: string[]): Promise<string> {
  const m = html.match(/c="([^"]+)",d=(\d+)/);
  if (!m) return '';
  const c = m[1], target = '0'.repeat(Number(m[2]));
  let n = 0;
  while (!createHash('sha256').update(c + n).digest('hex').startsWith(target)) n++; // ~16^d iters, <50ms for d=4
  const r = await timedFetch(`${BASE}/__verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHdr(seedCookies) },
    body: `c=${encodeURIComponent(c)}&n=${n}`,
  });
  return cookieHdr([...seedCookies, ...getSetCookie(r)]);
}

function parseCsv(text: string): Bar[] {
  const lines = text.trim().split('\n');
  if (lines.length < 2 || !/^Date,/i.test(lines[0])) return []; // header check; misses return "No data"/"Access denied" plaintext
  const bars: Bar[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    const close = Number(c[4]), volume = Number(c[5]);
    if (Number.isFinite(close) && close > 0) bars.push({ close, volume: Number.isFinite(volume) ? volume : 0 });
  }
  return bars.slice(-120); // last ~120 rows
}

async function fetchStooq(ticker: string, cookie: string): Promise<Bar[]> {
  try {
    const res = await timedFetch(`${BASE}/q/d/l/?s=${ticker}.us&i=d`, cookie ? { headers: { Cookie: cookie } } : {});
    if (!res.ok) return [];
    const text = await res.text();
    if (/^Date,/i.test(text)) return parseCsv(text);
    // Still challenged (cookie missing/expired) → solve inline once for this call.
    const ck = await solveChallenge(text, getSetCookie(res));
    if (!ck) return [];
    const res2 = await timedFetch(`${BASE}/q/d/l/?s=${ticker}.us&i=d`, { headers: { Cookie: ck } });
    return res2.ok ? parseCsv(await res2.text()) : [];
  } catch {
    return [];
  }
}

// Solve the challenge once up front so all 12 ticker fetches share one auth cookie.
async function getAuthCookie(): Promise<string> {
  try {
    const r = await timedFetch(`${BASE}/q/d/l/?s=spy.us&i=d`);
    const text = await r.text();
    if (/^Date,/i.test(text)) return ''; // no challenge on this IP — plain fetch works
    return await solveChallenge(text, getSetCookie(r));
  } catch { return ''; }
}

const sma = (a: number[], n: number): number | null => (a.length >= n ? a.slice(-n).reduce((s, x) => s + x, 0) / n : null);
const closes = (b?: Bar[]) => (b && b.length ? b.map((x) => x.close) : null);

// ratioNow/Sma/Prev for a series built elementwise; needs aligned length. SMA over `n` of the ratio series.
function ratioTriple(num: number[] | null, den: number[] | null, n: number): [number | null, number | null, number | null] {
  if (!num || !den) return [null, null, null];
  const len = Math.min(num.length, den.length);
  if (len < n + 1) return [null, null, null];
  const a = num.slice(-len), b = den.slice(-len);
  const ratio: number[] = [];
  for (let i = 0; i < len; i++) if (b[i] !== 0) ratio.push(a[i] / b[i]); else ratio.push(NaN);
  const clean = ratio.filter((x) => Number.isFinite(x));
  if (clean.length < n + 1) return [null, null, null];
  const now = ratio[ratio.length - 1];
  const prev = ratio[ratio.length - 2];
  if (!Number.isFinite(now) || !Number.isFinite(prev)) return [null, null, null];
  return [now, sma(ratio.filter(Number.isFinite), n), prev];
}

// Pearson correlation of two aligned series over the last `n` bars.
function pearson(x: number[], y: number[], n: number): number | null {
  const len = Math.min(x.length, y.length);
  if (len < n) return null;
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
    const cookie = await getAuthCookie();
    const results = await Promise.all(TICKERS.map((t) => fetchStooq(t, cookie)));
    const bars = {} as Record<Ticker, Bar[]>;
    TICKERS.forEach((t, i) => { bars[t] = results[i]; });

    const anet = closes(bars.anet), nvda = closes(bars.nvda);
    const lrcx = closes(bars.lrcx), amat = closes(bars.amat), klac = closes(bars.klac), asml = closes(bars.asml);
    const spy = closes(bars.spy), vst = closes(bars.vst), xlu = closes(bars.xlu);
    const leu = closes(bars.leu), sruuf = closes(bars.sruuf);

    // digest = ANET/NVDA, SMA 20
    const [dNow, dSma, dPrev] = ratioTriple(anet, nvda, 20);
    out.digestNow = dNow; out.digestSma = dSma; out.digestPrev = dPrev;

    // fab = (LRCX+AMAT+KLAC+ASML)/SPY, SMA 20
    let wfe: number[] | null = null;
    if (lrcx && amat && klac && asml) {
      const len = Math.min(lrcx.length, amat.length, klac.length, asml.length);
      const l = lrcx.slice(-len), a = amat.slice(-len), k = klac.slice(-len), s = asml.slice(-len);
      wfe = l.map((_, i) => l[i] + a[i] + k[i] + s[i]);
    }
    const [fNow, fSma, fPrev] = ratioTriple(wfe, spy, 20);
    out.fabNow = fNow; out.fabSma = fSma; out.fabPrev = fPrev;

    // util = VST/XLU, SMA 20
    const [uNow, uSma, uPrev] = ratioTriple(vst, xlu, 20);
    out.utilNow = uNow; out.utilSma = uSma; out.utilPrev = uPrev;

    // URNM
    const urnmC = closes(bars.urnm);
    if (urnmC && urnmC.length >= 22) {
      out.urnmNow = urnmC[urnmC.length - 1];
      out.urnm21dAgo = urnmC[urnmC.length - 22];
      const vols = bars.urnm.map((b) => b.volume);
      out.urnmVol = vols[vols.length - 1];
      out.urnmVolAvg = sma(vols, 20);
    } else {
      out.urnmNow = out.urnm21dAgo = out.urnmVol = out.urnmVolAvg = null;
    }

    // SPY
    if (spy && spy.length >= 22) { out.spyNow = spy[spy.length - 1]; out.spy21dAgo = spy[spy.length - 22]; }
    else { out.spyNow = out.spy21dAgo = null; }

    // LEU: last close + ~20-week SMA approximated by SMA of last 100 daily closes
    if (leu && leu.length) {
      out.leuNow = leu[leu.length - 1];
      out.leuSma20w = sma(leu, 100);
    } else { out.leuNow = out.leuSma20w = null; }

    // aiCorr (VST vs NVDA, 60 aligned bars); vstNow, vstSma20
    if (vst && nvda) {
      const len = Math.min(vst.length, nvda.length);
      out.aiCorr = pearson(vst.slice(-len), nvda.slice(-len), 60);
    } else out.aiCorr = null;
    if (vst && vst.length) { out.vstNow = vst[vst.length - 1]; out.vstSma20 = sma(vst, 20); }
    else { out.vstNow = out.vstSma20 = null; }

    // sruuf last close; ux1 stays null (Spot-Premium check unavailable)
    out.sruuf = sruuf && sruuf.length ? sruuf[sruuf.length - 1] : null;
  } catch {
    // any unexpected failure → return whatever we have (graceful degradation)
  }
  return out;
}
