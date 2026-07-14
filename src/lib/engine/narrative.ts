// AI narrative + live-headline parsing in ONE free-model call. Turns the computed
// numbers + live headlines into a "today / this week" outlook and a headline
// sentiment. Always returns something — a deterministic fallback if models are down.

import { aiComplete } from '@/lib/ai';
import type { Verdict } from './fusion';
import type { RegimeResult } from './regime';
import type { TechnicalResult } from './technical';
import type { NewsResult } from '@/lib/data/news';
import type { Headline } from '@/lib/data/headlines';

export interface LiveSentiment { label: 'Bullish' | 'Bearish' | 'Neutral'; impact: 'High' | 'Medium' | 'Low'; summary: string; }
export interface Narrative { headline: string; today: string; week: string; live: LiveSentiment; source: string; }

function parseJson(text: string): any {
  let t = text.trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  try { return JSON.parse(t); } catch { return null; }
}
const asLabel = (x: any): LiveSentiment['label'] => x === 'Bullish' || x === 'Bearish' ? x : 'Neutral';
const asImpact = (x: any): LiveSentiment['impact'] => x === 'High' || x === 'Medium' ? x : 'Low';

function buildFallback(v: Verdict, macro: RegimeResult, tech: TechnicalResult, news: NewsResult, headlines: Headline[]): Narrative {
  const tfBits = tech.timeframes.filter((t) => t.available).map((t) => `${t.tf} ${t.label.toLowerCase()}`).join(', ');
  const price = v.spot ? `$${v.spot.price.toFixed(2)}` : 'current levels';
  const nextEv = news.upcomingHighUSD[0];
  return {
    headline: `Gold ${v.direction} — ${v.confidence}% confidence`,
    today: `XAUUSD is ${price}. Multi-timeframe read: ${tfBits || 'insufficient candle data'}. ` +
      `${v.agreement === 'divergent' ? 'Macro and technicals disagree, so expect two-way trade.' : 'Macro and technicals broadly agree.'}`,
    week: `Macro regime is ${macro.regime}${macro.total != null ? ` (${macro.total}/100)` : ''}; ` +
      `liquidity/dollar/rates lean ${v.goldMacroBias != null && v.goldMacroBias > 0 ? 'gold-supportive' : v.goldMacroBias != null ? 'gold-negative' : 'neutral'}. ` +
      `${nextEv ? `Watch ${nextEv.title} (${new Date(nextEv.date).toUTCString().slice(0, 16)} UTC).` : 'No high-impact USD events imminent.'}`,
    live: { label: 'Neutral', impact: 'Low', summary: headlines.length ? `${headlines.length} live headlines pending AI parse.` : 'No live headlines available.' },
    source: 'fallback',
  };
}

export async function generateNarrative(
  v: Verdict, macro: RegimeResult, tech: TechnicalResult, news: NewsResult, headlines: Headline[],
): Promise<Narrative> {
  const fallback = buildFallback(v, macro, tech, news, headlines);
  const facts = {
    direction: v.direction, bias: +v.bias.toFixed(2), confidence: v.confidence,
    goldMacroBias: v.goldMacroBias, technicalBias: v.technicalBias, agreement: v.agreement,
    macroRegime: macro.regime, macroScore: macro.total, dataCoverage: +(macro.coverage * 100).toFixed(0),
    signals: macro.signals, pulse: macro.pulse.value,
    timeframes: tech.timeframes.filter((t) => t.available).map((t) => ({ tf: t.tf, trend: t.label, adx: t.strength ? +t.strength.toFixed(0) : null })),
    spot: v.spot ? +v.spot.price.toFixed(2) : null,
    upcomingUSDNews: news.upcomingHighUSD.slice(0, 4).map((e) => ({ title: e.title, when: e.date })),
    liveHeadlines: headlines.slice(0, 12).map((h) => h.title),
  };
  try {
    const sys = 'You are a precise gold (XAUUSD) macro analyst. Be concise, factual, grounded ONLY in the supplied data and headlines. No hype, no disclaimers, no invented price levels. Judge live headlines realistically — most are noise; only flag real gold-moving developments. Output ONLY JSON.';
    const user = `Computed analysis + live headlines:\n${JSON.stringify(facts)}\n\nRespond with ONLY this JSON:\n{"headline":"<=90 chars verdict phrase","today":"2-3 sentences on today","week":"2-3 sentences on the week ahead","live":{"label":"Bullish|Bearish|Neutral","impact":"High|Medium|Low","summary":"1-2 sentences on what the live headlines mean for gold right now"}}`;
    const r = await aiComplete([{ role: 'system', content: sys }, { role: 'user', content: user }], { temperature: 0.5, maxTokens: 700, deadlineMs: 30000 });
    const p = parseJson(r.text);
    if (p && typeof p.today === 'string' && p.today.length > 10) {
      return {
        headline: typeof p.headline === 'string' && p.headline ? p.headline : fallback.headline,
        today: p.today,
        week: typeof p.week === 'string' && p.week ? p.week : fallback.week,
        live: p.live && typeof p.live === 'object'
          ? { label: asLabel(p.live.label), impact: asImpact(p.live.impact), summary: String(p.live.summary || fallback.live.summary) }
          : fallback.live,
        source: `${r.provider}/${r.model}`,
      };
    }
  } catch { /* fall through */ }
  return fallback;
}
