// TEMP diagnostic — is FRED reachable from the deploy region, and how slow?
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET() {
  const key = process.env.FRED_API_KEY || '';
  const region = process.env.VERCEL_REGION || 'unknown';
  const start = Date.now();
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 50000);
  try {
    const r = await fetch(`https://api.stlouisfed.org/fred/series/observations?series_id=WALCL&api_key=${key}&file_type=json&observation_start=2026-06-01`, { signal: c.signal });
    const ms = Date.now() - start;
    const j: any = await r.json();
    return Response.json({ region, keySet: !!key, ms, status: r.status, obs: (j.observations || []).length, latest: (j.observations || []).slice(-1)[0]?.value });
  } catch (e: any) {
    return Response.json({ region, keySet: !!key, ms: Date.now() - start, error: String(e?.message || e) });
  } finally { clearTimeout(t); }
}
