'use client';
import { useEffect, useState } from 'react';
import type { Snapshot } from '@/lib/engine/analyze';
import PriceTicker from './PriceTicker';

const dirClass = (d: string) => d === 'Bullish' ? 'bull-t' : d === 'Bearish' ? 'bear-t' : d === 'Neutral' ? 'neutral-t' : 'unknown-t';
const dirColor = (d: string) => d === 'Bullish' ? 'var(--bull)' : d === 'Bearish' ? 'var(--bear)' : d === 'Neutral' ? 'var(--neutral)' : 'var(--text-muted)';
const scoreClass = (s: number | null) => s == null ? 'unknown-t' : s >= 80 ? 'bull-t' : s >= 50 ? 'neutral-t' : 'bear-t';
const scoreColor = (s: number | null) => s == null ? 'var(--text-muted)' : s >= 80 ? 'var(--bull)' : s >= 50 ? 'var(--neutral)' : 'var(--bear)';
const regimeChip = (r: string) => r === 'BULL' ? 'bull' : r === 'BEAR' ? 'bear' : r === 'NEUTRAL' ? 'neutral' : '';
const labelChip = (l: string) => l === 'Bullish' ? 'bull' : l === 'Bearish' ? 'bear' : 'neutral';
const barColor = (b: number) => b > 0.15 ? 'var(--bull)' : b < -0.15 ? 'var(--bear)' : 'var(--neutral)';
const fmtWhen = (iso: string) => { const d = new Date(iso); return isNaN(+d) ? '' : d.toUTCString().slice(0, 22) + ' UTC'; };
const agoStr = (ms: number) => { const m = Math.round(ms / 60000); return m < 1 ? 'now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };
const countdown = (iso: string, now: number | null) => {
  if (now == null) return '';
  const ms = +new Date(iso) - now;
  if (Number.isNaN(ms)) return '';
  if (ms < 0) return 'live';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `in ${mins}m`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return h < 24 ? `in ${h}h${m ? ` ${m}m` : ''}` : `in ${Math.round(h / 24)}d`;
};

function Sparkline({ data }: { data: number[] }) {
  if (!data || data.length < 2) return null;
  const w = 132, h = 36, min = Math.min(...data), max = Math.max(...data), rng = max - min || 1;
  const pts = data.map((v, i) => [(i / (data.length - 1)) * w, h - ((v - min) / rng) * (h - 4) - 2] as const);
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  const up = data[data.length - 1] >= data[0];
  const col = up ? 'var(--bull)' : 'var(--bear)';
  const [lx, ly] = pts[pts.length - 1];
  return (
    <svg className="spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
      <path d={`${path} L ${w} ${h} L 0 ${h} Z`} fill={col} opacity="0.09" />
      <path d={path} fill="none" stroke={col} strokeWidth="1.6" strokeLinejoin="round" />
      <circle cx={lx} cy={ly} r="2.8" fill={col} className="spark-dot" />
    </svg>
  );
}

function Gauge({ value, color }: { value: number; color: string }) {
  const r = 46, cx = 55, cy = 52, frac = Math.max(0, Math.min(100, value)) / 100;
  const end = Math.PI - frac * Math.PI;
  const ex = cx + Math.cos(end) * r, ey = cy - Math.sin(end) * r;
  const nx = cx + Math.cos(end) * (r - 6), ny = cy - Math.sin(end) * (r - 6);
  return (
    <svg viewBox="0 0 110 62" className="gauge" width="118" height="66" aria-hidden>
      <path d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`} fill="none" stroke="var(--border)" strokeWidth="6" strokeLinecap="round" />
      <path d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${ex} ${ey}`} fill="none" stroke={color} strokeWidth="6" strokeLinecap="round" className="gauge-arc" />
      <line x1={cx} y1={cy} x2={nx} y2={ny} stroke={color} strokeWidth="2.6" strokeLinecap="round" className="gauge-needle" />
      <circle cx={cx} cy={cy} r="3.6" fill={color} />
    </svg>
  );
}

export default function Dashboard({ initial }: { initial: Snapshot }) {
  const [snap, setSnap] = useState<Snapshot>(initial);
  const [now, setNow] = useState<number | null>(null);
  const [flash, setFlash] = useState(false);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const r = await fetch('/api/verdict', { cache: 'no-store' });
        const j = await r.json();
        if (alive && j?.snapshot?.at) setSnap((prev) => (j.snapshot.at !== prev.at ? j.snapshot : prev));
      } catch { /* keep last */ }
    };
    const id = setInterval(poll, 15000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  useEffect(() => { setNow(Date.now()); const id = setInterval(() => setNow(Date.now()), 5000); return () => clearInterval(id); }, []);
  useEffect(() => { setFlash(true); const id = setTimeout(() => setFlash(false), 800); return () => clearTimeout(id); }, [snap.at]);

  const { verdict: v, regime: r, technical: t, news: n, narrative } = snap;
  const ageSecs = now != null ? Math.max(0, Math.round((now - snap.at) / 1000)) : null;
  const markerPos = ((Math.max(-1, Math.min(1, v.bias)) + 1) / 2) * 100;

  return (
    <main className="container">
      <div className="topbar">
        <div className="brand">
          <span className="kicker">XAU · USD · GOLD</span>
          <h1>Market <b>Analyzer</b></h1>
        </div>
        <div className="topright">
          <div className="price-wrap">
            <PriceTicker initial={v.spot} />
            <Sparkline data={snap.spark} />
          </div>
          <span className="live-badge"><i className="live-dot" /> LIVE{ageSecs != null ? ` · ${ageSecs < 60 ? `${ageSecs}s` : agoStr(now! - snap.at)} ago` : ''}</span>
        </div>
      </div>

      {/* VERDICT HERO */}
      <section className={`card hero${flash ? ' flash' : ''}`} style={{ marginTop: 18 }}>
        <div className="hero-row">
          <div>
            <div className={`dir ${dirClass(v.direction)}`}>{v.grade}</div>
            <div className="sub">{narrative?.headline ?? `Gold outlook — macro ${r.regime}, technicals ${t.label}`}</div>
          </div>
          <div className="conf">
            <Gauge value={v.confidence} color={dirColor(v.direction)} />
            <div className="conf-num" style={{ color: dirColor(v.direction) }}>{v.confidence}%</div>
            <div className="lbl">Confidence</div>
          </div>
        </div>
        <div className="meter">
          <div className="track"><span className="mid" /><span className="marker" style={{ left: `${markerPos}%`, background: barColor(v.bias) }} /></div>
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

      {/* NARRATIVE */}
      <section className="card narr" style={{ marginTop: 16 }}>
        <h2>What to expect</h2>
        {narrative ? (
          <>
            <p className="headline">{narrative.headline}</p>
            <p><span className="tag">Today</span>{narrative.today}</p>
            <p><span className="tag">This week</span>{narrative.week}</p>
          </>
        ) : (
          <p>{`XAUUSD ${v.spot ? `at $${v.spot.price.toFixed(2)}` : ''}. Macro ${r.regime}, technicals ${t.label}, ${v.agreement}. Narrative refreshes on the next run.`}</p>
        )}
      </section>

      {/* LIVE MARKET PULSE */}
      {(narrative?.live || snap.headlines.length > 0) && (
        <section className="card" style={{ marginTop: 16 }}>
          <h2>Live Market Pulse{narrative?.live && <span className={`chip ${labelChip(narrative.live.label)}`}>{narrative.live.label} · {narrative.live.impact} impact</span>}</h2>
          {narrative?.live && <p style={{ color: 'var(--text-dim)', fontSize: 14.5, lineHeight: 1.6, marginBottom: snap.headlines.length ? 14 : 0 }}>{narrative.live.summary}</p>}
          {snap.headlines.slice(0, 6).map((h, i) => (
            <div className="hl" key={i}>
              <span className="hl-t">{h.title}</span>
              <span className="hl-m">{h.source}{now != null ? ` · ${agoStr(now - h.at)}` : ''}</span>
            </div>
          ))}
        </section>
      )}

      <div className="grid cols-2">
        {/* TECHNICALS */}
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

        {/* MACRO */}
        <section className="card">
          <h2>Macro Regime · Mission Control</h2>
          {r.buckets.map((b) => (
            <details className="bucket" key={b.key}>
              <summary>
                <span className="b-name">{b.icon} {b.label}</span>
                <span className="b-right">
                  <span className="b-bar"><i style={{ width: `${b.score ?? 0}%`, background: scoreColor(b.score) }} /></span>
                  <span className={`b-score ${scoreClass(b.score)}`}>{b.score != null ? `${b.score}%` : 'n/a'}</span>
                </span>
              </summary>
              <div className="checks">
                {b.checks.map((c) => (
                  <div className="check" key={c.key}>
                    <span className="cl">{c.label}</span><span className="cv">{c.value}</span>
                    <span className={`st ${!c.available ? 'na' : c.risk ? 'risk' : 'ok'}`}>{!c.available ? 'N/A' : c.risk ? 'RISK' : 'OK'}</span>
                  </div>
                ))}
              </div>
            </details>
          ))}
        </section>
      </div>

      {/* NEWS */}
      <section className="card" style={{ marginTop: 16 }}>
        <h2>High-Impact Forex News {n.eventRiskSoon && <span className="chip warn">Event within 24h</span>}</h2>
        {n.events.length === 0 && <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>No high-impact events (or feed unavailable).</p>}
        {n.events.map((e: any, i: number) => (
          <div className="ev" key={i}>
            <span className={`impact-badge imp-${(e.impact || 'Low')}`}>{e.impact || 'Low'} Impact</span>
            <span><span className="t">{e.title}</span><div className="when">{fmtWhen(e.date)}{e.forecast ? ` · fc ${e.forecast}` : ''}{e.previous ? ` · prev ${e.previous}` : ''}{e.actual ? ` · act ${e.actual}` : ''}</div></span>
            <span className="ev-right"><span className="cd">{countdown(e.date, now)}</span><span className="cc">{e.country}</span></span>
          </div>
        ))}
      </section>

      {/* CAUTIONS */}
      {v.cautions.length > 0 && (
        <section className="card" style={{ marginTop: 16 }}>
          <h2>Calibration Notes</h2>
          <ul className="cautions">{v.cautions.map((c, i) => <li key={i}>{c}</li>)}</ul>
        </section>
      )}

      <footer className="foot">
        <div className="srcs">Sources: MT5 (Vantage XAUUSD.sc) · FRED · CoinGecko · Yahoo · ForexFactory · gold-api.com</div>
        <div>Macro coverage {Math.round(r.coverage * 100)}%<span className="dot">•</span>compute {snap.computeMs}ms{narrative?.source && narrative.source !== 'fallback' ? <><span className="dot">•</span>AI {narrative.source}</> : null}</div>
        <div style={{ marginTop: 6, opacity: .7 }}>Analytical tool for research — not financial advice. Markets carry risk.</div>
      </footer>
    </main>
  );
}
