import { getLatestSnapshot, runAnalysis } from '@/lib/engine/analyze';

// The dashboard polls this ~8s. Serve the cached snapshot when fresh; otherwise
// recompute SYNCHRONOUSLY (fast — macro inputs are cached 30m and candles/news come
// from the MT5 feed in Supabase) so every stale poll returns genuinely current data.
// (Vercel's `after()` background task proved unreliable here, freezing the snapshot.)
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// ponytail: 60s = a human looking at a dashboard. Regime/technical/levels ride the H1
// candles, not the tick — a 10s recompute per 8s poll just re-derived the same answer
// on Vercel's clock. Paired with s-maxage below, N open tabs collapse to ONE origin
// invocation per window instead of N.
const STALE_MS = 60 * 1000;
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), {
    status,
    headers: {
      'content-type': 'application/json',
      // The CDN fans ONE recompute out to every poller. Must be Vercel-CDN-Cache-Control,
      // NOT cache-control: Next overrides cache-control to `public, max-age=0,
      // must-revalidate` on every `dynamic = 'force-dynamic'` route handler, which silently
      // ate the s-maxage that /api/price had been setting (uselessly) for weeks. This header
      // Next leaves alone, and being CDN-only the browser still never serves a stale copy.
      'Vercel-CDN-Cache-Control': 'max-age=60, stale-while-revalidate=120',
    },
  });

export async function GET() {
  const snap = await getLatestSnapshot();
  const age = snap ? Date.now() - snap.at : Infinity;
  if (snap && age < STALE_MS) return json({ snapshot: snap, ageMs: age });
  const fresh = await runAnalysis(false);
  return json({ snapshot: fresh, ageMs: 0 });
}
