"use strict";

/**
 * ══════════════════════════════════════════════════════════
 *  65 Ultra-Sniper — TradingView Webhook Server
 *
 *  FLOW:
 *  TradingView Alert → Webhook (POST /webhook) → Binance Order
 *
 *  ✅ TradingView alert aate hi turant order place hota hai
 *  ✅ SL + Trail stop auto manage
 *  ✅ Demo mode (TESTNET=true) — real paise nahi
 *  ✅ Live mode (TESTNET=false) — real trading
 *
 *  Setup:
 *    1. npm install express binance-api-node dotenv
 *    2. .env mein API keys daalo
 *    3. node webhook_server.js
 *    4. ngrok/cloudflare se public URL lo
 *    5. TradingView alert mein webhook URL daalo
 * ══════════════════════════════════════════════════════════
 */

require("dotenv").config();
const express = require("express");
const Binance = require("binance-api-node").default;

const app = express();
app.use(express.json());

// ═══════════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════════
const CONFIG = {
  PORT:          3000,
  SYMBOL:        "BTCUSDT",
  TRADE_USDT:    50,            // har trade mein kitna USDT (chhota start karo)
  LEVERAGE:      5,
  SL_MULT:       1.5,           // ATR × 1.5
  TRAIL_PTS:     2.0,           // $2 trail activate (Pine exact)
  TRAIL_OFF:     0.5,           // $0.5 trail offset (Pine exact)
  TESTNET:       true,          // ⚠️ pehle true rakhke test karo!
  SECRET:        process.env.WEBHOOK_SECRET || "sniper65secret",  // TV alert mein yahi daalo
  MAX_DAILY_LOSS: 100,
};

// ═══════════════════════════════════════════════
//  Binance Client
// ═══════════════════════════════════════════════
const client = Binance({
  apiKey:    process.env.BINANCE_API_KEY    || "",
  apiSecret: process.env.BINANCE_API_SECRET || "",
  futures:   true,
});

// ═══════════════════════════════════════════════
//  State
// ═══════════════════════════════════════════════
const S = {
  pos:          null,    // "LONG" | "SHORT" | null
  entry:        0,
  qty:          0,
  sl:           0,
  trailPeak:    0,
  trailActive:  false,
  atr:          0,
  dailyPnl:     0,
  trades:       0,
  wins:         0,
  losses:       0,
  gw:           0,
  gl:           0,
  history:      [],
  lastSignal:   "",
};

// ═══════════════════════════════════════════════
//  Logger
// ═══════════════════════════════════════════════
function log(msg, t = "i") {
  const IST  = { timeZone: "Asia/Kolkata", hour12: false };
  const ts   = new Date().toLocaleString("en-IN", IST);
  const icon = { i:"📌", t:"💰", w:"✅", l:"❌", x:"⚠️ ", e:"🔥" }[t] || "📌";
  console.log(`[${ts}] ${icon}  ${msg}`);
}

// ═══════════════════════════════════════════════
//  Binance Helpers
// ═══════════════════════════════════════════════
async function getPrice() {
  const prices = await client.futuresPrices();
  return parseFloat(prices[CONFIG.SYMBOL]);
}

async function getBalance() {
  if (CONFIG.TESTNET) return 99999;
  const acc  = await client.futuresAccountBalance();
  const usdt = acc.find(b => b.asset === "USDT");
  return usdt ? parseFloat(usdt.availableBalance) : 0;
}

async function getQtyPrecision() {
  const info   = await client.futuresExchangeInfo();
  const sym    = info.symbols.find(s => s.symbol === CONFIG.SYMBOL);
  const filter = sym?.filters.find(f => f.filterType === "LOT_SIZE");
  const step   = parseFloat(filter?.stepSize || "0.001");
  return step >= 1 ? 0 : step.toString().split(".")[1]?.length || 3;
}

async function placeOrder(side, qty) {
  if (CONFIG.TESTNET) {
    log(`[DEMO] ${side} ${qty} ${CONFIG.SYMBOL} @ market`, "t");
    return true;
  }
  try {
    const order = await client.futuresOrder({
      symbol:   CONFIG.SYMBOL,
      side,
      type:     "MARKET",
      quantity: qty.toString(),
    });
    log(`Order OK: ${side} ${qty} | ID: ${order.orderId}`, "t");
    return true;
  } catch (e) {
    log(`Order FAIL: ${e.message}`, "e");
    return false;
  }
}

async function setLeverage() {
  if (CONFIG.TESTNET) return;
  try {
    await client.futuresLeverage({ symbol: CONFIG.SYMBOL, leverage: CONFIG.LEVERAGE });
  } catch (e) { /* already set */ }
}

// ═══════════════════════════════════════════════
//  Trail Stop (Pine exact)
// ═══════════════════════════════════════════════
function checkTrail(price) {
  if (!S.pos) return false;
  const buy = S.pos === "LONG";

  if (buy  && price > S.trailPeak) S.trailPeak = price;
  if (!buy && price < S.trailPeak) S.trailPeak = price;

  const move = buy ? S.trailPeak - S.entry : S.entry - S.trailPeak;
  if (move >= CONFIG.TRAIL_PTS) S.trailActive = true;

  if (S.trailActive) {
    const nsl = buy ? S.trailPeak - CONFIG.TRAIL_OFF : S.trailPeak + CONFIG.TRAIL_OFF;
    if (buy  && nsl > S.sl) S.sl = nsl;
    if (!buy && nsl < S.sl) S.sl = nsl;
  }

  return buy ? price <= S.sl : price >= S.sl;
}

// ═══════════════════════════════════════════════
//  Enter Position
// ═══════════════════════════════════════════════
async function enterTrade(side, price, atr) {
  if (S.pos) {
    log(`Already in ${S.pos} — signal ignore`, "x");
    return { ok: false, msg: "Position already open" };
  }

  if (S.dailyPnl <= -CONFIG.MAX_DAILY_LOSS) {
    log(`Daily loss limit hit ($${S.dailyPnl.toFixed(2)}) — no new trades`, "x");
    return { ok: false, msg: "Daily loss limit" };
  }

  const precision = await getQtyPrecision();
  const qty       = parseFloat((CONFIG.TRADE_USDT / price).toFixed(precision));
  if (qty <= 0) return { ok: false, msg: "Qty too small" };

  const orderSide = side === "buy" ? "BUY" : "SELL";
  const ok        = await placeOrder(orderSide, qty);
  if (!ok) return { ok: false, msg: "Order failed" };

  S.pos        = side === "buy" ? "LONG" : "SHORT";
  S.entry      = price;
  S.qty        = qty;
  S.atr        = atr;
  S.trailPeak  = price;
  S.trailActive= false;
  S.sl         = side === "buy"
    ? price - atr * CONFIG.SL_MULT
    : price + atr * CONFIG.SL_MULT;
  S.trades++;

  log(`${S.pos} ENTRY #${S.trades} @ $${price.toFixed(2)} | SL: $${S.sl.toFixed(2)} | Qty: ${qty}`, "t");
  return { ok: true, pos: S.pos, entry: price, sl: S.sl, qty };
}

// ═══════════════════════════════════════════════
//  Exit Position
// ═══════════════════════════════════════════════
async function exitTrade(price, reason) {
  if (!S.pos) return { ok: false, msg: "No open position" };

  const closeSide = S.pos === "LONG" ? "SELL" : "BUY";
  await placeOrder(closeSide, S.qty);

  const pnl = S.pos === "LONG"
    ? (price - S.entry) * S.qty
    : (S.entry - price) * S.qty;

  S.dailyPnl += pnl;
  if (pnl > 0) { S.wins++; S.gw += pnl; }
  else         { S.losses++; S.gl += Math.abs(pnl); }

  S.history.push({ n: S.trades, side: S.pos, entry: S.entry, exit: price, pnl, reason });

  const t = pnl >= 0 ? "w" : "l";
  log(`${S.pos} EXIT @ $${price.toFixed(2)} | PnL: $${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} | ${reason}`, t);

  const prev = S.pos;
  S.pos = null; S.entry = 0; S.qty = 0; S.sl = 0;
  S.trailPeak = 0; S.trailActive = false;

  return { ok: true, pnl, reason, side: prev };
}

// ═══════════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════════

// Health check
app.get("/", (req, res) => {
  const aw = S.wins   > 0 ? S.gw / S.wins   : 0;
  const al = S.losses > 0 ? S.gl / S.losses : 0;
  const pf = S.gl > 0 ? (S.gw / S.gl).toFixed(2) : "∞";
  res.json({
    status:   "running",
    mode:     CONFIG.TESTNET ? "DEMO" : "LIVE",
    symbol:   CONFIG.SYMBOL,
    position: S.pos || "flat",
    entry:    S.entry || null,
    sl:       S.sl || null,
    trades:   S.trades,
    wins:     S.wins,
    losses:   S.losses,
    dailyPnl: S.dailyPnl.toFixed(2),
    profitFactor: pf,
    avgWin:   aw.toFixed(2),
    avgLoss:  al.toFixed(2),
  });
});

// ── MAIN WEBHOOK ─────────────────────────────
//
//  TradingView Alert Message format:
//  {
//    "secret": "sniper65secret",
//    "action": "buy",          // "buy" | "sell" | "close" | "check_sl"
//    "price":  {{close}},
//    "atr":    {{plot_0}}      // ATR value — Pine mein plot karo
//  }
//
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;
    log(`Webhook received: ${JSON.stringify(body)}`);

    // Secret check
    if (body.secret !== CONFIG.SECRET) {
      log("Wrong secret!", "x");
      return res.status(403).json({ error: "Unauthorized" });
    }

    const { action, price, atr } = body;
    const p   = parseFloat(price);
    const atrV= parseFloat(atr) || S.atr || 200;

    // ── Actions ──────────────────────────────

    if (action === "buy") {
      // TradingView ne BUY signal diya
      if (S.pos === "SHORT") {
        // Pehle short close karo
        await exitTrade(p, "Reverse Signal (Buy)");
      }
      const result = await enterTrade("buy", p, atrV);
      return res.json(result);
    }

    if (action === "sell") {
      // TradingView ne SELL signal diya
      if (S.pos === "LONG") {
        // Pehle long close karo
        await exitTrade(p, "Reverse Signal (Sell)");
      }
      const result = await enterTrade("sell", p, atrV);
      return res.json(result);
    }

    if (action === "close") {
      // Manually close karo
      const result = await exitTrade(p, "Manual Close (TV Alert)");
      return res.json(result);
    }

    if (action === "check_sl") {
      // Price update bhejo — trail SL check karo
      const stopped = checkTrail(p);
      if (stopped) {
        const result = await exitTrade(S.sl, S.trailActive ? "Trail SL" : "Initial SL");
        return res.json({ stopped: true, ...result });
      }
      return res.json({
        stopped:     false,
        pos:         S.pos,
        currentSL:   S.sl,
        trailActive: S.trailActive,
        price:       p,
      });
    }

    return res.json({ ok: false, msg: "Unknown action: " + action });

  } catch (err) {
    log(`Webhook error: ${err.message}`, "e");
    res.status(500).json({ error: err.message });
  }
});

// Stats endpoint
app.get("/stats", (req, res) => {
  const pf  = S.gl > 0 ? (S.gw / S.gl).toFixed(2) : "∞";
  const acc = S.trades > 0 ? (S.wins / S.trades * 100).toFixed(1) : "0";
  res.json({
    trades: S.trades, wins: S.wins, losses: S.losses,
    accuracy: acc + "%", profitFactor: pf,
    dailyPnl: S.dailyPnl.toFixed(2),
    history: S.history.slice(-10),  // last 10 trades
  });
});

// ═══════════════════════════════════════════════
//  START SERVER
// ═══════════════════════════════════════════════
async function start() {
  console.clear();
  console.log("╔════════════════════════════════════════════╗");
  console.log("║  ⚡  65 Ultra-Sniper — Webhook Server      ║");
  console.log("║  TradingView Alert → Binance Order         ║");
  console.log("╚════════════════════════════════════════════╝\n");

  if (!CONFIG.TESTNET && (!process.env.BINANCE_API_KEY || !process.env.BINANCE_API_SECRET)) {
    console.log("❌ .env mein BINANCE_API_KEY aur BINANCE_API_SECRET daalo!\n");
    process.exit(1);
  }

  if (!CONFIG.TESTNET) await setLeverage();

  app.listen(CONFIG.PORT, () => {
    console.log(`  Mode     : ${CONFIG.TESTNET ? "🧪 DEMO (paper trading)" : "🔴 LIVE TRADING"}`);
    console.log(`  Symbol   : ${CONFIG.SYMBOL}`);
    console.log(`  Trade    : $${CONFIG.TRADE_USDT} per trade`);
    console.log(`  Leverage : ${CONFIG.LEVERAGE}x`);
    console.log(`  Secret   : ${CONFIG.SECRET}`);
    console.log(`\n  Server   : http://localhost:${CONFIG.PORT}`);
    console.log(`  Webhook  : http://localhost:${CONFIG.PORT}/webhook`);
    console.log(`  Stats    : http://localhost:${CONFIG.PORT}/stats`);
    console.log(`\n  ⚡ Waiting for TradingView alerts...\n`);
    log(`Server started on port ${CONFIG.PORT}`);
  });
}

start();