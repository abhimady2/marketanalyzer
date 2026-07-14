import { getLatestSnapshot, runAnalysis, type Snapshot } from '@/lib/engine/analyze';
import PriceTicker from '@/components/PriceTicker';
import AutoRefresh from '@/components/AutoRefresh';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 60;

const dirClass = (d: string) => d === 'Bullish' ? 'bull-t' : d === 'Bearish' ? 'bear-t' : d === 'Neutral' ? 'neutral-t' : 'unknown-t';
const scoreClass = (s: number | null) => s == null ? 'unknown-t' : s >= 80 ? 'bull-t' : s >= 50 ? 'neutral-t' : 'bear-t';
const regimeChip = (r: string) => r === 'BULL' ? 'bull' : r === 'BEAR' ? 'bear' : r === 'NEUTRAL' ? 'neutral' : '';
const labelChip = (l: string) => l === 'Bullish' ? 'bull' : l === 'Bearish' ? 'bear' : 'neutral';
const barColor = (b: number) => b > 0.15 ? 'var(--bull)' : b < -0.15 ? 'var(--bear)' : 'var(--neutral)';
const fmtWhen = (iso: string) => { const d = new Date(iso); return isNaN(+d) ? '' : d.toUTCString().slice(0, 22) + ' UTC'; };
const agoStr = (at: number) => { const m = Math.round((Date.now() - at) / 60000); return m < 1 ? 'now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };

export default async function Home() {
  const snap: Snapshot = (await getLatestSnapshot()) ?? (await runAnalysis(false));
  const { verdict: v, regime: r, technical: t, news: n, narrative } = snap;
  const ageMin = Math.max(0, Math.round((Date.now() - snap.at) / 60000));
  const markerPos = ((Math.max(-1, Math.min(1, v.bias)) + 1) / 2) * 100;

  return (
    <main className="container">
      <AutoRefresh seconds={120} />

      <div className="topbar">
        <div className="brand">
          <span className="kicker">XAU · USD · GOLD</span>
          <h1>Market <b>Analyzer</b></h1>
        </div>
        <PriceTicker initial={v.spot} />
      </div>

      {/* ── VERDICT HERO ── */}
      <section className="card hero" style={{ marginTop: 18 }}>
        <div className="hero-row">
          <div>
            <div className={`dir ${dirClass(v.direction)}`}>{v.direction}</div>
            <div className="sub">
              {narrative?.headline ?? `Gold outlook — macro ${r.regime}, technicals ${t.label}`}
            </div>
          </div>
          <div className="conf">
            <div className={`num ${v.confidence >= 60 ? 'bull-t' : v.confidence >= 35 ? 'neutral-t' : 'bear-t'}`}>{v.confidence}%</div>
            <div className="lbl">Confidence</div>
          </div>
        </div>

        <div className="meter">
          <div className="track">
            <span className="mid" />
            <span className="marker" style={{ left: `${markerPos}%`, background: barColor(v.bias) }} />
          </div>
          <div className="scale"><span>Bearish</span><span>Neutral</span><span>Bullish</span></div>
        </div>

        <div className="chips">
          <span className={`chip ${regimeChip(r.regime)}`}>Macro <b>{r.regime}{r.total != null ? ` ${r.total}` : ''}</b></span>
          <span className={`chip ${labelChip(t.label)}`}>Technicals <b>{t.label}</b></span>
          <span className={`chip ${v.agreement === 'divergent' ? 'warn' : ''}`}>{v.agreement === 'divergent' ? 'Divergent' : v.agreement === 'aligned' ? 'Aligned' : 'Partial'}</span>
          {r.pulse.value != null && <span className="chip">Liq Pulse <b>{r.pulse.value.toFixed(2)}σ</b></span>}
          <span className="chip">Coverage <b>{Math.round(r.coverage * 100)}%</b></span>
        </div>
      </section>

      {/* ── NARRATIVE ── */}
      <section className="card narr" style={{ marginTop: 16 }}>
        <h2>What to expect</h2>
        {narrative ? (
          <>
            <p className="headline">{narrative.headline}</p>
            <p><span className="tag">Today</span>{narrative.today}</p>
            <p><span className="tag">This week</span>{narrative.week}</p>
          </>
        ) : (
          <p>{`XAUUSD ${v.spot ? `at $${v.spot.price.toFixed(2)}` : ''}. Macro regime ${r.regime}, technicals ${t.label}, ${v.agreement}. Narrative refreshes on the next scheduled run.`}</p>
        )}
      </section>

      {/* ── LIVE MARKET PULSE ── */}
      {(narrative?.live || snap.headlines.length > 0) && (
        <section className="card" style={{ marginTop: 16 }}>
          <h2>
            Live Market Pulse
            {narrative?.live && (
              <span className={`chip ${labelChip(narrative.live.label)}`} style={{ marginLeft: 8 }}>
                {narrative.live.label} · {narrative.live.impact} impact
              </span>
            )}
          </h2>
          {narrative?.live && (
            <p style={{ color: 'var(--text-dim)', fontSize: 14.5, lineHeight: 1.6, marginBottom: snap.headlines.length ? 14 : 0 }}>
              {narrative.live.summary}
            </p>
          )}
          {snap.headlines.slice(0, 6).map((h, i) => (
            <div className="hl" key={i}>
              <span className="hl-t">{h.title}</span>
              <span className="hl-m">{h.source} · {agoStr(h.at)}</span>
            </div>
          ))}
        </section>
      )}

      <div className="grid cols-2">
        {/* ── MULTI-TIMEFRAME TECHNICALS ── */}
        <section className="card">
          <h2>Timeframe Trend</h2>
          {t.timeframes.map((tf) => (
            <div className="tf-row" key={tf.tf}>
              <span className="tf">{tf.tf.toUpperCase()}</span>
              <div>
                <span className={`chip ${labelChip(tf.label)}`} style={{ padding: '3px 9px' }}>{tf.available ? tf.label : 'No data'}</span>
                {tf.available && tf.signals.length > 0 && <div className="sig">{tf.signals.slice(0, 3).join(' · ')}</div>}
              </div>
              <div className="adx">
                <span className="bar"><i style={{ width: `${Math.min(100, ((tf.strength ?? 0) / 40) * 100)}%` }} /></span>
                <span className="val">ADX {tf.strength != null ? tf.strength.toFixed(0) : '—'}</span>
              </div>
            </div>
          ))}
        </section>

        {/* ── MACRO REGIME (Mission Control) ── */}
        <section className="card">
          <h2>Macro Regime · Mission Control</h2>
          {r.buckets.map((b) => (
            <details className="bucket" key={b.key}>
              <summary>
                <span className="b-name">{b.icon} {b.label}</span>
                <span>
                  <span className={`b-score ${scoreClass(b.score)}`}>{b.score != null ? `${b.score}%` : 'n/a'}</span>
                  <span className="cov"> · {Math.round(b.coverage * 100)}% cov</span>
                </span>
              </summary>
              <div className="checks">
                {b.checks.map((c) => (
                  <div className="check" key={c.key}>
                    <span className="cl">{c.label}</span>
                    <span className="cv">{c.value}</span>
                    <span className={`st ${!c.available ? 'na' : c.risk ? 'risk' : 'ok'}`}>{!c.available ? 'N/A' : c.risk ? 'RISK' : 'OK'}</span>
                  </div>
                ))}
              </div>
            </details>
          ))}
        </section>
      </div>

      {/* ── NEWS ── */}
      <section className="card" style={{ marginTop: 16 }}>
        <h2>High-Impact Forex News {n.eventRiskSoon && <span className="chip warn" style={{ marginLeft: 8 }}>Event within 24h</span>}</h2>
        {n.events.length === 0 && <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>No high-impact events this week (or feed unavailable).</p>}
        {n.events.map((e: any, i: number) => (
          <div className="ev" key={i}>
            <span className={`imp ${e.impact}`} />
            <span>
              <span className="t">{e.title}</span>
              <div className="when">{fmtWhen(e.date)}{e.forecast ? ` · forecast ${e.forecast}` : ''}{e.previous ? ` · prev ${e.previous}` : ''}</div>
            </span>
            <span className="cc">{e.country}</span>
          </div>
        ))}
      </section>

      {/* ── CAUTIONS ── */}
      {v.cautions.length > 0 && (
        <section className="card" style={{ marginTop: 16 }}>
          <h2>Calibration Notes</h2>
          <ul className="cautions">{v.cautions.map((c, i) => <li key={i}>{c}</li>)}</ul>
        </section>
      )}

      <footer className="foot">
        <div className="srcs">
          Sources: MT5 (Vantage XAUUSD.sc) · FRED · CoinGecko · Binance · ForexFactory · gold-api.com
        </div>
        <div>
          Macro coverage {Math.round(r.coverage * 100)}%<span className="dot">•</span>
          updated {ageMin === 0 ? 'just now' : `${ageMin}m ago`}<span className="dot">•</span>
          compute {snap.computeMs}ms{narrative?.source && narrative.source !== 'fallback' ? <><span className="dot">•</span>AI {narrative.source}</> : null}
        </div>
        <div style={{ marginTop: 6, opacity: .7 }}>
          Analytical tool for research — not financial advice. Markets carry risk.
        </div>
      </footer>
    </main>
  );
}
