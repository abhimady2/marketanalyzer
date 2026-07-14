# XAUUSD Market Analyzer

Gold (XAUUSD) direction engine: the **Mission Control** macro-regime indicator (ported from Pine to TypeScript) fused with **multi-timeframe technicals** (D1/H4/H1/M15) and **forex news** into one calibrated verdict — confidence, data-coverage %, and an AI-written "today / this week" outlook.

## How it works

- **Macro regime** (`src/lib/engine/regime.ts`) — faithful port of Mission Control v127.26: 4 buckets (Liquidity, Sentiment, Structural, Nuclear/AI) of threshold checks → 0–100 BULL/NEUTRAL/BEAR, plus the Liquidity Pulse z-score. Missing free-data checks degrade gracefully (coverage % is reported, never faked).
- **Technicals** (`src/lib/engine/technical.ts`) — EMA(20/50/200) alignment + RSI + MACD + ADX per timeframe, weighted D1>H4>H1>M15.
- **Fusion** (`src/lib/engine/fusion.ts`) — maps the gold-relevant macro signals (liquidity, dollar, rates, pulse) to a gold bias, blends with technicals, and lets news trim confidence.
- **News** — MT5 broker economic calendar (preferred) → ForexFactory fallback, plus live Google-News headlines parsed by a free AI model into a realistic sentiment.
- **AI** (`src/lib/ai.ts`) — routes over the shared Supabase pool of 200+ free models: ranks by `code_rank` tier, races models in waves, abandons any stalled/junk-body model instantly.
- **Data** (`src/lib/data/`) — FRED (liquidity, no key), CoinGecko + Binance (sentiment), Binance PAXG candles, gold-api.com spot. An **MT5 EA** (`mt5/`) can push real broker XAUUSD price + candles + calendar, which override the public feeds when fresh.

## Env (Vercel project settings)

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`, `INGEST_SECRET` — see `.env.example`.

## Refresh

Live price ~20s · technicals ~5min · macro verdict via on-visit revalidate + a daily Vercel cron + an optional GitHub Actions pinger (`.github/workflows/refresh.yml`) every 15 min (free, works on Vercel Hobby).

## MT5 feed

See [`mt5/README.md`](mt5/README.md) — copy the EA to your VPS MT5, whitelist the URL, set `INGEST_SECRET`.

Analytical research tool — not financial advice.
