import type { NextRequest } from 'next/server';
import { getSupabase } from '@/lib/supabase';

// Receives the MT5 EA's live price + candles push and stores it as the ma_cache
// 'mt5:feed' row. The analyzer's candles.ts/price.ts prefer this when fresh.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function json(o: unknown, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
}

export async function POST(req: NextRequest) {
  const secret = process.env.INGEST_SECRET;
  if (!secret) return json({ error: 'server missing INGEST_SECRET' }, 500);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }

  const auth = req.headers.get('authorization') || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : body?.secret;
  if (provided !== secret) return json({ error: 'unauthorized' }, 401);

  if (!body?.price && !body?.candles && !body?.news) return json({ error: 'empty payload' }, 400);

  const payload = {
    symbol: String(body.symbol || 'XAUUSD'),
    price: body.price ?? null,
    candles: body.candles ?? null,
    news: Array.isArray(body.news) ? body.news : null,
    at: Date.now(),
  };

  const { error } = await getSupabase()
    .from('ma_cache')
    .upsert({ key: 'mt5:feed', payload, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) return json({ error: error.message }, 500);

  const tfs = payload.candles ? Object.keys(payload.candles) : [];
  return json({ ok: true, at: payload.at, symbol: payload.symbol, timeframes: tfs });
}
