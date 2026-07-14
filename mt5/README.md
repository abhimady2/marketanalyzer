# MarketAnalyzerFeed — MT5 → Analyzer bridge

Pushes your broker's **real XAUUSD** live price + recent candles (M15/H1/H4/D1) to
the analyzer, which then prefers this over the Binance PAXG proxy.

## Install (once, on your VPS MT5)

1. Copy `MarketAnalyzerFeed.mq5` into your MT5 data folder:
   `File → Open Data Folder → MQL5 → Experts\`, then in **MetaEditor** press **F7** to compile.
2. **Whitelist the URL:** `Tools → Options → Expert Advisors →` tick
   **“Allow WebRequest for listed URL”** and add this origin:
   `https://marketanalyzer-amber.vercel.app`
3. Drag the EA onto **one** XAUUSD.sc chart. The inputs are **already preloaded**:
   - `InpServerUrl` = `https://marketanalyzer-amber.vercel.app/api/ingest` (preset)
   - `InpSecret` = `175f9d04bf47be063e9f946ded2fcff2` (matches the server `INGEST_SECRET`)
   - `InpSymbol` = `XAUUSD.sc` (Vantage gold — preset; blank uses the attached chart)
4. Enable **Algo Trading** (the toolbar button). Check the **Experts** tab log — you should see
   `MarketAnalyzerFeed started…` and no WebRequest errors.

## What it sends (every `InpTimerSec`, default 30s)

```json
{
  "secret": "…",
  "symbol": "XAUUSD",
  "price": { "bid": 2350.1, "ask": 2350.4, "last": 2350.2, "time": 1720000000000 },
  "candles": { "15m": [{ "t":…, "o":…, "h":…, "l":…, "c":…, "v":… }], "1h": […], "4h": […], "1d": […] }
}
```

## Freshness rules (server side)

- **Price** used if pushed within **90s**, else falls back to gold-api.com → Stooq → Binance.
- **Candles** used per-timeframe if pushed within **20 min**, else Binance PAXG for that timeframe.

So if the VPS stops, the site keeps working on public data — it just loses broker precision until the EA resumes.

## Troubleshooting

| Log message | Fix |
|---|---|
| `WebRequest failed (error 4014/5200/5203)` | URL not whitelisted — redo step 2 (add the **origin**, not the full path). |
| `Ingest returned HTTP 401` | `InpSecret` ≠ server `INGEST_SECRET`. |
| `Ingest returned HTTP 400` | No price/candles built — check the symbol name matches your broker. |
| Nothing in the log | Algo Trading disabled, or `InpTimerSec` not elapsed yet. |
