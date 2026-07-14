import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Server-only Supabase client. Uses the service_role key so it can read the shared
// AI provider tables and write ma_* analyzer tables regardless of RLS. NEVER import
// this into a client component — the service key must never reach the browser.
let _client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
  if (!url || !key) throw new Error('SUPABASE_URL / key missing from environment');
  _client = createClient(url, key, { auth: { persistSession: false } });
  return _client;
}
