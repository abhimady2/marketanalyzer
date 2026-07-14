import type { RegimeInputs } from '../engine/regime';

// FRED CSV, no key. All graceful-degradation: never throws, returns nulls on failure.
// UNITS: WALCL/WDTGAL are $millions → /1000 for $B; RRPONTSYD already $B.
//        DGS2/DGS10 in %; DTWEXBGS is an index value.

const FRED = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=';

async function fetchCsv(id: string, cosd: string): Promise<Map<string, number>> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  const out = new Map<string, number>();
  try {
    const res = await fetch(`${FRED}${id}&cosd=${cosd}`, { signal: ctl.signal });
    if (!res.ok) return out;
    const text = await res.text();
    for (const line of text.split('\n').slice(1)) {
      const [date, raw] = line.split(',');
      if (!date || raw == null) continue;
      const v = raw.trim();
      if (v === '' || v === '.') continue; // missing → skip
      const n = Number(v);
      if (!Number.isNaN(n)) out.set(date.trim(), n);
    }
  } catch {
    // swallow — degrade to whatever we parsed (likely empty)
  } finally {
    clearTimeout(timer);
  }
  return out;
}

// Business-day (Mon–Fri) date strings from `start` to today, oldest→newest.
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

// Forward-fill a sparse date→value map onto the business-day axis.
// Handles WALCL (weekly), holidays, and ragged series with one code path.
function fill(axis: string[], map: Map<string, number>, scale = 1): number[] {
  const out: number[] = [];
  let last: number | null = null;
  for (const day of axis) {
    if (map.has(day)) last = map.get(day)! * scale;
    out.push(last == null ? NaN : last);
  }
  return out;
}

// Index offsets on an oldest→newest business-day array.
const at = (a: number[], back: number): number | null => {
  const v = a[a.length - 1 - back];
  return v == null || Number.isNaN(v) ? null : v;
};

export async function fetchFred(): Promise<Partial<RegimeInputs>> {
  try {
    const cosd = new Date(Date.now() - 300 * 864e5).toISOString().slice(0, 10);
    const [walcl, wdtgal, rrp, dgs2, dgs10, dxy] = await Promise.all([
      fetchCsv('WALCL', cosd), fetchCsv('WDTGAL', cosd), fetchCsv('RRPONTSYD', cosd),
      fetchCsv('DGS2', cosd), fetchCsv('DGS10', cosd), fetchCsv('DTWEXBGS', cosd),
    ]);

    // Common axis: start ~150 business days back so the tail has ~100 clean points
    // after all series (esp. weekly WALCL) have a known value to forward-fill from.
    const fullAxis = businessDays(new Date(Date.now() - 220 * 864e5));
    const axis = fullAxis.slice(-120);

    const fedDaily = fill(axis, walcl, 1 / 1000); // $M → $B
    const tgaDaily = fill(axis, wdtgal, 1 / 1000); // $M → $B
    const rrpDaily = fill(axis, rrp);              // already $B
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
  } catch {
    return {}; // total failure → engine degrades every FRED-fed check
  }
}
