import { after } from 'next/server';
import { getLatestSnapshot, runAnalysis } from '@/lib/engine/analyze';

// The dashboard reads this. Serves the cached snapshot instantly; if it's stale,
// serves stale + recomputes in the background (stale-while-revalidate). Only a
// cold cache (first ever hit) blocks on a compute.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const STALE_MS = 45 * 1000; // live dashboard polls ~15s; recompute at most ~every 45s (macro inputs are cached 30m)
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

export async function GET() {
  const snap = await getLatestSnapshot();
  const age = snap ? Date.now() - snap.at : Infinity;

  if (snap && age < STALE_MS) return json({ snapshot: snap, ageMs: age, revalidating: false });

  if (snap) {
    after(async () => { try { await runAnalysis(false); } catch { /* best effort */ } });
    return json({ snapshot: snap, ageMs: age, revalidating: true });
  }

  const fresh = await runAnalysis(false);
  return json({ snapshot: fresh, ageMs: 0, revalidating: false });
}
