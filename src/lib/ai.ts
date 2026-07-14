// Free-model AI transport over the shared Supabase model pool (228+ healthy models
// across ~20 OpenAI-compatible providers). Strategy (per user spec + hyper-falcon
// router lessons):
//   • rank by code_rank (S/A/B tier) then historical latency — best, fastest first
//   • race models in concurrent WAVES; first valid reply wins
//   • any model that stalls/errors is abandoned instantly (8s cap), cooled ~60s, and
//     replaced by the next — no retry, no looping on a dead model
//   • universal User-Agent (free routers like agentrouter gate on it)
//   • reasoning models: the answer is in message.content; empty content = fail over
//     (don't surface reasoning_content thinking as the answer); <think> stripped
// SERVER-ONLY (uses service_role Supabase).

import { getSupabase } from './supabase';

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string; }
export interface AIResult { text: string; model: string; provider: string; latency: number; }

const looksSlow = (name: string) =>
  /(^|[^a-z])(r1|reasoner|reasoning|qwq|o1|o3|deepseek-r|step-|stepfun|laguna)([^a-z]|$)/i.test(name) || /think|reason/i.test(name);

function stripThink(t: string): string {
  return t.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '').replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '').trim();
}

// Free routers often return an HTTP-200 body that is actually a quota/paywall
// notice ("abuse of free resources… recharge… /topup") instead of a completion.
// Treat these as a failure so we fail over past the model, not surface the junk.
function isJunkBody(t: string): boolean {
  const s = t.toLowerCase();
  return s.includes('free quota') || s.includes('free resources') || s.includes('/topup')
    || s.includes('insufficient balance') || s.includes('insufficient credits') || s.includes('out of credits')
    || s.includes('abuse of free') || s.includes('free promotion has ended') || s.includes('requires a subscription')
    || s.includes('upgrade for access') || s.includes('unavailable for free') || s.includes('add credits to continue')
    || (s.includes('recharg') && s.includes('quota'));
}

// Google's generativelanguage endpoint needs /openai inserted; others are plain.
function completionsUrl(baseUrl: string): string {
  const b = String(baseUrl).replace(/\/+$/, '');
  return /generativelanguage/i.test(b) ? `${b}/openai/chat/completions` : `${b}/chat/completions`;
}

function headersFor(url: string, key: string): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${key}`,
    // Several free "public-welfare" routers (agentrouter…) gate by User-Agent and
    // reject a generic client; standard OpenAI APIs ignore it, so send it everywhere.
    'User-Agent': 'claude-cli/1.0.0 (external, cli)',
  };
  if (url.includes('openrouter.ai')) { h['HTTP-Referer'] = 'https://marketanalyzer.vercel.app'; h['X-Title'] = 'XAUUSD Market Analyzer'; }
  return h;
}

// Warm-instance per-model cooldown so a just-failed model is skipped, not re-hit.
const modelCooldown = new Map<string, number>();
const COOLDOWN_MS = 60_000;

export async function aiComplete(
  messages: ChatMessage[],
  opts: { temperature?: number; maxTokens?: number; perModelMs?: number; deadlineMs?: number; wave?: number } = {},
): Promise<AIResult> {
  const { temperature = 0.5, maxTokens = 1000, perModelMs = 8000, deadlineMs = 30000, wave = 4 } = opts;
  const sb = getSupabase();
  const deadline = Date.now() + deadlineMs;

  const [{ data: modelsData }, { data: keysData }] = await Promise.all([
    sb.from('models').select('id, model_name, status, priority, code_rank, latency_ms, providers ( id, name, base_url, api_key, is_active )')
      .eq('is_active', true).eq('providers.is_active', true),
    sb.from('provider_keys').select('provider_id, api_key, cooldown_until, is_active, status').eq('is_active', true).neq('status', 'invalid'),
  ]);

  const all = (modelsData || [])
    .map((m: any) => ({ id: m.id, name: m.model_name, status: m.status, priority: m.priority ?? 1, code_rank: m.code_rank ?? 99, latency: m.latency_ms ?? 9999, provider: m.providers }))
    .filter((m: any) => m.provider);
  if (all.length === 0) throw new Error('No active AI models in shared Supabase');

  const now = Date.now();
  const pool = new Map<string, string[]>();
  for (const k of keysData || []) {
    const cd = k.cooldown_until ? +new Date(k.cooldown_until) : 0;
    if (cd > now) continue;
    if (!pool.has(k.provider_id)) pool.set(k.provider_id, []);
    pool.get(k.provider_id)!.push(k.api_key);
  }
  const keyFor = (p: any): string | null => (pool.get(p.id)?.[0]) || p.api_key || null;

  // Best-first: healthy → tier (code_rank) → fast-instruct → historical latency → priority.
  all.sort((a: any, b: any) => {
    if ((a.status === 'healthy') !== (b.status === 'healthy')) return a.status === 'healthy' ? -1 : 1;
    if (a.code_rank !== b.code_rank) return a.code_rank - b.code_rank;
    const as = looksSlow(a.name) ? 1 : 0, bs = looksSlow(b.name) ? 1 : 0;
    if (as !== bs) return as - bs;
    if (a.latency !== b.latency) return a.latency - b.latency;
    return a.priority - b.priority;
  });

  // Skip models cooling from a recent failure (fall back to full list if all cooling).
  const hot = all.filter((m: any) => (modelCooldown.get(m.id) ?? 0) <= now);
  const models = hot.length >= wave ? hot : all;

  const tryOne = async (m: any): Promise<AIResult> => {
    const key = keyFor(m.provider);
    if (!key) throw new Error('no key');
    const url = completionsUrl(m.provider.base_url);
    const budget = deadline - Date.now();
    if (budget < 1500) throw new Error('deadline');
    const start = Date.now();
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: headersFor(url, key),
        body: JSON.stringify({ model: m.name, messages, temperature, max_tokens: maxTokens }),
        signal: AbortSignal.timeout(Math.min(perModelMs, budget)),
      });
      if (!r.ok) throw new Error(`${m.provider.name}/${m.name} HTTP ${r.status}`);
      const j: any = await r.json();
      const msg = j?.choices?.[0]?.message;
      const text = stripThink((msg?.content || '').trim()); // reasoning_content is thinking, not the answer
      if (!text) throw new Error(`${m.provider.name}/${m.name} empty/reasoning-only`);
      if (isJunkBody(text)) throw new Error(`${m.provider.name}/${m.name} quota/paywall body`);
      return { text, model: m.name, provider: m.provider.name, latency: Date.now() - start };
    } catch (e) {
      modelCooldown.set(m.id, Date.now() + COOLDOWN_MS);
      throw e;
    }
  };

  // Race models in waves; first valid reply wins, stalled ones die at perModelMs.
  let lastErr = 'no models tried';
  for (let i = 0; i < models.length && Date.now() < deadline; i += wave) {
    const attempts = models.slice(i, i + wave).map((m: any) => tryOne(m));
    attempts.forEach((p: Promise<AIResult>) => p.catch(() => {}));
    const winner = await Promise.any(attempts).then((r) => r, () => null);
    if (winner) return winner;
    lastErr = `waves through ${i + wave} failed`;
  }
  throw new Error(`All AI models failed (${lastErr})`);
}
