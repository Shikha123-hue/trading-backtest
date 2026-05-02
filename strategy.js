"use strict";
/**
 * strategy.js — Pooja.js ke saath 100% match
 *
 * ✅ Primary TF  : 15m (5m HATA DIYA)
 * ✅ MTF         : 1h fully closed bars only (anti-repaint)
 * ✅ Indicators  : EMA200, RSI14, ADX14, ATR14, VWAP, SuperTrend(4,12)
 * ✅ Signal      : Exact same as Pooja.js
 * ✅ TSM         : ATR×1.5 SL, trail after 2pt, offset 0.5
 */

// ─── RMA (Wilder's) Array ─────────────────────────────────
function calcRMAArray(data, period) {
  const result = new Array(data.length).fill(null);
  if (data.length < period) return result;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += data[i];
  result[period - 1] = sum / period;
  const alpha = 1 / period;
  for (let i = period; i < data.length; i++)
    result[i] = alpha * data[i] + (1 - alpha) * result[i - 1];
  return result;
}

// ─── EMA Array ────────────────────────────────────────────
function calcEMAArray(data, period) {
  const result = new Array(data.length).fill(null);
  if (data.length < period) return result;
  const alpha = 2 / (period + 1);
  let ema = 0;
  for (let i = 0; i < period; i++) ema += data[i];
  ema /= period; result[period - 1] = ema;
  for (let i = period; i < data.length; i++) {
    ema = alpha * data[i] + (1 - alpha) * ema;
    result[i] = ema;
  }
  return result;
}

// ─── SMA Array ────────────────────────────────────────────
function calcSMAArray(data, period) {
  const result = new Array(data.length).fill(null);
  for (let i = period - 1; i < data.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += data[j];
    result[i] = sum / period;
  }
  return result;
}

// ─── ATR Array ────────────────────────────────────────────
function calcATRArray(highs, lows, closes, period) {
  const trs = new Array(highs.length).fill(null);
  for (let i = 1; i < highs.length; i++)
    trs[i] = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i]  - closes[i - 1])
    );
  const result = new Array(highs.length).fill(null);
  let seed = 0;
  for (let i = 1; i <= period; i++) seed += trs[i];
  result[period] = seed / period;
  const alpha = 1 / period;
  for (let i = period + 1; i < highs.length; i++)
    result[i] = alpha * trs[i] + (1 - alpha) * result[i - 1];
  return result;
}

// ─── RSI Array ────────────────────────────────────────────
function calcRSIArray(closes, period) {
  const result = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return result;
  const gains = [], losses = [];
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gains.push(Math.max(d, 0));
    losses.push(Math.max(-d, 0));
  }
  const alpha = 1 / period;
  let ag = 0, al = 0;
  for (let i = 0; i < period; i++) { ag += gains[i]; al += losses[i]; }
  ag /= period; al /= period;
  result[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = period; i < gains.length; i++) {
    ag = alpha * gains[i] + (1 - alpha) * ag;
    al = alpha * losses[i] + (1 - alpha) * al;
    result[i + 1] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return result;
}

// ─── ADX Array ────────────────────────────────────────────
function calcADXArray(highs, lows, closes, period) {
  const trs = [], pdms = [], mdms = [];
  for (let i = 1; i < highs.length; i++) {
    const h = highs[i], l = lows[i], ph = highs[i-1], pl = lows[i-1], pc = closes[i-1];
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    const up = h - ph, dn = pl - l;
    pdms.push(up > dn && up > 0 ? up : 0);
    mdms.push(dn > up && dn > 0 ? dn : 0);
  }
  const strArr  = calcRMAArray(trs,  period);
  const spdmArr = calcRMAArray(pdms, period);
  const smdmArr = calcRMAArray(mdms, period);
  const dxArr   = new Array(trs.length).fill(null);
  for (let i = 0; i < strArr.length; i++) {
    if (!strArr[i] || strArr[i] === 0) continue;
    const pdi = spdmArr[i] / strArr[i] * 100;
    const mdi = smdmArr[i] / strArr[i] * 100;
    const sum = pdi + mdi;
    dxArr[i]  = sum === 0 ? 0 : Math.abs(pdi - mdi) / sum * 100;
  }
  const adxRaw = calcRMAArray(dxArr.map(v => v === null ? 0 : v), period);
  const adxArr = new Array(highs.length).fill(null);
  for (let i = 0; i < adxRaw.length; i++) adxArr[i + 1] = adxRaw[i];
  return adxArr;
}

// ─── SuperTrend Array ─────────────────────────────────────
function calcSuperTrendArray(highs, lows, closes, factor, atrPeriod) {
  const atrArr = calcATRArray(highs, lows, closes, atrPeriod);
  const dirArr = new Array(closes.length).fill(null);
  let prevUpper = 0, prevLower = 0, prevClose = 0, trend = null;
  for (let i = 1; i < closes.length; i++) {
    const atr = atrArr[i];
    if (atr === null) { prevClose = closes[i]; continue; }
    const hl2   = (highs[i] + lows[i]) / 2;
    let upper   = hl2 + factor * atr;
    let lower   = hl2 - factor * atr;
    lower = lower > prevLower || prevClose < prevLower ? lower : prevLower;
    upper = upper < prevUpper || prevClose > prevUpper ? upper : prevUpper;
    if (atrArr[i - 1] === null)              trend = 1;
    else if (trend === -1 && closes[i] > upper) trend = 1;
    else if (trend ===  1 && closes[i] < lower) trend = -1;
    if (trend === null) trend = 1;
    dirArr[i]  = -trend;
    prevUpper  = upper;
    prevLower  = lower;
    prevClose  = closes[i];
  }
  return dirArr;
}

// ─── VWAP Array (daily UTC reset) ────────────────────────
// candles = array of { time, high, low, close, volume }
function calcVWAPArray(candles) {
  const vwap = new Array(candles.length).fill(null);
  let tv = 0, v = 0, lastDate = null;
  for (let i = 0; i < candles.length; i++) {
    const d = new Date(candles[i].time).getUTCDate();
    if (lastDate !== null && d !== lastDate) { tv = 0; v = 0; }
    const tp = (candles[i].high + candles[i].low + candles[i].close) / 3;
    tv += tp * candles[i].volume;
    v  += candles[i].volume;
    vwap[i] = v === 0 ? null : tv / v;
    lastDate = d;
  }
  return vwap;
}

// ══════════════════════════════════════════════
//  MAIN STRATEGY  — Pooja.js exact match
//  Input: candles15m, candles1h  (objects with time/high/low/close/volume)
//         Both arrays = only CLOSED bars (last bar already sliced off)
// ══════════════════════════════════════════════
function strategy(candles15m, candles1h) {
  // Need enough bars for indicators to warm up
  if (candles15m.length < 300) return null;
  if (candles1h.length  <  50) return null;

  // ── Extract arrays ──────────────────────────
  const h15 = candles15m.map(d => d.high);
  const l15 = candles15m.map(d => d.low);
  const c15 = candles15m.map(d => d.close);
  const v15 = candles15m.map(d => d.volume);
  const t15 = candles15m.map(d => d.time);

  const h1h = candles1h.map(d => d.high);
  const l1h = candles1h.map(d => d.low);
  const c1h = candles1h.map(d => d.close);
  const t1h = candles1h.map(d => d.time);

  // ── Compute indicators (same as Pooja.js) ───
  const ema200 = calcEMAArray(c15, 200);
  const rsi    = calcRSIArray(c15, 14);
  const adx    = calcADXArray(h15, l15, c15, 14);
  const atr    = calcATRArray(h15, l15, c15, 14);
  const volSma = calcSMAArray(v15, 20);
  const vwap   = calcVWAPArray(candles15m);
  const dir15  = calcSuperTrendArray(h15, l15, c15, 4, 12);
  const dir1h  = calcSuperTrendArray(h1h, l1h, c1h, 4, 12);

  // ── Anti-repaint MTF map (same as Pooja.js) ─
  // Only use 1h bars that are FULLY closed before current 15m bar
  const mtf1hMap = new Map();
  for (let i = 0; i < t15.length; i++) {
    const curTime = t15[i];
    let stDir1h = null;
    for (let j = t1h.length - 1; j >= 0; j--) {
      if (t1h[j] + 3600000 <= curTime) { stDir1h = dir1h[j]; break; }
    }
    mtf1hMap.set(curTime, stDir1h);
  }

  // ── Last closed bar ──────────────────────────
  const i = candles15m.length - 1;

  const price   = c15[i];
  const curTime = t15[i];
  const curEma  = ema200[i];
  const curRsi  = rsi[i];
  const curAdx  = adx[i];
  const prevAdx = adx[i - 1];
  const curAtr  = atr[i];
  const curVSma = volSma[i];
  const curVwap = vwap[i];
  const stDir15 = dir15[i];
  const stDir1h = mtf1hMap.get(curTime);

  // ── Validate all indicators ready ───────────
  if (!curEma || !curRsi || !curAdx || !prevAdx || !curAtr ||
      !curVSma || !curVwap || stDir15 === null ||
      stDir1h === null || stDir1h === undefined) return null;

  // ── Signal conditions (exact Pooja.js copy) ─
  const buySignal =
    stDir15 === -1 && stDir1h === -1 &&
    price > curVwap && price > curEma &&
    curRsi > 58 && curRsi < 72 &&
    curAdx > 32 && curAdx > prevAdx &&
    v15[i] > curVSma * 1.2;

  const sellSignal =
    stDir15 === 1 && stDir1h === 1 &&
    price < curVwap && price < curEma &&
    curRsi > 28 && curRsi < 42 &&
    curAdx > 32 && curAdx > prevAdx &&
    v15[i] > curVSma * 1.2;

  if (!buySignal && !sellSignal) return null;

  return {
    buy_signal:  buySignal,
    sell_signal: sellSignal,
    price,
    atr:    curAtr,
    rsi:    curRsi,
    adx:    curAdx,
    vwap:   curVwap,
    ema200: curEma,
  };
}

// ══════════════════════════════════════════════
//  TRAILING STOP — Pooja.js exact match
//  SL  = entry ± ATR × 1.5
//  Trail activates after 2pt move
//  Trail offset = 0.5pt
// ══════════════════════════════════════════════
class TrailingStopManager {
  constructor() { this.reset(); }

  reset() {
    this.active      = false;
    this.side        = null;
    this.entryPrice  = 0;
    this.currentSL   = 0;
    this.trailActive = false;
    this.peakPrice   = 0;
  }

  // atr only — same 3-param signature as Pooja.js
  open(side, entryPrice, atr) {
    this.reset();
    this.active     = true;
    this.side       = side;
    this.entryPrice = entryPrice;
    this.peakPrice  = entryPrice;
    this.currentSL  = side === 'long'
      ? entryPrice - atr * 1.5
      : entryPrice + atr * 1.5;
  }

  update(high, low) {
    if (!this.active) return { stopped: false };
    const isBuy = this.side === 'long';

    if  (isBuy && high > this.peakPrice) this.peakPrice = high;
    if (!isBuy && low  < this.peakPrice) this.peakPrice = low;

    const move = isBuy
      ? this.peakPrice - this.entryPrice
      : this.entryPrice - this.peakPrice;

    if (move >= 2.0) this.trailActive = true;

    if (this.trailActive) {
      const newSL = isBuy
        ? this.peakPrice - 0.5
        : this.peakPrice + 0.5;
      if  (isBuy && newSL > this.currentSL) this.currentSL = newSL;
      if (!isBuy && newSL < this.currentSL) this.currentSL = newSL;
    }

    const stopped = isBuy
      ? low  <= this.currentSL
      : high >= this.currentSL;

    return { stopped, exitPrice: this.currentSL };
  }

  close() { this.reset(); }
}

module.exports = { strategy, TrailingStopManager };
