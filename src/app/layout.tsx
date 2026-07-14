import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'XAUUSD Market Analyzer — Macro Regime + Trend Verdict',
  description:
    'Gold (XAUUSD) direction engine: macro liquidity regime fused with multi-timeframe technicals and forex news.',
};

export const viewport: Viewport = {
  themeColor: '#0a0e1a',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
