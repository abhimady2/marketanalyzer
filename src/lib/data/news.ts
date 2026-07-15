// Economic calendar. Prefers the MT5 broker calendar pushed by the EA (real
// broker data, incl. actual values); falls back to the free ForexFactory weekly
// JSON. Gold (USD-priced) reacts most to high-impact USD events.
import { readMt5Feed } from './mt5';

export interface NewsEvent {
  title: string;
  country: string;      // currency code, e.g. USD
  impact: 'High' | 'Medium' | 'Low' | 'Holiday' | string;
  date: string;        // ISO
  forecast: string;
  previous: string;
  actual?: string;
  goldRelevant: boolean;
}

export interface NewsResult {
  events: NewsEvent[];
  upcomingHighUSD: NewsEvent[];
  eventRiskSoon: boolean;      // High-impact USD event within the next 24h
  source: 'mt5' | 'forexfactory' | 'none';
  at: number;
}

const FEED = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';

function normalize(raw: any[], now: number, source: NewsResult['source']): NewsResult {
  // Show only events still ahead (with a 30-min grace so a just-released print with
  // its actual lingers briefly) — never yesterday's finished events.
  const GRACE_MS = 30 * 60 * 1000;
  const events: NewsEvent[] = raw.map((e) => {
    const country = String(e.country || '').toUpperCase();
    const impact = String(e.impact || 'Low');
    const iso = typeof e.date === 'number' ? new Date(e.date).toISOString() : String(e.date || '');
    const goldRelevant = (country === 'USD' && (impact === 'High' || impact === 'Medium')) || impact === 'High';
    return {
      title: String(e.title || ''), country, impact, date: iso,
      forecast: String(e.forecast ?? ''), previous: String(e.previous ?? ''),
      actual: e.actual != null ? String(e.actual) : undefined, goldRelevant,
    };
  }).filter((e) => e.goldRelevant && e.date && +new Date(e.date) >= now - GRACE_MS);

  events.sort((a, b) => +new Date(a.date) - +new Date(b.date));
  const upcomingHighUSD = events.filter((e) => e.country === 'USD' && e.impact === 'High' && +new Date(e.date) >= now);
  const eventRiskSoon = upcomingHighUSD.some((e) => +new Date(e.date) - now < 24 * 3600 * 1000);
  return { events, upcomingHighUSD, eventRiskSoon, source, at: now };
}

export async function fetchNews(now = Date.now()): Promise<NewsResult> {
  // 1) MT5 broker calendar (fresh within 6h → the EA pushes every ~30s).
  try {
    const feed = await readMt5Feed();
    if (feed?.news && feed.news.length && feed.ageMs < 6 * 3600 * 1000) {
      const r = normalize(feed.news, now, 'mt5');
      if (r.events.length) return r;
    }
  } catch { /* fall through */ }

  // 2) ForexFactory weekly JSON (free, no key).
  try {
    const res = await fetch(FEED, { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } });
    if (res.ok) {
      const raw = await res.json();
      if (Array.isArray(raw)) return normalize(raw, now, 'forexfactory');
    }
  } catch { /* fall through */ }

  return { events: [], upcomingHighUSD: [], eventRiskSoon: false, source: 'none', at: now };
}
