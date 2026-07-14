import { fetchSpot } from '@/lib/data/price';

// Lightweight live-price endpoint the ticker polls (~20s). Prefers MT5, then
// gold-api → Stooq → Binance. CDN-cached 10s so polling never hammers upstream.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const spot = await fetchSpot();
  return new Response(JSON.stringify({ spot }), {
    status: spot ? 200 : 503,
    headers: { 'content-type': 'application/json', 'cache-control': 's-maxage=10, stale-while-revalidate=30' },
  });
}
