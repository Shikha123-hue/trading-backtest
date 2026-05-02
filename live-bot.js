"use strict";
/**
 * live-bot.js — Binance Futures Live Trading Bot
 *
 * ✅ Exact same logic as Pooja.js backtest
 * ✅ 15m primary + 1h MTF (no 5m)
 * ✅ Same indicators: EMA200, RSI14, ADX14, ATR14, VWAP, SuperTrend(4,12)
 * ✅ Same signal conditions
 * ✅ Same TrailingStopManager (ATR × 1.5 SL, trail after 2pt move)
 * ✅ Anti-repaint: only fully closed 1h bars used
 * ✅ FIX: Position state persisted to disk (restart-safe)
 * ✅ FIX: Real Binance position checked on startup
 * ✅ FIX: Duplicate entry prevention
 *
 * RUN: node live-bot.js
 */

const https  = require("https");
const crypto = require("crypto");
const fs     = require("fs");
const path   = require("path");

// ─── API KEYS ─────────────────────────────────────────────
const API_KEY    = 'fMiGrtMxTLMndKFEIWlGkKKTnE12A72Bba4E8vju7KCGqyhewlTFSkPnrSV6akfX';
const API_SECRET = '6DLUdHQGfazk4X2K52PLZZzn5eDSIarGYcoZEpPRCMHNFoEcz3LRjixGDIKQmXk4';
// ─────────────────────────────────────────────────────────

// ─── CONFIG (same as Pooja.js) ────────────────────────────
const SYMBOL        = "BTCUSDT";
const LOT_SIZE      = 0.01;
const LEVERAGE      = 10;
const EFFECTIVE_LOT = LOT_SIZE * LEVERAGE;
const BASE_URL      = "testnet.binancefuture.com";
const CHECK_INTERVAL_MS = 15 * 60 * 1000;
const WARMUP        = 300;
const INITIAL_CAPITAL = 500;   // 2705 Starting capital
// ─────────────────────────────────────────────────────────

// ─── LOGS & STATE FILES ───────────────────────────────────
const logsDir      = path.join(__dirname, "logs");
const signalLog    = path.join(logsDir, "live-signals.jsonl");
const stateFile    = path.join(logsDir, "bot-state.json");   // ✅ NEW: persist state
fs.mkdirSync(logsDir, { recursive: true });

function appendLog(obj) {
  const line = JSON.stringify({ ...obj, ts: new Date().toISOString() });
  fs.appendFileSync(signalLog, line + "\n");
  console.log("📝 Log:", line);
}

// ✅ NEW: Save openTrade + TSM state to disk
function saveState() {
  try {
    const data = {
      openTrade,
      tsm: openTrade ? {
        active:      tsm.active,
        side:        tsm.side,
        entryPrice:  tsm.entryPrice,
        currentSL:   tsm.currentSL,
        trailActive: tsm.trailActive,
        peakPrice:   tsm.peakPrice,
        atr:         tsm.atr,
      } : null,
    };
    fs.writeFileSync(stateFile, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error("❌ saveState error:", e.message);
  }
}

// ✅ NEW: Load state from disk on startup
function loadState() {
  try {
    if (!fs.existsSync(stateFile)) return;
    const data = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    if (data.openTrade) {
      openTrade = data.openTrade;
      if (data.tsm) {
        tsm.active      = data.tsm.active;
        tsm.side        = data.tsm.side;
        tsm.entryPrice  = data.tsm.entryPrice;
        tsm.currentSL   = data.tsm.currentSL;
        tsm.trailActive = data.tsm.trailActive;
        tsm.peakPrice   = data.tsm.peakPrice;
        tsm.atr         = data.tsm.atr;
      }
      console.log(`✅ State restored: ${openTrade.side.toUpperCase()} @ $${openTrade.entryPrice} | SL: $${tsm.currentSL?.toFixed(2)}`);
    }
  } catch (e) {
    console.error("❌ loadState error:", e.message);
  }
}

// ✅ NEW: Clear saved state after trade closes
function clearState() {
  openTrade = null;
  tsm.reset();
  try { fs.writeFileSync(stateFile, JSON.stringify({ openTrade: null, tsm: null }, null, 2)); }
  catch (e) { console.error("❌ clearState error:", e.message); }
}
// ─────────────────────────────────────────────────────────

// ══════════════════════════════════════════════════════════
//  INDICATOR FUNCTIONS  (copied exactly from Pooja.js)
// ══════════════════════════════════════════════════════════

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

function calcSMAArray(data, period) {
  const result = new Array(data.length).fill(null);
  for (let i = period - 1; i < data.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += data[j];
    result[i] = sum / period;
  }
  return result;
}

function calcATRArray(highs, lows, closes, period) {
  const trs = new Array(highs.length).fill(null);
  for (let i = 1; i < highs.length; i++)
    trs[i] = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
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

function calcADXArray(highs, lows, closes, period) {
  const trs = [], pdms = [], mdms = [];
  for (let i = 1; i < highs.length; i++) {
    const h = highs[i], l = lows[i], ph = highs[i - 1], pl = lows[i - 1], pc = closes[i - 1];
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    const up = h - ph, dn = pl - l;
    pdms.push(up > dn && up > 0 ? up : 0);
    mdms.push(dn > up && dn > 0 ? dn : 0);
  }
  const strArr  = calcRMAArray(trs, period);
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
    if (atrArr[i - 1] === null)          trend = 1;
    else if (trend === -1 && closes[i] > upper) trend = 1;
    else if (trend ===  1 && closes[i] < lower) trend = -1;
    if (trend === null) trend = 1;
    dirArr[i] = -trend;
    prevUpper = upper; prevLower = lower; prevClose = closes[i];
  }
  return dirArr;
}

function calcVWAPArray(ohlcv) {
  const vwap = new Array(ohlcv.length).fill(null);
  let tv = 0, v = 0, lastDate = null;
  for (let i = 0; i < ohlcv.length; i++) {
    const d = new Date(ohlcv[i].time).getUTCDate();
    if (lastDate !== null && d !== lastDate) { tv = 0; v = 0; }
    const tp = (ohlcv[i].high + ohlcv[i].low + ohlcv[i].close) / 3;
    tv += tp * ohlcv[i].volume;
    v  += ohlcv[i].volume;
    vwap[i] = v === 0 ? null : tv / v;
    lastDate = d;
  }
  return vwap;
}

// ══════════════════════════════════════════════════════════
//  TRAILING STOP MANAGER  (copied exactly from Pooja.js)
// ══════════════════════════════════════════════════════════

class TrailingStopManager {
  constructor() { this.reset(); }

  reset() {
    this.active      = false;
    this.side        = null;
    this.entryPrice  = 0;
    this.currentSL   = 0;
    this.trailActive = false;
    this.peakPrice   = 0;
    this.atr         = 0;
  }

  open(side, entryPrice, atr) {
    this.reset();
    this.active     = true;
    this.side       = side;
    this.entryPrice = entryPrice;
    this.peakPrice  = entryPrice;
    this.atr        = atr;
    this.currentSL  = side === 'long'
      ? entryPrice - atr * 3.0
      : entryPrice + atr * 3.0;
  }

  update(high, low) {
    if (!this.active) return { stopped: false };
    const isBuy = this.side === 'long';

    if  (isBuy && high > this.peakPrice) this.peakPrice = high;
    if (!isBuy && low  < this.peakPrice) this.peakPrice = low;

    const move = isBuy
      ? this.peakPrice - this.entryPrice
      : this.entryPrice - this.peakPrice;

    if (move >= this.atr * 2.0) this.trailActive = true;

    if (this.trailActive) {
      const newSL = isBuy ? this.peakPrice - this.atr * 1.5 : this.peakPrice + this.atr * 1.5;
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

// ══════════════════════════════════════════════════════════
//  HTTP / API HELPERS
// ══════════════════════════════════════════════════════════

function apiRequest(method, urlPath, params = {}) {
  return new Promise((resolve, reject) => {
    params.timestamp = Date.now();
    const qs  = Object.entries(params).map(([k, v]) => `${k}=${v}`).join("&");
    const sig = crypto.createHmac("sha256", API_SECRET).update(qs).digest("hex");
    const fullQS = `${qs}&signature=${sig}`;

    const options = {
      hostname: BASE_URL,
      path:     method === "GET" ? `${urlPath}?${fullQS}` : urlPath,
      method,
      headers:  {
        "X-MBX-APIKEY": API_KEY,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    if (method === "POST") req.write(fullQS);
    req.end();
  });
}

function fetchKlines(interval, limit = 600) {
  return new Promise((resolve, reject) => {
    const url = `https://${BASE_URL}/fapi/v1/klines?symbol=${SYMBOL}&interval=${interval}&limit=${limit}`;
    https.get(url, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const raw = JSON.parse(data);
          resolve(raw.map(k => ({
            time:   k[0],
            open:   parseFloat(k[1]),
            high:   parseFloat(k[2]),
            low:    parseFloat(k[3]),
            close:  parseFloat(k[4]),
            volume: parseFloat(k[5]),
          })));
        } catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

async function setLeverage() {
  try {
    const res = await apiRequest("POST", "/fapi/v1/leverage", {
      symbol: SYMBOL, leverage: LEVERAGE,
    });
    if (res && res.leverage) {
      console.log(`✅ Leverage set: ${res.leverage}x`);
    } else {
      console.warn("⚠️  Leverage response:", JSON.stringify(res));
    }
  } catch (e) {
    console.error("❌ setLeverage error:", e.message);
  }
}

// ✅ NEW: Fetch real position size from Binance
async function fetchBinancePosition() {
  try {
    const res = await apiRequest("GET", "/fapi/v2/positionRisk", { symbol: SYMBOL });
    if (!Array.isArray(res)) return null;
    const pos = res.find(p => p.symbol === SYMBOL);
    if (!pos) return null;
    const amt = parseFloat(pos.positionAmt);
    if (amt === 0) return null;
    return {
      side:       amt > 0 ? 'long' : 'short',
      size:       Math.abs(amt),
      entryPrice: parseFloat(
	      pos.entryPrice),
    };
  } catch (e) {
    console.error("❌ fetchBinancePosition error:", e.message);
    return null;
  }
}

// ✅ NEW: Close ALL open positions for symbol (emergency / startup cleanup)
async function closeAllPositions() {
  try {
    const pos = await fetchBinancePosition();
    if (!pos) { console.log("✅ No open position to close."); return; }
    const closeSide = pos.side === 'long' ? 'SELL' : 'BUY';
    const res = await apiRequest("POST", "/fapi/v1/order", {
      symbol:   SYMBOL,
      side:     closeSide,
      type:     "MARKET",
      quantity: pos.size,
      reduceOnly: true,
    });
    console.log(`✅ Emergency close: ${closeSide} ${pos.size} BTC | ID: ${res.orderId}`);
  } catch (e) {
    console.error("❌ closeAllPositions error:", e.message);
  }
}

async function placeOrder(side) {
  try {
    const res = await apiRequest("POST", "/fapi/v1/order", {
      symbol:   SYMBOL,
      side:     side === "long" ? "BUY" : "SELL",
      type:     "MARKET",
      quantity: LOT_SIZE,
    });
    console.log(`✅ Order placed: ${side.toUpperCase()} ${LOT_SIZE} BTC | ID: ${res.orderId}`);
    return res;
  } catch (e) {
    console.error("❌ placeOrder error:", e.message);
    return null;
  }
}

async function closeOrder(side) {
  try {
    const closeSide = side === "long" ? "SELL" : "BUY";
    const res = await apiRequest("POST", "/fapi/v1/order", {
      symbol:     SYMBOL,
      side:       closeSide,
      type:       "MARKET",
      quantity:   LOT_SIZE,
      reduceOnly: true,   // ✅ SAFETY: only reduces, never opens new position
    });
    console.log(`✅ Position closed: ${closeSide} ${LOT_SIZE} BTC | ID: ${res.orderId}`);
    return res;
  } catch (e) {
    console.error("❌ closeOrder error:", e.message);
    return null;
  }
}

// ══════════════════════════════════════════════════════════
//  STATE
// ══════════════════════════════════════════════════════════

const tsm     = new TrailingStopManager();
let openTrade = null;  // { side, entryPrice, entryTime }

// ══════════════════════════════════════════════════════════
//  STARTUP RECONCILIATION  ✅ NEW
//  Syncs bot state with actual Binance position on launch
// ══════════════════════════════════════════════════════════

async function reconcileOnStartup() {
  console.log("\n🔍 Reconciling state with Binance...");

  // Load saved state from disk first
  loadState();

  // Fetch real position from Binance
  const binancePos = await fetchBinancePosition();

  if (!binancePos && !openTrade) {
    console.log("✅ Reconcile: No position anywhere. Clean start.");
    return;
  }

  if (!binancePos && openTrade) {
    console.log("⚠️  Reconcile: Bot thinks trade open but Binance has NO position. Clearing state.");
    clearState();
    return;
  }

  if (binancePos && !openTrade) {
    console.log(`⚠️  Reconcile: Binance has ${binancePos.side.toUpperCase()} ${binancePos.size} BTC @ $${binancePos.entryPrice} but bot has no state.`);
    console.log("⚠️  MANUAL ACTION NEEDED: Close this position manually on Binance, then restart bot.");
    console.log("   OR the bot will just monitor it without a saved SL (risky).");
    // Don't auto-restore without ATR — safer to alert and let user decide
    return;
  }

  if (binancePos && openTrade) {
    // Check if size matches expected
    if (binancePos.size > LOT_SIZE + 0.001) {
      console.log(`🚨 DUPLICATE POSITION DETECTED: Binance has ${binancePos.size} BTC but expected ${LOT_SIZE} BTC!`);
      console.log("🔧 Auto-closing excess position...");
      // Close excess (binancePos.size - LOT_SIZE)
      const excess = parseFloat((binancePos.size - LOT_SIZE).toFixed(3));
      const closeSide = binancePos.side === 'long' ? 'SELL' : 'BUY';
      try {
        const res = await apiRequest("POST", "/fapi/v1/order", {
          symbol:     SYMBOL,
          side:       closeSide,
          type:       "MARKET",
          quantity:   excess,
          reduceOnly: true,
        });
        console.log(`✅ Excess ${excess} BTC closed | ID: ${res.orderId}`);
      } catch (e) {
        console.error("❌ Failed to close excess:", e.message);
      }
    }
    console.log(`✅ Reconcile OK: ${openTrade.side.toUpperCase()} trade active | SL: $${tsm.currentSL?.toFixed(2)}`);
  }
}

// ══════════════════════════════════════════════════════════
//  MAIN TICK
// ══════════════════════════════════════════════════════════

async function tick() {
  const now = new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" });
  console.log(`\n${"─".repeat(60)}`);
  console.log(`⏰ [${now}] Tick started...`);

  try {
    const [raw15m, raw1h] = await Promise.all([
      fetchKlines("15m", 1500),
      fetchKlines("1h",  500),
    ]);

    const c15m = raw15m.slice(0, -1);
    const c1h  = raw1h.slice(0,  -1);

    if (c15m.length < WARMUP + 10) {
      console.log("⚠️  Not enough 15m bars yet. Waiting...");
      return;
    }

    console.log(`📊 Bars fetched — 15m: ${c15m.length} | 1h: ${c1h.length}`);

    const h15 = c15m.map(d => d.high);
    const l15 = c15m.map(d => d.low);
    const c15 = c15m.map(d => d.close);
    const v15 = c15m.map(d => d.volume);
    const t15 = c15m.map(d => d.time);

    const h1h  = c1h.map(d => d.high);
    const l1h  = c1h.map(d => d.low);
    const c1h_ = c1h.map(d => d.close);
    const t1h  = c1h.map(d => d.time);

    const ema200  = calcEMAArray(c15, 200);
    const rsi     = calcRSIArray(c15, 14);
    const adx     = calcADXArray(h15, l15, c15, 14);
    const atr     = calcATRArray(h15, l15, c15, 14);
    const volSma  = calcSMAArray(v15, 20);
    const vwap    = calcVWAPArray(c15m);
    const dir15   = calcSuperTrendArray(h15, l15, c15, 4, 12);
    const dir1h   = calcSuperTrendArray(h1h, l1h, c1h_, 4, 12);

    const mtf1hMap = new Map();
    for (let i = 0; i < t15.length; i++) {
      const curTime = t15[i];
      let stDir1h = null;
      for (let j = t1h.length - 1; j >= 0; j--) {
        if (t1h[j] + 3600000 <= curTime) { stDir1h = dir1h[j]; break; }
      }
      mtf1hMap.set(curTime, stDir1h);
    }

    const i = c15m.length - 1;

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

    console.log(`\n📈 Last closed 15m bar: $${price.toFixed(2)}`);
    console.log(`   EMA200: ${curEma?.toFixed(2) ?? 'N/A'} | RSI: ${curRsi?.toFixed(2) ?? 'N/A'} | ADX: ${curAdx?.toFixed(2) ?? 'N/A'}`);
    console.log(`   ATR: ${curAtr?.toFixed(2) ?? 'N/A'} | VWAP: ${curVwap?.toFixed(2) ?? 'N/A'}`);
    console.log(`   ST15: ${stDir15} | ST1h: ${stDir1h} | Vol>${curVSma ? (v15[i] / curVSma).toFixed(2) : 'N/A'}x avg`);

    // ── EXIT check ────────────────────────────────────────
    if (openTrade && tsm.active) {
      const { stopped, exitPrice } = tsm.update(h15[i], l15[i]);
      const sl = tsm.currentSL;
      console.log(`\n🔄 Open Trade: ${openTrade.side.toUpperCase()} @ $${openTrade.entryPrice.toFixed(2)}`);
      console.log(`   Current SL: $${sl.toFixed(2)} | Trail: ${tsm.trailActive ? 'ON' : 'OFF'}`);

      saveState(); // ✅ Save updated SL after every tick

      if (stopped) {
        const pnl = openTrade.side === 'long'
          ? (exitPrice - openTrade.entryPrice) * EFFECTIVE_LOT
          : (openTrade.entryPrice - exitPrice) * EFFECTIVE_LOT;

        console.log(`\n🛑 Trailing Stop Hit! Exit @ $${exitPrice.toFixed(2)} | PnL: $${pnl.toFixed(2)}`);
        await closeOrder(openTrade.side);
        appendLog({
          event: "close", side: openTrade.side,
          entryPrice: openTrade.entryPrice, exitPrice,
          pnl: pnl.toFixed(2),
        });
        clearState(); // ✅ Clear state after close
      }
      return;
    }

    // ── Validate indicators ───────────────────────────────
    if (!curEma || !curRsi || !curAdx || !prevAdx || !curAtr ||
        !curVSma || !curVwap || stDir15 === null ||
        stDir1h === null || stDir1h === undefined) {
      console.log("⏳ Indicators not ready yet. Skipping.");
      return;
    }

    // ── SIGNAL CHECK ──────────────────────────────────────
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

    if (!buySignal && !sellSignal) {
      console.log("\n⏳ No signal this bar. Conditions check:");
      console.log("  BUY conditions:");
      console.log(`    ST15===-1    : ${stDir15 === -1}  (got ${stDir15})`);
      console.log(`    ST1h===-1    : ${stDir1h === -1}  (got ${stDir1h})`);
      console.log(`    price>VWAP   : ${price > curVwap}  ($${price.toFixed(0)} vs $${curVwap.toFixed(0)})`);
      console.log(`    price>EMA200 : ${price > curEma}  ($${price.toFixed(0)} vs $${curEma.toFixed(0)})`);
      console.log(`    RSI 58-72    : ${curRsi > 58 && curRsi < 72}  (RSI=${curRsi.toFixed(1)})`);
      console.log(`    ADX>32+rising: ${curAdx > 32 && curAdx > prevAdx}  (ADX=${curAdx.toFixed(1)}, prev=${prevAdx.toFixed(1)})`);
      console.log(`    Vol>1.2x avg : ${v15[i] > curVSma * 1.2}  (${(v15[i] / curVSma).toFixed(2)}x)`);
      console.log("  SELL conditions:");
      console.log(`    ST15===1     : ${stDir15 === 1}  (got ${stDir15})`);
      console.log(`    ST1h===1     : ${stDir1h === 1}  (got ${stDir1h})`);
      console.log(`    price<VWAP   : ${price < curVwap}  ($${price.toFixed(0)} vs $${curVwap.toFixed(0)})`);
      console.log(`    price<EMA200 : ${price < curEma}  ($${price.toFixed(0)} vs $${curEma.toFixed(0)})`);
      console.log(`    RSI 28-42    : ${curRsi > 28 && curRsi < 42}  (RSI=${curRsi.toFixed(1)})`);
      console.log(`    ADX>32+rising: ${curAdx > 32 && curAdx > prevAdx}  (ADX=${curAdx.toFixed(1)}, prev=${prevAdx.toFixed(1)})`);
      console.log(`    Vol>1.2x avg : ${v15[i] > curVSma * 1.2}  (${(v15[i] / curVSma).toFixed(2)}x)`);
      return;
    }

    // ── ✅ DUPLICATE ENTRY GUARD ──────────────────────────
    // Double-check with Binance before placing order
    const livePos = await fetchBinancePosition();
    if (livePos) {
      console.log(`⚠️  Skipping entry: Binance already has ${livePos.side.toUpperCase()} ${livePos.size} BTC open!`);
      console.log("   Bot state was out of sync. Reconciling...");
      // If openTrade is null but position exists — restore state partially
      if (!openTrade) {
        openTrade = { side: livePos.side, entryPrice: livePos.entryPrice, entryTime: curTime };
        tsm.open(livePos.side, livePos.entryPrice, curAtr);
        saveState();
        console.log(`✅ State restored from live position: ${livePos.side.toUpperCase()} @ $${livePos.entryPrice}`);
      }
      return;
    }

    // ── ENTER TRADE ───────────────────────────────────────
    const side = buySignal ? 'long' : 'short';
    console.log(`\n🚨 SIGNAL: ${side.toUpperCase()} @ $${price.toFixed(2)}`);
    console.log(`   SL = $${(side === 'long' ? price - curAtr * 1.5 : price + curAtr * 1.5).toFixed(2)}`);

    appendLog({ event: "signal", side, price, atr: curAtr, rsi: curRsi, adx: curAdx });

    const order = await placeOrder(side);
    if (order) {
      const entryPrice = parseFloat(order.avgPrice) || price;
      openTrade = { side, entryPrice, entryTime: curTime };
      tsm.open(side, entryPrice, curAtr);
      saveState(); // ✅ Persist immediately after entry
      appendLog({ event: "open", side, entryPrice, sl: tsm.currentSL });
      console.log(`📍 Trade Opened @ $${entryPrice.toFixed(2)} | SL: $${tsm.currentSL.toFixed(2)}`);
    }

  } catch (err) {
    console.error("❌ Tick Error:", err.message);
    appendLog({ event: "error", msg: err.message });
  }
}

// ══════════════════════════════════════════════════════════
//  SMART SCHEDULER
// ══════════════════════════════════════════════════════════

function msUntilNext15mClose() {
  const now   = Date.now();
  const ms15m = 15 * 60 * 1000;
  const offset = 10 * 1000;
  return ms15m - (now % ms15m) + offset;
}

async function start() {
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║   🤖 LIVE BOT — Exact Pooja.js Logic                ║");
  console.log(`║   Symbol: ${SYMBOL} | Lot: ${LOT_SIZE} BTC | Leverage: ${LEVERAGE}x          ║`);
  console.log(`║   Effective Position: ${EFFECTIVE_LOT} BTC per trade              ║`);
  console.log(`║   Signals: 15m + 1h MTF | No 5m                     ║`);
  console.log("╚══════════════════════════════════════════════════════╝\n");

  await setLeverage();
  await reconcileOnStartup(); // ✅ NEW: sync state before first tick

  await tick();

  const wait = msUntilNext15mClose();
  console.log(`\n⏰ Next check in ${(wait / 1000 / 60).toFixed(1)} minutes (at next 15m close)...`);

  setTimeout(async function loop() {
    await tick();
    const nextWait = msUntilNext15mClose();
    console.log(`\n⏰ Next check in ${(nextWait / 1000 / 60).toFixed(1)} minutes...`);
    setTimeout(loop, nextWait);
  }, wait);
}

start().catch(console.error);
