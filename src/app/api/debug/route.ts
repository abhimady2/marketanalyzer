import { fetchFred } from '@/lib/data/fred';
import { fetchCrypto } from '@/lib/data/crypto';
import { fetchEquities } from '@/lib/data/equities';
import { fetchAllTimeframes } from '@/lib/data/candles';
import { fetchNews } from '@/lib/data/news';
import { fetchSpot } from '@/lib/data/price';
import { fetchHeadlines } from '@/lib/data/headlines';

// TEMP diagnostic — reports which free data sources work from the deploy region.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET() {
  const out: any = { region: process.env.VERCEL_REGION || 'unknown' };
  const run = async (name: string, fn: () => Promise<any>, sum: (r: any) => any) => {
    const s = Date.now();
    try { const r = await fn(); out[name] = { ok: true, ms: Date.now() - s, ...sum(r) }; }
    catch (e: any) { out[name] = { ok: false, ms: Date.now() - s, error: String(e?.message || e) }; }
  };
  await Promise.all([
    run('fred', fetchFred, (r) => ({ fields: Object.keys(r).filter((k) => r[k] != null).length, fedNow: r.fedNow, dxyNow: r.dxyNow, fedDaily: Array.isArray(r.fedDaily) ? r.fedDaily.length : 0 })),
    run('crypto', fetchCrypto, (r) => ({ btcNow: r.btcNow, stablesNow: r.stablesNow, ethbtcNow: r.ethbtcNow, stablesDaily: Array.isArray(r.stablesDaily) ? r.stablesDaily.length : 0 })),
    run('equities', fetchEquities, (r) => ({ fields: Object.keys(r).filter((k) => r[k] != null).length, spyNow: r.spyNow })),
    run('candles', fetchAllTimeframes, (r) => ({ d1: r['1d']?.length || 0, h4: r['4h']?.length || 0, h1: r['1h']?.length || 0, m15: r['15m']?.length || 0 })),
    run('news', fetchNews, (r) => ({ source: r.source, events: r.events.length })),
    run('headlines', fetchHeadlines, (r) => ({ count: r.length })),
    run('spot', fetchSpot, (r) => ({ price: r?.price, source: r?.source })),
  ]);
  return Response.json(out);
}
