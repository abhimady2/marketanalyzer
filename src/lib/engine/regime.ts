// ============================================================================
// Mission Control v127.26 — macro regime engine, ported from Pine to TypeScript.
//
// Faithful to the original scoring: 4 buckets of binary risk checks, each bucket
// score = (checks_passing / checks_available) * 100, total = mean of buckets,
// regime = BULL >=80 / BEAR <=40 / NEUTRAL. Plus the Liquidity Pulse z-score
// nowcast (structural + stablecoin impulse + inverted DXY, ALMA-smoothed).
//
// DEVIATION FROM PINE (deliberate, "modify it to work with our project"):
// TradingView feeds every input from its own data. From free APIs some inputs
// (quarterly capex, MU inventory, uranium term premium) can't be sourced. So a
// check whose inputs are missing is marked available:false and EXCLUDED from
// both numerator and denominator — never faked. Coverage % is reported so a
// thin-data verdict is visible, not silently wrong.
// ============================================================================

export type Regime = 'BULL' | 'NEUTRAL' | 'BEAR' | 'UNKNOWN';

export interface Thresholds {
  th_alpha: number;   // Liquidity Alpha limit (%)      default -0.8
  th_beta: number;    // Liquidity Beta limit (%)       default 0.0
  th_debt: number;    // Debt Wall limit (10Y ROC %)    default 4.5
  th_tga_chg: number; // TGA drain limit ($B)           default 50
  th_pulse_c: number; // Pulse flash-crash sigma        default -1.5
  th_stable: number;  // Stablecoin flight limit (%)    default 5.0
  th_alt: number;     // Altcoin euphoria limit (%)     default 55.0
  th_sput: number;    // Spot vs term premium (%)       default 20.0
  factor_u: number;   // SRUUF unit conversion          default 3.40
  th_urnm: number;    // Miners vs SPY ROC (%)          default 15.0
  th_aicorr: number;  // AI/Power correlation min       default 0.6
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  th_alpha: -0.8, th_beta: 0.0, th_debt: 4.5, th_tga_chg: 50,
  th_pulse_c: -1.5, th_stable: 5.0, th_alt: 55.0, th_sput: 20.0,
  factor_u: 3.4, th_urnm: 15.0, th_aicorr: 0.6,
};

// Every raw input the engine needs. Points are `number | null` (null = the free
// feed couldn't supply it → dependent checks degrade). Series are oldest→newest.
export interface RegimeInputs {
  // — Liquidity (monthly points, US $B unless noted) —
  fedNow: number | null; fedPrevM: number | null;       // FRED WALCL
  tgaNow: number | null; tgaPrevM: number | null;       // FRED WDTGAL
  rrpNow: number | null; rrpPrevM: number | null;       // FRED RRPONTSYD
  stablesNow: number | null; stablesPrevM: number | null; // total stablecoin mcap $B
  dxyNow: number | null; dxy7dAgo: number | null; dxy21dAgo: number | null;
  us2Now: number | null; us2_7dAgo: number | null; us2_21dAgo: number | null;
  us10Now: number | null; us10_21dAgo: number | null;
  // Global M2 in USD, $T
  cnNow: number | null; cnPrevM: number | null;
  euNow: number | null; euPrevM: number | null;
  jpNow: number | null; jpPrevM: number | null;
  // — Liquidity Pulse daily series (oldest→newest, ~100 pts; $B) —
  fedDaily?: number[]; tgaDaily?: number[]; rrpDaily?: number[];
  stablesDaily?: number[]; dxyDaily?: number[];
  // — Sentiment —
  stableDomNow: number | null; stableDom7dAgo: number | null; // stablecoin dominance %
  total3Now: number | null; total3_7dAgo: number | null;      // alt mcap (ex top)
  coinNow: number | null; coinPrev1d: number | null;
  btcNow: number | null; btcPrev1d: number | null;
  ethbtcNow: number | null; ethbtc7dAgo: number | null;
  // — Structural —
  capexBuyersNow: number | null; capexBuyersPrevQ: number | null; capexBuyersPrevY: number | null;
  nvdaCapexNow: number | null; nvdaCapexPrevY: number | null;
  muInvNow: number | null; muInv65Ago: number | null;
  pmi: number | null;
  digestNow: number | null; digestSma: number | null; digestPrev: number | null;   // ANET/NVDA
  fabNow: number | null; fabSma: number | null; fabPrev: number | null;            // WFE/SPY
  // — Nuclear & AI power —
  sruuf: number | null; ux1: number | null;
  urnmNow: number | null; urnm21dAgo: number | null; urnmVol: number | null; urnmVolAvg: number | null;
  spyNow: number | null; spy21dAgo: number | null;
  leuNow: number | null; leuSma20w: number | null;
  aiCorr: number | null; vstNow: number | null; vstSma20: number | null;
  utilNow: number | null; utilSma: number | null; utilPrev: number | null;         // VST/XLU
}

export interface Check {
  key: string;
  label: string;
  value: string;      // formatted for display
  risk: boolean;      // true = risk-on flag ("bad")
  available: boolean; // false = inputs missing, excluded from score
  method: string;
}

export interface Bucket {
  key: string;
  label: string;
  icon: string;
  score: number | null;   // % over available checks
  regime: Regime;
  coverage: number;       // available / total
  checks: Check[];
}

export interface PulseResult {
  value: number | null;
  prev: number | null;
  crash: boolean;
  bad: boolean;
  available: boolean;
}

export interface RegimeResult {
  total: number | null;
  regime: Regime;
  buckets: Bucket[];
  pulse: PulseResult;
  coverage: number;       // overall available / total checks
  thresholds: Thresholds;
  // Raw gold-relevant signals the fusion layer maps to a gold bias (higher net
  // liquidity + weaker dollar + falling yields = bullish gold).
  signals: {
    liquidityScore: number | null; // liquidity bucket score 0..100
    betaUs: number | null;         // US net-liquidity ROC %
    liqAlpha: number | null;       // liquidity minus dollar/rate friction %
    y10Roc: number | null;         // 10Y yield ROC % (rising = bearish gold)
    dxyRoc21: number | null;       // dollar-index ROC % (rising = bearish gold)
    pulse: number | null;          // liquidity pulse z-score
  };
}

// ── math helpers ────────────────────────────────────────────────────────────
const has = (...xs: (number | null | undefined)[]) => xs.every((x) => x != null && !Number.isNaN(x as number));
const roc = (now: number, old: number) => (old !== 0 ? ((now - old) / old) * 100 : 0);
const fmt = (x: number, d = 2) => x.toFixed(d);

function mean(a: number[]): number { return a.reduce((s, x) => s + x, 0) / a.length; }
function stdev(a: number[]): number {
  const m = mean(a);
  return Math.sqrt(mean(a.map((x) => (x - m) ** 2)));
}
// z-score of the last value against a trailing window of length `len`.
function zscoreLast(series: number[], len: number): number | null {
  if (series.length < len) return null;
  const w = series.slice(series.length - len);
  const s = stdev(w);
  return (series[series.length - 1] - mean(w)) / (s !== 0 ? s : 1);
}
// ALMA over the last `window` values (oldest→newest), matching Pine ta.alma.
function alma(values: number[], window: number, offset: number, sigma: number): number | null {
  if (values.length < window) return null;
  const m = offset * (window - 1);
  const s = window / sigma;
  let sum = 0, norm = 0;
  const base = values.length - window;
  for (let i = 0; i < window; i++) {
    const w = Math.exp(-((i - m) ** 2) / (2 * s * s));
    norm += w;
    sum += values[base + i] * w; // i=window-1 → newest, matching series[window-1-i] weighting
  }
  return sum / norm;
}

function bucketScore(checks: Check[]): { score: number | null; coverage: number } {
  const avail = checks.filter((c) => c.available);
  if (avail.length === 0) return { score: null, coverage: 0 };
  const passing = avail.filter((c) => !c.risk).length;
  return { score: Math.round((passing / avail.length) * 100), coverage: avail.length / checks.length };
}

function regimeOf(score: number | null): Regime {
  if (score == null) return 'UNKNOWN';
  return score >= 80 ? 'BULL' : score <= 40 ? 'BEAR' : 'NEUTRAL';
}

// ── the engine ──────────────────────────────────────────────────────────────
export function computeRegime(inp: RegimeInputs, t: Thresholds = DEFAULT_THRESHOLDS): RegimeResult {
  // — LIQUIDITY —
  const usLiq = has(inp.fedNow, inp.tgaNow, inp.rrpNow, inp.stablesNow)
    ? { now: inp.fedNow! - inp.tgaNow! - inp.rrpNow! + inp.stablesNow! } : null;
  const usLiqOld = has(inp.fedPrevM, inp.tgaPrevM, inp.rrpPrevM, inp.stablesPrevM)
    ? inp.fedPrevM! - inp.tgaPrevM! - inp.rrpPrevM! + inp.stablesPrevM! : null;
  const betaUs = usLiq && usLiqOld != null ? roc(usLiq.now, usLiqOld) : null;

  const glNow = has(inp.cnNow, inp.euNow, inp.jpNow) ? inp.cnNow! + inp.euNow! + inp.jpNow! : null;
  const glOld = has(inp.cnPrevM, inp.euPrevM, inp.jpPrevM) ? inp.cnPrevM! + inp.euPrevM! + inp.jpPrevM! : null;
  const betaGlobal = glNow != null && glOld != null ? roc(glNow, glOld) : null;

  const rocDxy21 = has(inp.dxyNow, inp.dxy21dAgo) ? roc(inp.dxyNow!, inp.dxy21dAgo!) : null;
  const rocU2_21 = has(inp.us2Now, inp.us2_21dAgo) ? roc(inp.us2Now!, inp.us2_21dAgo!) : null;
  const frictionStd = rocDxy21 != null && rocU2_21 != null ? rocDxy21 + rocU2_21 : null;
  const liqBeta = betaUs != null && betaGlobal != null ? betaUs * 0.6 + betaGlobal * 0.4 : null;
  const liqAlpha = liqBeta != null && frictionStd != null ? liqBeta - frictionStd : null;
  const y10Roc = has(inp.us10Now, inp.us10_21dAgo) ? roc(inp.us10Now!, inp.us10_21dAgo!) : null;
  const tgaFlux = has(inp.tgaNow, inp.tgaPrevM) ? inp.tgaNow! - inp.tgaPrevM! : null;

  const liqChecks: Check[] = [
    mk('tga', 'TGA Liquidity Flux', tgaFlux, (v) => v > t.th_tga_chg, (v) => `${v > 0 ? '+' : ''}${fmt(v, 1)}B`, 'Ledger Change'),
    mk('beta_us', 'Liquidity Beta (US)', betaUs, (v) => v < t.th_beta, (v) => `${fmt(v)}%`, 'Monthly'),
    mk('alpha', 'Liquidity Alpha (Global)', liqAlpha, (v) => v < t.th_alpha, (v) => `${fmt(v)}%`, 'Rolling 21d'),
    mk('debt', 'Debt Wall (10Y)', y10Roc, (v) => v > t.th_debt, (v) => `${fmt(v, 1)}%`, 'Rolling 21d'),
    mk('global', 'Liquidity Beta (Global)', betaGlobal, (v) => v < 0, (v) => `${fmt(v)}%`, 'Monthly'),
  ];

  // — SENTIMENT —
  const stableD5 = has(inp.stableDomNow, inp.stableDom7dAgo) ? roc(inp.stableDomNow!, inp.stableDom7dAgo!) : null;
  const altRoc = has(inp.total3Now, inp.total3_7dAgo) ? roc(inp.total3Now!, inp.total3_7dAgo!) : null;
  const ethBtcRoc = has(inp.ethbtcNow, inp.ethbtc7dAgo) ? roc(inp.ethbtcNow!, inp.ethbtc7dAgo!) : null;
  const fomo = has(inp.coinNow, inp.btcNow) && inp.btcNow !== 0 ? (inp.coinNow! / inp.btcNow!) * 1000 : null;
  const fomoH = has(inp.coinPrev1d, inp.btcPrev1d) && inp.btcPrev1d !== 0 ? (inp.coinPrev1d! / inp.btcPrev1d!) * 1000 * 1.2 : null;

  const sentChecks: Check[] = [
    mk('stable_flight', 'Stablecoin Flight', stableD5, (v) => v > t.th_stable, (v) => `${fmt(v)}%`, 'Rolling 7d %'),
    mk('eth_btc', 'ETH Strength vs BTC', ethBtcRoc, (v) => v < -1.5, (v) => `${fmt(v)}%`, 'Rolling 7d'),
    mk('alt_euphoria', 'Altcoin Euphoria', altRoc, (v) => v > t.th_alt, (v) => `${fmt(v)}%`, 'Rolling 7d'),
    mkPair('fomo', 'Retail FOMO', fomo, fomoH, (v, h) => v > h, (v) => fmt(v), 'Live Ratio'),
  ];

  // — STRUCTURAL —
  const capexYoY = has(inp.capexBuyersNow, inp.capexBuyersPrevY) ? roc(inp.capexBuyersNow!, inp.capexBuyersPrevY!) : null;
  const capexQoQ = has(inp.capexBuyersNow, inp.capexBuyersPrevQ) ? roc(inp.capexBuyersNow!, inp.capexBuyersPrevQ!) : null;
  const nvdaYoY = has(inp.nvdaCapexNow, inp.nvdaCapexPrevY) ? roc(inp.nvdaCapexNow!, inp.nvdaCapexPrevY!) : null;
  const muRisk = has(inp.muInvNow, inp.muInv65Ago) ? inp.muInvNow! > inp.muInv65Ago! * 1.05 : null;
  const pmiRisk = inp.pmi != null ? inp.pmi > 58 : null;
  const digest = ratioCheck(inp.digestNow, inp.digestSma, inp.digestPrev);
  const fab = ratioCheck(inp.fabNow, inp.fabSma, inp.fabPrev);

  const strChecks: Check[] = [
    mk('capex_yoy', 'AI Capex (Buyers) YoY', capexYoY, (v) => v < 25, (v) => `${fmt(v, 0)}%`, 'Quarterly'),
    mk('capex_qoq', 'AI Capex (Buyers) QoQ', capexQoQ, (v) => v < 2, (v) => `${fmt(v, 0)}%`, 'Quarterly'),
    mk('nvda_yoy', 'AI Supply Health YoY', nvdaYoY, (v) => v < 20, (v) => `${fmt(v, 0)}%`, 'Quarterly'),
    mkBool('mu', 'RAM Stockpile', muRisk, inp.muInvNow != null ? `${fmt(inp.muInvNow, 0)}d` : '—', 'Quarterly'),
    mkBool('pmi', 'PMI Manufacturing', pmiRisk, inp.pmi != null ? fmt(inp.pmi, 1) : '—', 'Monthly'),
    mkBool('digestion', 'Digestion (ANET/NVDA)', digest.risk, inp.digestNow != null ? fmt(inp.digestNow) : '—', 'Trend / Flash Crash'),
    mkBool('fab', 'Fab Tool Strength (WFE/SPY)', fab.risk, inp.fabNow != null ? fmt(inp.fabNow) : '—', 'Trend / Flash Crash'),
  ];

  // — NUCLEAR & AI POWER —
  const uSpread = has(inp.sruuf, inp.ux1) && inp.ux1 !== 0 ? roc(inp.sruuf! * t.factor_u, inp.ux1!) : null;
  const rsRatio = has(inp.urnmNow, inp.spyNow) && inp.spyNow !== 0 ? inp.urnmNow! / inp.spyNow! : null;
  const rsRatioPrev = has(inp.urnm21dAgo, inp.spy21dAgo) && inp.spy21dAgo !== 0 ? inp.urnm21dAgo! / inp.spy21dAgo! : null;
  const rsRoc = rsRatio != null && rsRatioPrev != null ? roc(rsRatio, rsRatioPrev) : null;
  const volWeak = has(inp.urnmVol, inp.urnmVolAvg) ? inp.urnmVol! < inp.urnmVolAvg! : null;
  const urnmRisk = rsRoc != null && volWeak != null ? rsRoc > t.th_urnm && volWeak : null;
  const leuRisk = has(inp.leuNow, inp.leuSma20w) ? inp.leuNow! < inp.leuSma20w! : null;
  const aiRisk = has(inp.aiCorr, inp.vstNow, inp.vstSma20) ? inp.aiCorr! < t.th_aicorr && inp.vstNow! < inp.vstSma20! : null;
  const util = ratioCheck(inp.utilNow, inp.utilSma, inp.utilPrev);

  const nucChecks: Check[] = [
    mk('sput', 'Spot Premium (SPUT vs Term)', uSpread, (v) => v > t.th_sput, (v) => `${fmt(v, 1)}%`, 'Daily Spread'),
    mkBool('urnm', 'Retail Divergence (Vol Filter)', urnmRisk, rsRoc != null ? `${fmt(rsRoc, 1)}%` : '—', '21d ROC Ratio'),
    mkBool('leu', 'Enrichment Trend (LEU)', leuRisk, leuRisk == null ? '—' : leuRisk ? 'BREAKDOWN' : 'HOLDING', 'vs 20W SMA'),
    mkBool('ai_power', 'AI/Power Robust (60d Corr)', aiRisk, inp.aiCorr != null ? fmt(inp.aiCorr) : '—', '60d + Trend Filter'),
    mkBool('util', 'Utility Premium (VST/XLU)', util.risk, inp.utilNow != null ? fmt(inp.utilNow) : '—', 'Trend / Flash Crash'),
  ];

  const buckets: Bucket[] = [
    buildBucket('liquidity', 'LIQUIDITY', '🌊', liqChecks),
    buildBucket('sentiment', 'SENTIMENT', '🧠', sentChecks),
    buildBucket('structural', 'STRUCTURAL', '🏗️', strChecks),
    buildBucket('nuclear', 'NUCLEAR & AI POWER', '☢️', nucChecks),
  ];

  const scored = buckets.map((b) => b.score).filter((s): s is number => s != null);
  const total = scored.length ? Math.round(mean(scored)) : null;
  const allChecks = buckets.flatMap((b) => b.checks);
  const coverage = allChecks.filter((c) => c.available).length / allChecks.length;
  const pulse = computePulse(inp, t);

  return {
    total,
    regime: regimeOf(total),
    buckets,
    pulse,
    coverage,
    thresholds: t,
    signals: {
      liquidityScore: buckets.find((b) => b.key === 'liquidity')!.score,
      betaUs,
      liqAlpha,
      y10Roc,
      dxyRoc21: rocDxy21,
      pulse: pulse.value,
    },
  };
}

// Liquidity Pulse: net-liquidity z-score + stablecoin impulse + inverted DXY,
// ALMA(9, 0.85, 6) smoothed. Needs the daily series; degrades if too short.
function computePulse(inp: RegimeInputs, t: Thresholds): PulseResult {
  const off: PulseResult = { value: null, prev: null, crash: false, bad: false, available: false };
  const { fedDaily, tgaDaily, rrpDaily, stablesDaily, dxyDaily } = inp;
  if (!fedDaily || !tgaDaily || !rrpDaily || !stablesDaily || !dxyDaily) return off;
  const n = Math.min(fedDaily.length, tgaDaily.length, rrpDaily.length, stablesDaily.length, dxyDaily.length);
  if (n < 95) return off; // need 90 window + a few bars for ALMA/prev

  const netLiq: number[] = [];
  for (let i = 0; i < n; i++) netLiq.push(fedDaily[i] - tgaDaily[i] - rrpDaily[i] + stablesDaily[i]);
  const stables = stablesDaily.slice(stablesDaily.length - n);
  const dxy = dxyDaily.slice(dxyDaily.length - n);

  // pulse_raw for the last (window+1) bars so ALMA has a value at t and t-1.
  const WINDOW = 9, BARS = WINDOW + 1;
  const pulseRaw: number[] = [];
  for (let b = n - BARS; b < n; b++) {
    const struct = zscoreLast(netLiq.slice(0, b + 1), 90);
    // stablecoin 3d ROC series → zscore(20)
    const rocSeries: number[] = [];
    for (let k = 3; k <= b; k++) rocSeries.push(stables[k - 3] !== 0 ? ((stables[k] - stables[k - 3]) / stables[k - 3]) * 100 : 0);
    const impulse = zscoreLast(rocSeries, 20);
    // dxy 5d ROC (inverted) series → zscore(20)
    const dxyRoc: number[] = [];
    for (let k = 5; k <= b; k++) dxyRoc.push(dxy[k - 5] !== 0 ? -((dxy[k] - dxy[k - 5]) / dxy[k - 5]) * 100 : 0);
    const dxyZ = zscoreLast(dxyRoc, 20);
    if (struct == null || impulse == null || dxyZ == null) return off;
    pulseRaw.push(0.4 * struct + 0.4 * impulse + 0.2 * dxyZ);
  }
  const value = alma(pulseRaw, WINDOW, 0.85, 6);
  const prev = alma(pulseRaw.slice(0, pulseRaw.length - 1), WINDOW, 0.85, 6);
  if (value == null) return off;
  const crash = prev != null && value - prev < t.th_pulse_c;
  return { value, prev, crash, bad: value < -0.5 || crash, available: true };
}

// ── check builders ──────────────────────────────────────────────────────────
function mk(key: string, label: string, v: number | null, isRisk: (v: number) => boolean, show: (v: number) => string, method: string): Check {
  if (v == null || Number.isNaN(v)) return { key, label, value: '—', risk: false, available: false, method };
  return { key, label, value: show(v), risk: isRisk(v), available: true, method };
}
function mkPair(key: string, label: string, v: number | null, h: number | null, isRisk: (v: number, h: number) => boolean, show: (v: number) => string, method: string): Check {
  if (v == null || h == null || Number.isNaN(v) || Number.isNaN(h)) return { key, label, value: '—', risk: false, available: false, method };
  return { key, label, value: show(v), risk: isRisk(v, h), available: true, method };
}
function mkBool(key: string, label: string, risk: boolean | null, value: string, method: string): Check {
  if (risk == null) return { key, label, value: '—', risk: false, available: false, method };
  return { key, label, value, risk, available: true, method };
}
// ANET/NVDA-style: risk if ratio below its SMA OR dropped >2.5% vs prev bar.
function ratioCheck(now: number | null, sma: number | null, prev: number | null): { risk: boolean | null } {
  if (!has(now, sma, prev)) return { risk: null };
  const drop = prev !== 0 ? (now! - prev!) / prev! : 0;
  return { risk: now! < sma! || drop < -0.025 };
}
function buildBucket(key: string, label: string, icon: string, checks: Check[]): Bucket {
  const { score, coverage } = bucketScore(checks);
  return { key, label, icon, score, regime: regimeOf(score), coverage, checks };
}

// ── self-check (run: npx tsx src/lib/engine/regime.ts) ────────────────────────
export function demo(): void {
  const assert = (c: boolean, m: string) => { if (!c) throw new Error('FAIL: ' + m); };

  // All checks passing → liquidity 100, healthy macro. Only supply liquidity+sentiment.
  const bull: RegimeInputs = blank();
  bull.fedNow = 7000; bull.fedPrevM = 6800; bull.tgaNow = 700; bull.tgaPrevM = 710;
  bull.rrpNow = 400; bull.rrpPrevM = 450; bull.stablesNow = 180; bull.stablesPrevM = 170;
  bull.dxyNow = 100; bull.dxy21dAgo = 101; bull.us2Now = 4.2; bull.us2_21dAgo = 4.3;
  bull.us10Now = 4.2; bull.us10_21dAgo = 4.25; bull.cnNow = 40; bull.cnPrevM = 39.5;
  bull.euNow = 20; bull.euPrevM = 19.9; bull.jpNow = 10; bull.jpPrevM = 9.95;
  const r1 = computeRegime(bull);
  const liq = r1.buckets.find((b) => b.key === 'liquidity')!;
  assert(liq.score === 100, `expanding liquidity should score 100, got ${liq.score}`);
  assert(liq.coverage === 1, 'all 5 liquidity checks should be available');

  // TGA draining hard + net liquidity contracting → liquidity risk rises.
  const bear = blank();
  bear.fedNow = 6800; bear.fedPrevM = 7000; bear.tgaNow = 800; bear.tgaPrevM = 700; // +100B drain
  bear.rrpNow = 500; bear.rrpPrevM = 400; bear.stablesNow = 160; bear.stablesPrevM = 175;
  bear.dxyNow = 103; bear.dxy21dAgo = 100; bear.us2Now = 4.6; bear.us2_21dAgo = 4.2;
  bear.us10Now = 4.6; bear.us10_21dAgo = 4.2; bear.cnNow = 39; bear.cnPrevM = 40;
  bear.euNow = 19.8; bear.euPrevM = 20; bear.jpNow = 9.9; bear.jpPrevM = 10;
  const r2 = computeRegime(bear);
  const liq2 = r2.buckets.find((b) => b.key === 'liquidity')!;
  assert(liq2.score! < 50, `contracting liquidity should score low, got ${liq2.score}`);

  // Coverage: structural/nuclear absent → those buckets null, total from present only.
  assert(r1.buckets.find((b) => b.key === 'structural')!.score === null, 'structural should be null when unfed');
  assert(r1.coverage < 0.6, 'coverage should reflect missing structural/nuclear inputs');
  assert(r1.total != null, 'total should compute from available buckets');

  console.log('regime.ts demo OK —',
    `bull total=${r1.total} (${r1.regime}, cov ${(r1.coverage * 100).toFixed(0)}%),`,
    `bear liq=${liq2.score}`);
}

function blank(): RegimeInputs {
  const keys = [
    'fedNow','fedPrevM','tgaNow','tgaPrevM','rrpNow','rrpPrevM','stablesNow','stablesPrevM',
    'dxyNow','dxy7dAgo','dxy21dAgo','us2Now','us2_7dAgo','us2_21dAgo','us10Now','us10_21dAgo',
    'cnNow','cnPrevM','euNow','euPrevM','jpNow','jpPrevM','stableDomNow','stableDom7dAgo',
    'total3Now','total3_7dAgo','coinNow','coinPrev1d','btcNow','btcPrev1d','ethbtcNow','ethbtc7dAgo',
    'capexBuyersNow','capexBuyersPrevQ','capexBuyersPrevY','nvdaCapexNow','nvdaCapexPrevY',
    'muInvNow','muInv65Ago','pmi','digestNow','digestSma','digestPrev','fabNow','fabSma','fabPrev',
    'sruuf','ux1','urnmNow','urnm21dAgo','urnmVol','urnmVolAvg','spyNow','spy21dAgo',
    'leuNow','leuSma20w','aiCorr','vstNow','vstSma20','utilNow','utilSma','utilPrev',
  ];
  const o: Record<string, null> = {};
  for (const k of keys) o[k] = null;
  return o as unknown as RegimeInputs;
}

if (typeof require !== 'undefined' && require.main === module) demo();
