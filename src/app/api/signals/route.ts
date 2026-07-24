import type { NextRequest } from 'next/server';
import { getLatestSnapshot, runAnalysis } from '@/lib/engine/analyze';
import { readSignals } from '@/lib/engine/signals';

// Signal feed for the Trading Intelligence paper-trader (it polls this outbound, so no
// inbound hop into the VPS is needed). Refreshes the snapshot when stale first, so the
// poller doubles as a keep-warm pinger AND signals are emitted even with no site traffic.
//   GET /api/signals?since=<ms>&key=<CRON_SECRET>
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const STALE_MS = 8 * 1000;
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const url = new URL(req.url);
  const auth = req.headers.get('authorization') || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : url.searchParams.get('key');
  if (secret && provided !== secret) return new Response('Unauthorized', { status: 401 });

  // Keep the engine warm so signals fire on schedule regardless of web traffic.
  // refreshNarrative=false: this heartbeat must stay fast — it only needs price + the reversal
  // signal, never the AI narrative, whose free-model call was ReadTimeout-ing the gold poller.
  const snap = await getLatestSnapshot();
  const fresh = snap && Date.now() - snap.at < STALE_MS ? snap : await runAnalysis(false, false);

  const since = Number(url.searchParams.get('since') || 0);
  const signals = await readSignals(Number.isFinite(since) ? since : 0, 50);

  return json({
    serverTime: Date.now(),
    signals,
    scalp: { state: fresh.scalp.state, confidence: fresh.scalp.confidence, reason: fresh.scalp.reason },
    price: fresh.verdict.spot?.price ?? null,
  });
}
