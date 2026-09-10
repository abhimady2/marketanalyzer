import { getLatestSnapshot, runAnalysis } from '@/lib/engine/analyze';

// The dashboard polls this ~8s. Serve the cached snapshot when fresh; otherwise
// recompute SYNCHRONOUSLY (fast — macro inputs are cached 30m and candles/news come
// from the MT5 feed in Supabase) so every stale poll returns genuinely current data.
// (Vercel's `after()` background task proved unreliable here, freezing the snapshot.)
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// ponytail: 10s = the MT5 EA's own push interval. Recomputing faster than the feed
// arrives just re-derives the same answer on Vercel's clock. Paired with s-maxage
// below, N open tabs collapse to ONE origin invocation per window instead of N.
const STALE_MS = 10 * 1000;
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), {
    status,
    headers: {
      'content-type': 'application/json',
      // Shared-cache only: the CDN fans one recompute out to every poller, while
      // `no-store` clients still always reach the edge (never a stale browser copy).
      'cache-control': 's-maxage=10, stale-while-revalidate=20',
    },
  });

export async function GET() {
  const snap = await getLatestSnapshot();
  const age = snap ? Date.now() - snap.at : Infinity;
  if (snap && age < STALE_MS) return json({ snapshot: snap, ageMs: age });
  const fresh = await runAnalysis(false);
  return json({ snapshot: fresh, ageMs: 0 });
}
