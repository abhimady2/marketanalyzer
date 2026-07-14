import type { RegimeInputs } from '../engine/regime';
import { getSupabase } from '../supabase';

// FRED CSV, no key. UNITS: WALCL/WDTGAL are $millions → /1000 for $B; RRPONTSYD
// already $B; DGS2/DGS10 in %; DTWEXBGS is an index value.
// FRED (St. Louis) is slow from non-US regions, so results are cached in Supabase
// for 12h (FRED updates daily) with a stale-fallback: once a fetch succeeds, the
// liquidity inputs stay available even if a later fetch is slow or blocked.

const FRED_CSV = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=';
const FRED_API = 'https://api.stlouisfed.org/fred/series/observations';
const REQ_TIMEOUT = 20000;
const CACHE_KEY = 'fred:latest';
const TTL_MS = 12 * 3600 * 1000;

// The official FRED API (needs a free key) is built for server access; the keyless
// graph CSV is browser-only and blocks datacenter IPs (Vercel). So: API when a key
// is set, else the CSV (works from residential/local). Either way returns date→value.
async function fetchSeries(id: string, cosd: string): Promise<Map<string, number>> {
  const key = process.env.FRED_API_KEY || '';
  const out = new Map<string, number>();
  const withTimeout = () => { const c = new AbortController(); const t = setTimeout(() => c.abort(), REQ_TIMEOUT); return { signal: c.signal, done: () => clearTimeout(t) }; };

  if (key) {
    const g = withTimeout();
    try {
      const url = `${FRED_API}?series_id=${id}&api_key=${key}&file_type=json&observation_start=${cosd}`;
      const res = await fetch(url, { signal: g.signal });
      if (res.ok) {
        const j: any = await res.json();
        for (const o of j?.observations || []) {
          const n = Number(o.value);
          if (o.date && o.value !== '.' && !Number.isNaN(n)) out.set(String(o.date), n);
        }
        if (out.size) return out;
      }
    } catch { /* fall to CSV */ } finally { g.done(); }
  }

  const g = withTimeout();
  try {
    const res = await fetch(`${FRED_CSV}${id}&cosd=${cosd}`, { signal: g.signal });
    if (res.ok) {
      const text = await res.text();
      for (const line of text.split('\n').slice(1)) {
        const [date, raw] = line.split(',');
        if (!date || raw == null) continue;
        const v = raw.trim();
        if (v === '' || v === '.') continue;
        const n = Number(v);
        if (!Number.isNaN(n)) out.set(date.trim(), n);
      }
    }
  } catch { /* degrade */ } finally { g.done(); }
  return out;
}

function businessDays(start: Date): string[] {
  const days: string[] = [];
  const d = new Date(start);
  const today = new Date();
  while (d <= today) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) days.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return days;
}

function fill(axis: string[], map: Map<string, number>, scale = 1): number[] {
  const out: number[] = [];
  let last: number | null = null;
  for (const day of axis) {
    if (map.has(day)) last = map.get(day)! * scale;
    out.push(last == null ? NaN : last);
  }
  return out;
}

const at = (a: number[], back: number): number | null => {
  const v = a[a.length - 1 - back];
  return v == null || Number.isNaN(v) ? null : v;
};

async function computeFred(): Promise<Partial<RegimeInputs>> {
  const cosd = new Date(Date.now() - 300 * 864e5).toISOString().slice(0, 10);
  const [walcl, wdtgal, rrp, dgs2, dgs10, dxy] = await Promise.all([
    fetchSeries('WALCL', cosd), fetchSeries('WDTGAL', cosd), fetchSeries('RRPONTSYD', cosd),
    fetchSeries('DGS2', cosd), fetchSeries('DGS10', cosd), fetchSeries('DTWEXBGS', cosd),
  ]);
  const axis = businessDays(new Date(Date.now() - 220 * 864e5)).slice(-120);
  const fedDaily = fill(axis, walcl, 1 / 1000);
  const tgaDaily = fill(axis, wdtgal, 1 / 1000);
  const rrpDaily = fill(axis, rrp);
  const dxyDaily = fill(axis, dxy);
  const us2 = fill(axis, dgs2);
  const us10 = fill(axis, dgs10);
  return {
    fedNow: at(fedDaily, 0), fedPrevM: at(fedDaily, 21),
    tgaNow: at(tgaDaily, 0), tgaPrevM: at(tgaDaily, 21),
    rrpNow: at(rrpDaily, 0), rrpPrevM: at(rrpDaily, 21),
    dxyNow: at(dxyDaily, 0), dxy7dAgo: at(dxyDaily, 5), dxy21dAgo: at(dxyDaily, 21),
    us2Now: at(us2, 0), us2_7dAgo: at(us2, 5), us2_21dAgo: at(us2, 21),
    us10Now: at(us10, 0), us10_21dAgo: at(us10, 21),
    fedDaily, tgaDaily, rrpDaily, dxyDaily,
  };
}

export async function fetchFred(): Promise<Partial<RegimeInputs>> {
  const sb = getSupabase();
  let cached: Partial<RegimeInputs> | null = null;
  try {
    const { data } = await sb.from('ma_cache').select('payload, updated_at').eq('key', CACHE_KEY).maybeSingle();
    if (data?.payload) {
      cached = data.payload as Partial<RegimeInputs>;
      if (Date.now() - +new Date(data.updated_at) < TTL_MS) return cached; // fresh cache
    }
  } catch { /* no cache */ }

  try {
    const fresh = await computeFred();
    if (fresh.fedNow != null || fresh.dxyNow != null || fresh.us10Now != null) {
      try { await sb.from('ma_cache').upsert({ key: CACHE_KEY, payload: fresh, updated_at: new Date().toISOString() }, { onConflict: 'key' }); } catch { /* best effort */ }
      return fresh;
    }
  } catch { /* fall to stale */ }

  return cached ?? {}; // stale cache beats nothing when a live fetch is slow/blocked
}
