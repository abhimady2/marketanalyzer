import type { NextRequest } from 'next/server';
import { runAnalysis } from '@/lib/engine/analyze';

// Full recompute WITH the AI narrative. Called by the Vercel daily cron (which
// auto-sends Authorization: Bearer $CRON_SECRET) and by the GitHub Actions pinger
// (?key=… or Bearer). Also usable to warm the cache manually.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get('authorization') || '';
  const key = new URL(req.url).searchParams.get('key');
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : key;
  if (secret && provided !== secret) return new Response('Unauthorized', { status: 401 });

  const s = await runAnalysis(true);
  return new Response(JSON.stringify({
    ok: true, direction: s.verdict.direction, confidence: s.verdict.confidence,
    macroRegime: s.regime.regime, coverage: +(s.verdict.coverage * 100).toFixed(0),
    at: s.at, computeMs: s.computeMs,
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}
