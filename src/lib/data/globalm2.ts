import type { RegimeInputs } from '../engine/regime';

// Global M2 (China/Euro/Japan) in USD trillions, from FRED (reachable from iad1).
// The engine only uses the ROC of (cn+eu+jp), so each PrevM MUST share its Now's scaling.
// NOTE: FRED's national-currency M2/broad-money LEVEL series are all discontinued —
// the only currently-updating ones are growth-rate, which can't be summed by weight.
// So we use the freshest available LEVEL series (stale but consistently scaled):
//   China MYAGM2CNM189N (M2, CNY, ends ~2019) ; Euro/Japan MABMM301 broad money (ends ~2023).
// Scale so cn~$28-45T, eu~$16-18T, jp~$8-10T. Absolute is approximate; the ROC is real.

const FRED = 'https://api.stlouisfed.org/fred/series/observations';
const KEY = 'c802d92521a1a05ec2d592773ddb6aa6';

async function obs(id: string, start: string): Promise<{ date: string; value: number }[]> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 8000);
  try {
    const res = await fetch(`${FRED}?series_id=${id}&api_key=${KEY}&file_type=json&observation_start=${start}`, { signal: c.signal });
    if (!res.ok) return [];
    const j: any = await res.json();
    const out: { date: string; value: number }[] = [];
    for (const o of j?.observations || []) {
      const n = Number(o.value);
      if (o.value !== '.' && Number.isFinite(n)) out.push({ date: String(o.date), value: n });
    }
    return out; // oldest -> newest
  } catch { return []; }
  finally { clearTimeout(t); }
}

const lastFx = (a: { value: number }[]): number | null => (a.length ? a[a.length - 1].value : null);

// last two monthly values (native currency) or nulls
function lastTwo(a: { value: number }[]): [number, number] | null {
  if (a.length < 2) return null;
  return [a[a.length - 1].value, a[a.length - 2].value]; // [now, prevM]
}

export async function fetchGlobalM2(): Promise<Partial<RegimeInputs>> {
  const mStart = '2015-01-01'; // enough monthly history for any of these stale series
  const fxStart = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  try {
    const [cn, eu, jp, cnyUsd, usdEur, jpyUsd] = await Promise.all([
      obs('MYAGM2CNM189N', mStart),   // China M2, CNY
      obs('MABMM301EZM189S', mStart),  // Euro broad money, EUR
      obs('MABMM301JPM189S', mStart),  // Japan broad money, JPY
      obs('DEXCHUS', fxStart),         // CNY per USD
      obs('DEXUSEU', fxStart),         // USD per EUR
      obs('DEXJPUS', fxStart),         // JPY per USD
    ]);

    const cnyPerUsd = lastFx(cnyUsd);
    const usdPerEur = lastFx(usdEur);
    const jpyPerUsd = lastFx(jpyUsd);
    const cn2 = lastTwo(cn), eu2 = lastTwo(eu), jp2 = lastTwo(jp);

    // native -> USD trillions (1e12). China/Japan divide by (X per USD); Euro multiply by (USD per EUR).
    const cnT = (v: number) => (cnyPerUsd ? v / cnyPerUsd / 1e12 : null);
    const euT = (v: number) => (usdPerEur ? (v * usdPerEur) / 1e12 : null);
    const jpT = (v: number) => (jpyPerUsd ? v / jpyPerUsd / 1e12 : null);

    return {
      cnNow: cn2 ? cnT(cn2[0]) : null, cnPrevM: cn2 ? cnT(cn2[1]) : null,
      euNow: eu2 ? euT(eu2[0]) : null, euPrevM: eu2 ? euT(eu2[1]) : null,
      jpNow: jp2 ? jpT(jp2[0]) : null, jpPrevM: jp2 ? jpT(jp2[1]) : null,
    };
  } catch { return {}; }
}
