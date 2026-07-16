// Live headlines for "what's happening now" (Fed speak, geopolitics, risk events)
// that move gold intraday. Source: Google News RSS search — free, no key. The AI
// layer parses these into a sentiment; here we just fetch and clean them.

export interface Headline { title: string; source: string; at: number; }

const QUERY = 'gold OR XAUUSD OR "federal reserve" OR inflation OR "interest rates" OR "safe haven"';

function pick(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  if (!m) return '';
  return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
}
function decode(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/<[^>]+>/g, '').trim();
}

export async function fetchHeadlines(limit = 18): Promise<Headline[]> {
  return googleNews(QUERY, limit);
}

// Generic Google-News RSS search — reused for per-event web research (free, no key).
export async function googleNews(query: string, limit = 12): Promise<Headline[]> {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { 'user-agent': 'Mozilla/5.0', accept: 'application/rss+xml, application/xml, text/xml' },
    });
    if (!r.ok) return [];
    const xml = await r.text();
    const items = xml.split('<item>').slice(1);
    const out: Headline[] = [];
    const seen = new Set<string>();
    for (const it of items) {
      const rawTitle = decode(pick(it, 'title'));
      // Google News titles end with " - Publisher"; keep headline, use publisher as source.
      const title = rawTitle.replace(/\s+-\s+[^-]+$/, '').trim();
      const source = decode(pick(it, 'source')) || rawTitle.match(/-\s+([^-]+)$/)?.[1]?.trim() || 'news';
      const pub = pick(it, 'pubDate');
      const at = pub ? +new Date(pub) : Date.now();
      if (!title || seen.has(title)) continue;
      seen.add(title);
      out.push({ title, source, at: Number.isFinite(at) ? at : Date.now() });
      if (out.length >= limit) break;
    }
    return out;
  } catch {
    return [];
  }
}
