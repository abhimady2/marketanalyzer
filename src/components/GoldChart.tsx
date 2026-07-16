'use client';
import type { Level } from '@/lib/engine/levels';

export interface Bar { t: number; o: number; h: number; l: number; c: number; }

// Inline-SVG M15 candlestick chart with the S/R structure drawn on it.
// No charting dependency: it's a fixed viewBox that scales to the container, so it
// stays sharp on mobile and adds ~0 to the bundle. Levels are drawn as ZONES (a band,
// not a line — that's what they actually are) with line weight/opacity carrying the
// level's STRENGTH, so a 95-strength wall visibly outranks a 37 one at a glance.
export default function GoldChart({ bars, levels, price }: { bars: Bar[]; levels: Level[]; price: number | null }) {
  if (!bars || bars.length < 5) {
    return <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>Waiting for M15 candles from the MT5 feed…</p>;
  }

  const W = 960, H = 360, padL = 6, padR = 74, padT = 12, padB = 24;
  const plotW = W - padL - padR, plotH = H - padT - padB;

  // Scale to the candles (not the levels) — a level $45 away would squash the price
  // action into a flat line. Far levels simply aren't drawn; the table below has them.
  let min = Math.min(...bars.map((b) => b.l));
  let max = Math.max(...bars.map((b) => b.h));
  if (price != null) { min = Math.min(min, price); max = Math.max(max, price); }
  const pad = (max - min) * 0.08 || 1;
  min -= pad; max += pad;

  const y = (p: number) => padT + ((max - p) / (max - min)) * plotH;
  const x = (i: number) => padL + (i / Math.max(1, bars.length - 1)) * plotW;
  const cw = Math.max(1.6, (plotW / bars.length) * 0.62);

  const visible = levels
    .filter((l) => l.price >= min && l.price <= max)
    .sort((a, b) => b.price - a.price);

  // Skip a label if it would collide with the one above it.
  let lastLabelY = -99;
  const gridSteps = 4;

  return (
    <div className="chart-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} className="gchart" preserveAspectRatio="none" role="img"
           aria-label="XAUUSD 15-minute chart with support and resistance levels">
        {/* price grid */}
        {Array.from({ length: gridSteps + 1 }, (_, i) => {
          const p = min + ((max - min) * i) / gridSteps;
          return (
            <g key={`g${i}`}>
              <line x1={padL} x2={padL + plotW} y1={y(p)} y2={y(p)} className="ch-grid" />
              <text x={padL + plotW + 6} y={y(p) + 3} className="ch-axis">{p.toFixed(2)}</text>
            </g>
          );
        })}

        {/* S/R zones — band + strength-weighted centre line */}
        {visible.map((l, i) => {
          const res = l.kind === 'resistance';
          const col = res ? 'var(--bear)' : 'var(--bull)';
          const top = y(Math.min(max, l.high)), bot = y(Math.max(min, l.low));
          const s = l.strength / 100;
          const showLabel = Math.abs(y(l.price) - lastLabelY) > 13;
          if (showLabel) lastLabelY = y(l.price);
          return (
            <g key={`l${i}`}>
              <rect x={padL} y={top} width={plotW} height={Math.max(1.5, bot - top)}
                    fill={col} opacity={0.05 + s * 0.10} />
              <line x1={padL} x2={padL + plotW} y1={y(l.price)} y2={y(l.price)}
                    stroke={col} strokeWidth={0.6 + s * 1.8} opacity={0.3 + s * 0.5}
                    strokeDasharray={l.strength >= 70 ? undefined : '5 4'} />
              {showLabel && (
                <text x={padL + plotW + 6} y={y(l.price) + 3} className="ch-lvl" fill={col}>
                  {l.price.toFixed(2)} · {l.strength}
                </text>
              )}
            </g>
          );
        })}

        {/* candles */}
        {bars.map((b, i) => {
          const up = b.c >= b.o;
          const col = up ? 'var(--bull)' : 'var(--bear)';
          const bodyTop = y(Math.max(b.o, b.c));
          const bodyH = Math.max(1, Math.abs(y(b.o) - y(b.c)));
          return (
            <g key={`c${i}`}>
              <line x1={x(i)} x2={x(i)} y1={y(b.h)} y2={y(b.l)} stroke={col} strokeWidth="1" opacity="0.85" />
              <rect x={x(i) - cw / 2} y={bodyTop} width={cw} height={bodyH} fill={col} opacity="0.95" />
            </g>
          );
        })}

        {/* live price */}
        {price != null && (
          <g>
            <line x1={padL} x2={padL + plotW} y1={y(price)} y2={y(price)} className="ch-price" />
            <rect x={padL + plotW + 2} y={y(price) - 8} width={70} height={16} rx="3" fill="var(--gold)" />
            <text x={padL + plotW + 7} y={y(price) + 4} className="ch-price-tag">{price.toFixed(2)}</text>
          </g>
        )}

        {/* time axis */}
        {[0, Math.floor(bars.length / 2), bars.length - 1].map((i, k) => (
          <text key={`t${k}`} x={x(i)} y={H - 6} className="ch-axis"
                textAnchor={k === 0 ? 'start' : k === 2 ? 'end' : 'middle'}>
            {new Date(bars[i].t).toUTCString().slice(17, 22)}
          </text>
        ))}
      </svg>
      <div className="ch-legend">
        <span><i className="k-res" /> Resistance</span>
        <span><i className="k-sup" /> Support</span>
        <span><i className="k-px" /> Live price</span>
        <span className="ch-note">Band = the zone · line weight = strength · dashed = weaker (&lt;70)</span>
      </div>
    </div>
  );
}
