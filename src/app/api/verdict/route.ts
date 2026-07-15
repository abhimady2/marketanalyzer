import { getLatestSnapshot, runAnalysis } from '@/lib/engine/analyze';

// The dashboard polls this ~15s. Serve the cached snapshot when fresh; otherwise
// recompute SYNCHRONOUSLY (fast — macro inputs are cached 30m and candles/news come
// from the MT5 feed in Supabase) so every stale poll returns genuinely current data.
// (Vercel's `after()` background task proved unreliable here, freezing the snapshot.)
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const STALE_MS = 8 * 1000; // scalp needs freshness; recompute is cheap (MT5 feed from Supabase, macro cached)
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

export async function GET() {
  const snap = await getLatestSnapshot();
  const age = snap ? Date.now() - snap.at : Infinity;
  if (snap && age < STALE_MS) return json({ snapshot: snap, ageMs: age });
  const fresh = await runAnalysis(false);
  return json({ snapshot: fresh, ageMs: 0 });
}
