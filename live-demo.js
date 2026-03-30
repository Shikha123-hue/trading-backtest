"use strict";

/**
 * live-demo.js — Binance Demo Account Par Live Test
 *
 * RUN: node live-demo.js
 *
 * Yeh script:
 * 1. Har 5 minute mein candles fetch karta hai
 * 2. Strategy signal check karta hai
 * 3. Demo account par automatically order place karta hai
 * 4. Trailing stop manage karta hai
 */

const https  = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { strategy, TrailingStopManager } = require("./strategy");

// ─── APNI API KEYS YAHAN DAALO ────────────────────────────
const API_KEY    = "NqBIUSvj1PVWJja7hsNAO9FsL4FMaeVi6kW1WJkOX46771Ly2pwFmGztxndXiDrH";
const API_SECRET = "BdXtTrK0iHPhzOnbLA7Mu4baneR5wAeYGlGXDMuWZT9trOjSBuQjihDkHKHGGtJG";
// ─────────────────────────────────────────────────────────

// ─── Config ───────────────────────────────────────────────
const SYMBOL     = "BTCUSDT";
const QUANTITY   = "0.001";   // Demo mein small quantity se test karo
const LEVERAGE   = 20;
// Demo Binance URL (Real nahi!)
const BASE_URL   = "testnet.binancefuture.com";
const SIGNAL_ONLY_ON_AUTH_ERROR = true;
// ─────────────────────────────────────────────────────────

const tsm = new TrailingStopManager();
let openTrade = null;
let candles5m_cache  = [];
let candles15m_cache = [];
let tradingEnabled = true;
const logsDir = path.join(__dirname, "logs");
const liveLogFile = path.join(logsDir, "live-signals.jsonl");

function appendLiveLog(event) {
  fs.appendFileSync(liveLogFile, JSON.stringify(event) + "\n");
}

// ─── HTTP Request Helper ───────────────────────────────────
function apiRequest(method, path, params = {}) {
  return new Promise((resolve, reject) => {
    const timestamp = Date.now();
    params.timestamp = timestamp;

    // Query string banao
    const qs  = Object.entries(params).map(([k, v]) => `${k}=${v}`).join("&");
    const sig = crypto.createHmac("sha256", API_SECRET).update(qs).digest("hex");
    const fullQS = `${qs}&signature=${sig}`;

    const options = {
      hostname: BASE_URL,
      path:     method === "GET" ? `${path}?${fullQS}` : path,
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

// ─── Public Kline Fetch ────────────────────────────────────
function fetchKlines(symbol, interval, limit = 1000) {
  return new Promise((resolve, reject) => {
    const url = `https://${BASE_URL}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
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
      res.on("error", reject);
    }).on("error", reject);
  });
}

// ─── Leverage Set Karo ─────────────────────────────────────
async function setLeverage() {
  try {
    const res = await apiRequest("POST", "/fapi/v1/leverage", {
      symbol:   SYMBOL,
      leverage: LEVERAGE,
    });

    if (res && typeof res.leverage !== "undefined") {
      console.log(`✅ Leverage set: ${res.leverage}x`);
      return;
    }

    if (res && (res.code || res.msg)) {
      console.error(`❌ Leverage set rejected: [${res.code}] ${res.msg}`);
      if (SIGNAL_ONLY_ON_AUTH_ERROR && String(res.code) === "-2015") {
        tradingEnabled = false;
        console.log("ℹ️ Auth issue detected -> running in SIGNAL-ONLY mode (no real orders).");
      }
      return;
    }

    console.error("❌ Leverage set response unexpected:", JSON.stringify(res));
  } catch (e) {
    console.error("❌ Leverage set failed:", e.message);
  }
}

// ─── Market Order Place Karo ───────────────────────────────
async function placeOrder(side, quantity, marketPrice) {
  if (!tradingEnabled) {
    return {
      orderId: `SIM-${Date.now()}`,
      status: "FILLED",
      avgPrice: String(marketPrice),
      simulated: true,
    };
  }

  try {
    const res = await apiRequest("POST", "/fapi/v1/order", {
      symbol:   SYMBOL,
      side:     side.toUpperCase(),   // BUY ya SELL
      type:     "MARKET",
      quantity: quantity,
    });
    console.log(`✅ Order Placed: ${side.toUpperCase()} ${quantity} ${SYMBOL}`);
    console.log(`   Order ID: ${res.orderId} | Status: ${res.status}`);
    return res;
  } catch (e) {
    console.error(`❌ Order failed: ${e.message}`);
    return null;
  }
}

// ─── Position Close Karo ──────────────────────────────────
async function closePosition(side, marketPrice) {
  const closeSide = side === "buy" ? "SELL" : "BUY";
  return placeOrder(closeSide, QUANTITY, marketPrice);
}

// ─── Main Loop ─────────────────────────────────────────────
async function tick() {
  const now = new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" });
  console.log(`\n⏰ [${now}] Checking signals...`);

  try {
    // Fresh candles fetch karo
    [candles5m_cache, candles15m_cache] = await Promise.all([
      fetchKlines(SYMBOL, "5m",  1000),
      fetchKlines(SYMBOL, "15m", 500),
    ]);

    const close = candles5m_cache[candles5m_cache.length - 1].close;
    const closeTime = candles5m_cache[candles5m_cache.length - 1].time;
    console.log(`📈 ${SYMBOL} Price: $${close.toFixed(1)}`);

    // Agar trade open hai → trailing stop check karo
    if (openTrade && tsm.active) {
      const lastCandle = candles5m_cache[candles5m_cache.length - 1];
      const { stopped, currentSL, trailActive } = tsm.updateOHLC(lastCandle.high, lastCandle.low);

      console.log(`🔄 Open Trade: ${openTrade.side.toUpperCase()} @ $${openTrade.entryPrice.toFixed(1)}`);
      console.log(`   Current SL: $${currentSL.toFixed(1)} | Trail Active: ${trailActive}`);

      if (stopped) {
        console.log(`🛑 Trailing Stop Hit! Closing @ $${currentSL.toFixed(1)}`);
        await closePosition(openTrade.side, currentSL);
        const pnl = openTrade.side === "buy"
          ? (currentSL - openTrade.entryPrice) * parseFloat(QUANTITY)
          : (openTrade.entryPrice - currentSL) * parseFloat(QUANTITY);

        appendLiveLog({
          source: "live",
          event: "close",
          symbol: SYMBOL,
          side: openTrade.side,
          entryTime: openTrade.entryTime,
          exitTime: closeTime,
          entryPrice: openTrade.entryPrice,
          exitPrice: currentSL,
          pnl,
        });

        console.log(`💰 Trade Closed | PnL: $${pnl.toFixed(2)}`);
        tsm.close();
        openTrade = null;
      }
      return;
    }

    // Signal check karo
    const sig = strategy(candles5m_cache, candles15m_cache);

    if (!sig) {
      console.log("⏳ Koi signal nahi mila is bar.");
      return;
    }

    const side = sig.buy_signal ? "buy" : "sell";
    console.log(`\n🚨 SIGNAL MILA: ${side.toUpperCase()}`);
    console.log(`   ATR: ${sig.atr.toFixed(2)} | SL Mult: ${sig.sl_mult}x`);
    console.log(`   Trail Points: ${sig.trail_points} | Trail Offset: ${sig.trail_offset}`);

    appendLiveLog({
      source: "live",
      event: "signal",
      symbol: SYMBOL,
      side,
      time: closeTime,
      price: close,
      atr: sig.atr,
    });

    // Order place karo
    const order = await placeOrder(side, QUANTITY, close);
    if (order) {
      const entryPrice = parseFloat(order.avgPrice || close);
      openTrade = { side, entryPrice, entryTime: closeTime };
      appendLiveLog({
        source: "live",
        event: "open",
        symbol: SYMBOL,
        side,
        time: closeTime,
        entryPrice,
      });
      tsm.open(side, entryPrice, sig.atr, sig.trail_points, sig.trail_offset, sig.sl_mult);
      if (order.simulated) {
        console.log(`📍 [SIM] Trade Opened @ $${entryPrice} | SL: $${tsm.currentSL.toFixed(2)}`);
      } else {
        console.log(`📍 Trade Opened @ $${entryPrice} | SL: $${tsm.currentSL.toFixed(2)}`);
      }
    }

  } catch (err) {
    console.error("❌ Tick Error:", err.message);
  }
}

// ─── Start ─────────────────────────────────────────────────
async function start() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║   🤖 LIVE DEMO TRADING BOT STARTED       ║");
  console.log(`║   Symbol: ${SYMBOL} | Qty: ${QUANTITY}             ║`);
  console.log("╚══════════════════════════════════════════╝\n");

  if (API_KEY === "APNI_BINANCE_API_KEY_YAHAN") {
    console.error("❌ Pehle apni API KEY daalo live-demo.js mein!");
    console.log("   1. Binance → Profile → API Management");
    console.log("   2. Create API → Copy Key & Secret");
    console.log("   3. live-demo.js mein API_KEY aur API_SECRET update karo");
    process.exit(1);
  }

  fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(liveLogFile, "");
  console.log(`📝 Live log file: ${liveLogFile}`);

  await setLeverage();

  // Pehla tick turant run karo
  await tick();

  // Har 5 minute mein dobara check karo
  const INTERVAL_MS = 5 * 60 * 1000;
  console.log(`\n⏰ Aagla check ${INTERVAL_MS / 60000} minute mein...`);
  setInterval(async () => {
    await tick();
    console.log(`\n⏰ Aagla check ${INTERVAL_MS / 60000} minute mein...`);
  }, INTERVAL_MS);
}

start().catch(console.error);