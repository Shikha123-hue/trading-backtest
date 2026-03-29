"use strict";

/**
 * strategy.js — Pine Script 100% Exact Match
 *
 * ═══════════════════════════════════════════════
 *  Pine → JS Exact Mapping
 * ═══════════════════════════════════════════════
 *
 *  FIX 1: ta.rma() → Wilder's smoothing (alpha = 1/period)
 *          All Pine indicators use RMA internally:
 *          ta.atr, ta.rsi, ta.dmi, ta.supertrend
 *
 *  FIX 2: ta.supertrend() → Per-bar RMA ATR + Pine exact band logic
 *          Pine pseudocode:
 *          upperBand := upperBand < prevUpperBand or close[1] > prevUpperBand
 *                     ? upperBand : prevUpperBand
 *          lowerBand := lowerBand > prevLowerBand or close[1] < prevLowerBand
 *                     ? lowerBand : prevLowerBand
 *          trend := na(atr[1]) ? 1
 *                 : trend[1]==-1 and close > upperBand ? 1
 *                 : trend[1]==1  and close < lowerBand ? -1
 *                 : trend[1]
 *          [superTrend = trend==1 ? lowerBand : upperBand, direction=-trend]
 *
 *  FIX 3: ta.vwap() → Daily UTC session reset
 *
 *  FIX 4: f_safe_mtf("15", st_dir) → uses _src[1] (previous bar)
 *
 *  FIX 5: ta.ema(close, 200) → needs 600+ warmup bars to converge
 *          (backtest uses 600 warmup candles, not 250)
 *
 *  FIX 6: ta.dmi() → RMA-based smoothing (Wilder's exact)
 *          Pine pseudocode:
 *          smoothedTR  = ta.rma(tr, diLength)
 *          smoothedPDM = ta.rma(plusDM, diLength)
 *          smoothedMDM = ta.rma(minusDM, diLength)
 *          plus  = smoothedPDM / smoothedTR * 100
 *          minus = smoothedMDM / smoothedTR * 100
 *          dx    = abs(plus-minus) / (plus+minus) * 100
 *          adx   = ta.rma(dx, adxSmoothing)
 * ═══════════════════════════════════════════════
 */

// ─── Pine: ta.rma(src, length) — Wilder's Moving Average ──────────────
// alpha = 1/length (NOT 2/(length+1) like EMA)
// seed  = ta.sma(src, length) on first valid bar
function calcRMA(data, period) {
  if (data.length < period) return null;
  // Seed with SMA (Pine: first value = sma)
  let rma = 0;
  for (let i = 0; i < period; i++) rma += data[i];
  rma /= period;
  // Wilder's smoothing: alpha = 1/period
  const alpha = 1 / period;
  for (let i = period; i < data.length; i++) {
    rma = alpha * data[i] + (1 - alpha) * rma;
  }
  return rma;
}

// Per-bar RMA — returns array of RMA values (needed for Supertrend)
function calcRMAArray(data, period) {
  const result = new Array(data.length).fill(null);
  if (data.length < period) return result;
  // Seed
  let sum = 0;
  for (let i = 0; i < period; i++) sum += data[i];
  result[period - 1] = sum / period;
  // Wilder's
  const alpha = 1 / period;
  for (let i = period; i < data.length; i++) {
    result[i] = alpha * data[i] + (1 - alpha) * result[i - 1];
  }
  return result;
}

// ─── Pine: ta.ema(src, length) ─────────────────────────────────────────
// alpha = 2/(length+1), seed = sma
function calcEMA(data, period) {
  if (data.length < period) return null;
  const alpha = 2 / (period + 1);
  let ema = 0;
  for (let i = 0; i < period; i++) ema += data[i];
  ema /= period;
  for (let i = period; i < data.length; i++) {
    ema = alpha * data[i] + (1 - alpha) * ema;
  }
  return ema;
}

// ─── Pine: ta.sma(src, length) ─────────────────────────────────────────
function calcSMA(data, period) {
  if (data.length < period) return null;
  return data.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// ─── Pine: ta.atr(length) = ta.rma(ta.tr(true), length) ───────────────
function calcATR(candles, period) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i-1].close;
    // Pine: ta.tr(true) = max(high-low, abs(high-close[1]), abs(low-close[1]))
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  return calcRMA(trs, period);
}

// ─── Pine: ta.rsi(src, length) ─────────────────────────────────────────
// Uses Wilder's RMA for gain/loss smoothing
function calcRSI(closes, period) {
  if (closes.length < period + 1) return null;
  const gains = [], losses = [];
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    gains.push(Math.max(d, 0));
    losses.push(Math.max(-d, 0));
  }
  const ag = calcRMA(gains, period);
  const al = calcRMA(losses, period);
  if (ag === null || al === null) return null;
  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
}

// ─── Pine: ta.vwap(close) — Daily UTC session reset ────────────────────
// Pine resets VWAP at the start of each new calendar day (UTC)
function calcVWAP(candles) {
  if (!candles.length) return null;
  const lastTime = candles[candles.length - 1].time;
  const d = new Date(lastTime);
  const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const session  = candles.filter(c => c.time >= dayStart);
  const src      = session.length > 0 ? session : candles;
  let tv = 0, v = 0;
  for (const c of src) {
    const tp = (c.high + c.low + c.close) / 3;
    tv += tp * c.volume;
    v  += c.volume;
  }
  return v === 0 ? null : tv / v;
}

// ─── Pine: ta.dmi(diLength, adxSmoothing) ─────────────────────────────
// Returns ADX only (strategy uses only adx_val)
// Pine exact: uses RMA throughout
function calcDMI(candles, period) {
  if (candles.length < period * 2 + 1) return { adx: null };

  const trs = [], pdms = [], mdms = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high,     l = candles[i].low;
    const ph = candles[i-1].high, pl = candles[i-1].low, pc = candles[i-1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    const up = h - ph, dn = pl - l;
    pdms.push(up > dn && up > 0 ? up : 0);
    mdms.push(dn > up && dn > 0 ? dn : 0);
  }

  // Pine: smoothedTR, smoothedPDM, smoothedMDM via ta.rma
  const strArr  = calcRMAArray(trs,  period);
  const spdmArr = calcRMAArray(pdms, period);
  const smdmArr = calcRMAArray(mdms, period);

  // Compute DX per bar
  const dxArr = [];
  for (let i = 0; i < strArr.length; i++) {
    if (strArr[i] === null || strArr[i] === 0) { dxArr.push(null); continue; }
    const pdi = spdmArr[i] / strArr[i] * 100;
    const mdi = smdmArr[i] / strArr[i] * 100;
    const sum = pdi + mdi;
    dxArr.push(sum === 0 ? 0 : Math.abs(pdi - mdi) / sum * 100);
  }

  // Pine: adx = ta.rma(dx, adxSmoothing)
  const validDX = dxArr.filter(v => v !== null);
  const adx = calcRMA(validDX, period);
  return { adx };
}

// Two-call version for adx_val and adx_val[1]
function calcDMI_prev(candles, period) {
  return calcDMI(candles.slice(0, -1), period);
}

// ─── Pine: ta.supertrend(factor, atrPeriod) ────────────────────────────
// Pine EXACT pseudocode:
//
//   src = hl2
//   atr = ta.atr(atrPeriod)                    ← RMA-based
//   upperBand = src + factor * atr
//   lowerBand = src - factor * atr
//   prevLowerBand = nz(lowerBand[1])            ← 0 on first bar
//   prevUpperBand = nz(upperBand[1])            ← 0 on first bar
//
//   lowerBand := lowerBand > prevLowerBand or close[1] < prevLowerBand
//              ? lowerBand : prevLowerBand
//   upperBand := upperBand < prevUpperBand or close[1] > prevUpperBand
//              ? upperBand : prevUpperBand
//
//   int trend = na
//   trend := na(atr[1])           ? 1           ← first valid bar
//          : trend[1]==-1 and close > upperBand ? 1
//          : trend[1]==1  and close < lowerBand ? -1
//          : trend[1]
//
//   superTrend = trend==1 ? lowerBand : upperBand
//
//   Returns [superTrend, direction]
//   direction = 1 when trend=1 (lowerBand, bullish, ST < close)
//             = -1 when trend=-1 (upperBand, bearish, ST > close)
//   BUT Pine docs + usage: direction < 0 = uptrend → returns -trend!
//   So returned direction = -trend:
//     trend=1 (lowerBand, bullish) → direction = -1 ← matches buy_signal check
//     trend=-1(upperBand, bearish) → direction = +1
//
function calcSuperTrend(candles, factor, atrPeriod) {
  if (candles.length < atrPeriod + 2) return { value: null, direction: null };

  // Step 1: Compute per-bar TR
  const trs = new Array(candles.length).fill(null);
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i-1].close;
    trs[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }

  // Step 2: Per-bar RMA of TR = per-bar ATR
  // Seed at bar atrPeriod using SMA of trs[1..atrPeriod]
  const atrArr = new Array(candles.length).fill(null);
  if (candles.length > atrPeriod) {
    let seed = 0;
    for (let i = 1; i <= atrPeriod; i++) seed += trs[i];
    atrArr[atrPeriod] = seed / atrPeriod;
    const alpha = 1 / atrPeriod;
    for (let i = atrPeriod + 1; i < candles.length; i++) {
      atrArr[i] = alpha * trs[i] + (1 - alpha) * atrArr[i - 1];
    }
  }

  // Step 3: Supertrend per-bar computation (Pine exact)
  let prevUpperBand = 0; // nz(...) = 0 on first bar
  let prevLowerBand = 0;
  let prevClose     = 0;
  let trend         = null; // na initially
  let superTrend    = null;

  for (let i = 1; i < candles.length; i++) {
    const atr = atrArr[i];
    if (atr === null) {
      prevClose = candles[i].close;
      continue;
    }

    const hl2  = (candles[i].high + candles[i].low) / 2;
    let upperBand = hl2 + factor * atr;
    let lowerBand = hl2 - factor * atr;

    // Pine: lowerBand := lowerBand > prevLowerBand or close[1] < prevLowerBand
    //                  ? lowerBand : prevLowerBand
    lowerBand = lowerBand > prevLowerBand || prevClose < prevLowerBand
      ? lowerBand : prevLowerBand;

    // Pine: upperBand := upperBand < prevUpperBand or close[1] > prevUpperBand
    //                  ? upperBand : prevUpperBand
    upperBand = upperBand < prevUpperBand || prevClose > prevUpperBand
      ? upperBand : prevUpperBand;

    // Pine: trend := na(atr[1]) ? 1 : ...
    const prevATR = atrArr[i - 1];
    if (prevATR === null) {
      // na(atr[1]) → trend = 1 (bullish default)
      trend = 1;
    } else if (trend === -1 && candles[i].close > upperBand) {
      trend = 1;
    } else if (trend === 1 && candles[i].close < lowerBand) {
      trend = -1;
    }
    // else trend stays same (nz(trend[1], 1) if trend was null → 1)
    if (trend === null) trend = 1;

    superTrend    = trend === 1 ? lowerBand : upperBand;
    prevUpperBand = upperBand;
    prevLowerBand = lowerBand;
    prevClose     = candles[i].close;
  }

  // Pine convention: direction < 0 = uptrend (bullish)
  // trend=1 (lowerBand, bullish) → direction = -1
  // trend=-1(upperBand, bearish) → direction = +1
  const direction = trend === null ? null : -trend;
  return { value: superTrend, direction };
}

// ═══════════════════════════════════════════════
//  MAIN STRATEGY — Pine Script Line-by-Line
// ═══════════════════════════════════════════════
function strategy(candles5m, candles15m) {
  // Need 600+ bars for EMA(200) to fully converge
  if (candles5m.length  < 600) return null;
  if (candles15m.length < 50)  return null;

  const closes  = candles5m.map(c => c.close);
  const vols    = candles5m.map(c => c.volume);
  const close   = closes[closes.length - 1];

  // Pine: [st_val, st_dir] = ta.supertrend(4, 12)
  const { direction: st_dir } = calcSuperTrend(candles5m, 4, 12);

  // Pine: vwap_val = ta.vwap(close)  ← daily session reset
  const vwap_val = calcVWAP(candles5m);

  // Pine: rsi_val = ta.rsi(close, 14)
  const rsi_val = calcRSI(closes, 14);

  // Pine: [p, m, adx_val] = ta.dmi(14, 14)
  const { adx: adx_val  } = calcDMI(candles5m, 14);
  // Pine: adx_val[1]  →  previous bar DMI
  const { adx: adx_prev } = calcDMI_prev(candles5m, 14);

  // Pine: ema_200 = ta.ema(close, 200)
  const ema_200 = calcEMA(closes, 200);

  // Pine: atr = ta.atr(14)
  const atr = calcATR(candles5m, 14);

  // Pine: st_15min_dir = f_safe_mtf("15", st_dir)
  // f_safe_mtf uses _src[1] → previous 15m bar's direction
  const { direction: st_15min_dir } = calcSuperTrend(
    candles15m.slice(0, -1), 4, 12   // [1] = exclude current forming bar
  );

  // Pine: adx_rising = adx_val > 32 and adx_val > adx_val[1]
  const adx_rising = adx_val  !== null &&
                     adx_prev !== null &&
                     adx_val > 32 &&
                     adx_val > adx_prev;

  // Pine: high_vol = volume > ta.sma(volume, 20) * 1.2
  const vol_sma  = calcSMA(vols, 20);
  const curVol   = candles5m[candles5m.length - 1].volume;
  const high_vol = vol_sma !== null && curVol > vol_sma * 1.2;

  if (!atr || !rsi_val || !ema_200 || !vwap_val ||
      st_dir === null || st_15min_dir === null) return null;

  // Pine: buy_signal
  const buy_signal =
    st_dir       === -1 &&   // close > st_val  (direction=-1 = bullish)
    st_15min_dir === -1 &&   // st_15min_dir < 0
    close > vwap_val    &&
    close > ema_200     &&
    rsi_val > 58        &&
    rsi_val < 72        &&
    adx_rising          &&
    high_vol;

  // Pine: sell_signal
  const sell_signal =
    st_dir       === 1  &&   // close < st_val  (direction=1 = bearish)
    st_15min_dir === 1  &&   // st_15min_dir > 0
    close < vwap_val    &&
    close < ema_200     &&
    rsi_val > 28        &&
    rsi_val < 42        &&
    adx_rising          &&
    high_vol;

  if (!buy_signal && !sell_signal) return null;

  return {
    buy_signal,
    sell_signal,
    atr,
    sl_mult:      1.5,   // Pine: loss = (atr * 1.5) / mintick
    trail_points: 2.0,   // Pine: trail_points = 2.0 / mintick
    trail_offset: 0.5,   // Pine: trail_offset = 0.5 / mintick
  };
}

// ═══════════════════════════════════════════════
//  TRAILING STOP — Pine strategy.exit exact
// ═══════════════════════════════════════════════
class TrailingStopManager {
  constructor() { this.reset(); }

  reset() {
    this.active      = false;
    this.side        = null;
    this.entryPrice  = 0;
    this.currentSL   = 0;
    this.trailActive = false;
    this.trailPoints = 0;
    this.trailOffset = 0;
    this.peakPrice   = 0;
  }

  open(side, entryPrice, atr, trailPoints, trailOffset, slMult) {
    this.reset();
    this.active      = true;
    this.side        = side;
    this.entryPrice  = entryPrice;
    this.trailPoints = trailPoints;   // $2.0 fixed (Pine exact)
    this.trailOffset = trailOffset;   // $0.5 fixed (Pine exact)
    this.peakPrice   = entryPrice;
    this.currentSL   = side === "buy"
      ? entryPrice - atr * slMult    // Pine: loss = atr * 1.5 / mintick
      : entryPrice + atr * slMult;
  }

  updateOHLC(high, low) {
    if (!this.active) return { stopped: false, currentSL: this.currentSL, trailActive: false };
    const isBuy = this.side === "buy";

    // Track peak (best price reached)
    if (isBuy  && high > this.peakPrice) this.peakPrice = high;
    if (!isBuy && low  < this.peakPrice) this.peakPrice = low;

    // Pine: trail activates after trail_points move
    const move = isBuy
      ? this.peakPrice - this.entryPrice
      : this.entryPrice - this.peakPrice;
    if (move >= this.trailPoints) this.trailActive = true;

    // Update trailing SL
    if (this.trailActive) {
      const newSL = isBuy
        ? this.peakPrice - this.trailOffset
        : this.peakPrice + this.trailOffset;
      if (isBuy  && newSL > this.currentSL) this.currentSL = newSL;
      if (!isBuy && newSL < this.currentSL) this.currentSL = newSL;
    }

    // Check if stopped
    const stopped = isBuy ? low <= this.currentSL : high >= this.currentSL;
    return { stopped, currentSL: this.currentSL, trailActive: this.trailActive };
  }

  close() { this.reset(); }
}

module.exports = { strategy, TrailingStopManager };