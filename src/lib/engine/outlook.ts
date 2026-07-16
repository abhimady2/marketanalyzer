// "What could happen" — a per-event playbook for the next high-impact release.
//
// Deliberately NOT speculation: it is grounded in (a) the broker calendar's own
// consensus vs previous, (b) real web coverage of that specific release pulled at
// runtime (Google News RSS, free), and (c) the standard USD→gold transmission
// (hot US data → hawkish → gold down; soft → dovish → gold up). A free AI model
// reads that evidence and returns a LEAN + scenario map.
//
// Honesty: the outcome of an unreleased print is unknowable, so `probability` is
// confidence in the LEAN, never a guarantee — and the SCENARIO MAP (if beat → X,
// if miss → Y) is the part a trader should actually act on. Reliability + sources
// are always surfaced. If the AI is unavailable we still show the scenario map
// with no lean rather than inventing one.

import { aiComplete } from '@/lib/ai';
import { googleNews } from '@/lib/data/headlines';

export interface EventOutlook {
  event: string; when: string; country: string; impact: string;
  consensus: string; previous: string;
  lean: 'pump' | 'dump' | 'chop';
  probability: number;              // confidence in the lean (0..100)
  magnitude: string;                // typical gold move, e.g. "$3-8"
  scenarios: { condition: string; reaction: string }[];
  rationale: string;
  sources: string[];
  reliability: 'low' | 'medium' | 'high';
  aiSource: string;
  at: number;
}

export interface OutlookEvent { title: string; country: string; impact: string; date: string; forecast: string; previous: string; }
export interface GoldCtx { price: number | null; macroBias: number | null; technical: string; resistance: number | null; support: number | null; }

function parseJson(text: string): any {
  let t = text.trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  try { return JSON.parse(t); } catch { return null; }
}
const cleanTitle = (t: string) => t.replace(/\b(m\/m|y\/y|q\/q|n\.s\.a\.)\b/gi, '').replace(/\s+/g, ' ').trim();

// Deterministic scenario map from the standard USD→gold transmission. Always valid,
// never invented — used as-is when the AI can't be reached.
function baseScenarios(ev: OutlookEvent): { condition: string; reaction: string }[] {
  const jobless = /jobless|unemployment/i.test(ev.title); // inverted: higher claims = weaker economy
  const up = jobless ? 'above' : 'below';
  return [
    { condition: `Beat (data ${jobless ? 'below' : 'above'} ${ev.forecast || 'forecast'})`, reaction: 'Hawkish → yields/USD up → gold DOWN' },
    { condition: `Miss (data ${up} ${ev.forecast || 'forecast'})`, reaction: 'Dovish → yields/USD down → gold UP' },
    { condition: 'In line with consensus', reaction: 'Muted — spike likely faded; expect chop' },
  ];
}

function fallback(ev: OutlookEvent, sources: string[]): EventOutlook {
  return {
    event: ev.title, when: ev.date, country: ev.country, impact: ev.impact,
    consensus: ev.forecast || '—', previous: ev.previous || '—',
    lean: 'chop', probability: 50, magnitude: '—',
    scenarios: baseScenarios(ev),
    rationale: 'No AI read available — showing the standard USD→gold reaction map only. Trade the reaction, not a prediction.',
    sources, reliability: 'low', aiSource: 'fallback', at: Date.now(),
  };
}

export async function generateEventOutlook(ev: OutlookEvent, ctx: GoldCtx): Promise<EventOutlook> {
  // 1) Pull real web coverage of THIS release.
  const q = `${cleanTitle(ev.title)} ${ev.country} forecast expectations preview gold`;
  const research = await googleNews(q, 10).catch(() => []);
  const sources = [...new Set(research.map((h) => h.source))].slice(0, 6);

  if (!research.length) return fallback(ev, sources);

  try {
    const sys = 'You are a gold (XAUUSD) event analyst. Ground every claim ONLY in the supplied consensus/previous and the web headlines. Standard transmission: hotter-than-expected US data → hawkish → gold DOWN; softer → dovish → gold UP; in-line → muted/fade. (Jobless claims invert: higher claims = weaker economy = gold UP.) The outcome of an unreleased print is UNKNOWABLE — so "probability" is your confidence in the directional LEAN only; if the web gives no clear steer, answer "chop" with probability 50-60. Never invent sources or numbers. Output ONLY JSON.';
    const user = `Event: ${ev.title} (${ev.country}, ${ev.impact} impact) at ${ev.date}
Consensus: ${ev.forecast || 'n/a'} | Previous: ${ev.previous || 'n/a'}
Gold context: price ${ctx.price ?? 'n/a'}, macro bias ${ctx.macroBias ?? 'n/a'}, technicals ${ctx.technical}, nearest resistance ${ctx.resistance ?? 'n/a'}, nearest support ${ctx.support ?? 'n/a'}
Recent web coverage of this release:
${research.map((h) => `- ${h.title} (${h.source})`).join('\n')}

Respond with ONLY this JSON:
{"lean":"pump|dump|chop","probability":<integer 0-100, confidence in the lean>,"magnitude":"typical gold move e.g. $3-8","scenarios":[{"condition":"Beat (> consensus)","reaction":"..."},{"condition":"Miss (< consensus)","reaction":"..."},{"condition":"In line","reaction":"..."}],"rationale":"2 sentences citing what the consensus gap and the headlines imply for gold","sources":["publisher names you actually used"],"reliability":"low|medium|high"}`;

    const r = await aiComplete([{ role: 'system', content: sys }, { role: 'user', content: user }], { temperature: 0.4, maxTokens: 700, deadlineMs: 30000 });
    const p = parseJson(r.text);
    if (p && typeof p.rationale === 'string') {
      const lean: EventOutlook['lean'] = p.lean === 'pump' || p.lean === 'dump' ? p.lean : 'chop';
      const prob = Math.max(0, Math.min(100, Math.round(Number(p.probability) || 50)));
      const scen = Array.isArray(p.scenarios) && p.scenarios.length
        ? p.scenarios.slice(0, 3).map((s: any) => ({ condition: String(s.condition || ''), reaction: String(s.reaction || '') }))
        : baseScenarios(ev);
      return {
        event: ev.title, when: ev.date, country: ev.country, impact: ev.impact,
        consensus: ev.forecast || '—', previous: ev.previous || '—',
        lean, probability: prob, magnitude: String(p.magnitude || '—'),
        scenarios: scen, rationale: String(p.rationale),
        sources: Array.isArray(p.sources) && p.sources.length ? p.sources.slice(0, 6).map(String) : sources,
        reliability: p.reliability === 'high' || p.reliability === 'medium' ? p.reliability : 'low',
        aiSource: `${r.provider}/${r.model}`, at: Date.now(),
      };
    }
  } catch { /* fall through */ }
  return fallback(ev, sources);
}
