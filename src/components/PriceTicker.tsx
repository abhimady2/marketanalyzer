'use client';
import { useEffect, useState } from 'react';

interface Spot { price: number; changePct: number | null; source: string; }

export default function PriceTicker({ initial }: { initial: Spot | null }) {
  const [spot, setSpot] = useState<Spot | null>(initial);
  useEffect(() => {
    let live = true;
    const tick = async () => {
      if (document.hidden) return;   // ponytail: don't poll a tab nobody is looking at
      try {
        const r = await fetch('/api/price', { cache: 'no-store' });
        const j = await r.json();
        if (live && j.spot) setSpot(j.spot);
      } catch { /* keep last */ }
    };
    tick();
    const id = setInterval(tick, 10000);
    document.addEventListener('visibilitychange', tick);
    return () => { live = false; clearInterval(id); document.removeEventListener('visibilitychange', tick); };
  }, []);

  if (!spot) return <span className="price">—</span>;
  const up = (spot.changePct ?? 0) >= 0;
  return (
    <span className="price mono">
      ${spot.price.toFixed(2)}
      {spot.changePct != null && (
        <em className={up ? 'up' : 'down'}>{up ? '▲' : '▼'} {Math.abs(spot.changePct).toFixed(2)}%</em>
      )}
      <small>{spot.source}</small>
    </span>
  );
}
