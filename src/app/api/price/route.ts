import { fetchSpot } from '@/lib/data/price';

// Lightweight live-price endpoint the ticker polls (~20s). Prefers MT5, then
// gold-api → Stooq → Binance. CDN-cached 10s so polling never hammers upstream.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const spot = await fetchSpot();
  return new Response(JSON.stringify({ spot }), {
    status: spot ? 200 : 503,
    // Vercel-CDN-Cache-Control, not cache-control — Next overrides the latter on
    // force-dynamic routes, so this endpoint was never actually CDN-cached. See verdict route.
    headers: { 'content-type': 'application/json', 'Vercel-CDN-Cache-Control': 'max-age=10, stale-while-revalidate=30' },
  });
}
