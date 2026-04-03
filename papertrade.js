"use strict";
/**
 * PaperTrade.js — Fixed Version
 * ✅ Direct HTTPS — ccxt bypass (testnet fix)
 * ✅ Binance Testnet | $10,000 capital | 0.01 BTC lot
 * ✅ $2 slippage | 15m candle close entry
 */

const https  = require('https');
const crypto = require('crypto');
const ccxt   = require('ccxt');

// ══════════════════════════════════════════
//  🔑 APNI TESTNET KEYS YAHAN DALO
// ══════════════════════════════════════════
const API_KEY    = 'NqBIUSvj1PVWJja7hsNAO9FsL4FMaeVi6kW1WJkOX46771Ly2pwFmGztxndXiDrH';
const API_SECRET = 'BdXtTrK0iHPhzOnbLA7Mu4baneR5wAeYGlGXDMuWZT9trOjSBuQjihDkHKHGGtJG';
// ══════════════════════════════════════════

const LOT_SIZE = 0.001;  // $100 ke liye 0.001 BTC (~$67-95)
const SLIPPAGE = 2;
const SYMBOL   = 'BTC/USDT';
const INTERVAL = 15; // minutes

// ── Direct Binance Testnet API ────────────
function sign(q) {
    return crypto.createHmac('sha256', API_SECRET).update(q).digest('hex');
}

function testnetCall(method, path, params = {}) {
    return new Promise((resolve, reject) => {
        const ts  = Date.now();
        const qs  = `timestamp=${ts}` +
            (Object.keys(params).length ? '&' + new URLSearchParams(params).toString() : '');
        const sig = sign(qs);
        const fullPath = `/api/v3/${path}?${qs}&signature=${sig}`;

        const options = {
            hostname: 'testnet.binance.vision',
            port:     443,
            path:     fullPath,
            method:   method,
            headers: {
                'X-MBX-APIKEY': API_KEY,
                'Content-Type': 'application/json'
            }
        };

        const req = https.request(options, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error('Parse error: ' + data)); }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

// Place market order via direct API
function testnetOrderCall(side, qty) {
    return new Promise((resolve, reject) => {
        const ts     = Date.now();
        const params = `symbol=BTCUSDT&side=${side}&type=MARKET&quantity=${qty}&timestamp=${ts}`;
        const sig    = sign(params);
        const body   = `${params}&signature=${sig}`;

        const options = {
            hostname: 'testnet.binance.vision',
            port:     443,
            path:     '/api/v3/order',
            method:   'POST',
            headers: {
                'X-MBX-APIKEY':  API_KEY,
                'Content-Type':  'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(body)
            }
        };

        const req = https.request(options, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error('Parse error: ' + data)); }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// ── Indicator Functions ───────────────────
function calcRMA(data, period) {
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
function calcEMA(data, period) {
    const result = new Array(data.length).fill(null);
    if (data.length < period) return result;
    const alpha = 2 / (period + 1);
    let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
    result[period - 1] = ema;
    for (let i = period; i < data.length; i++) {
        ema = alpha * data[i] + (1 - alpha) * ema;
        result[i] = ema;
    }
    return result;
}
function calcSMA(data, period) {
    return data.map((_, i) => {
        if (i < period - 1) return null;
        return data.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
    });
}
function calcATR(h, l, c, period) {
    const trs = new Array(h.length).fill(null);
    for (let i = 1; i < h.length; i++)
        trs[i] = Math.max(h[i]-l[i], Math.abs(h[i]-c[i-1]), Math.abs(l[i]-c[i-1]));
    const result = new Array(h.length).fill(null);
    let seed = 0;
    for (let i = 1; i <= period; i++) seed += trs[i];
    result[period] = seed / period;
    const alpha = 1 / period;
    for (let i = period + 1; i < h.length; i++)
        result[i] = alpha * trs[i] + (1 - alpha) * result[i - 1];
    return result;
}
function calcRSI(closes, period) {
    const result = new Array(closes.length).fill(null);
    const gains = [], losses = [];
    for (let i = 1; i < closes.length; i++) {
        const d = closes[i] - closes[i-1];
        gains.push(Math.max(d, 0)); losses.push(Math.max(-d, 0));
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
function calcADX(h, l, c, period) {
    const trs = [], pdms = [], mdms = [];
    for (let i = 1; i < h.length; i++) {
        const up = h[i]-h[i-1], dn = l[i-1]-l[i], pc = c[i-1];
        trs.push(Math.max(h[i]-l[i], Math.abs(h[i]-pc), Math.abs(l[i]-pc)));
        pdms.push(up > dn && up > 0 ? up : 0);
        mdms.push(dn > up && dn > 0 ? dn : 0);
    }
    const str = calcRMA(trs, period), spdm = calcRMA(pdms, period), smdm = calcRMA(mdms, period);
    const dx = str.map((s, i) => {
        if (!s || s === 0) return 0;
        const p = spdm[i]/s*100, m = smdm[i]/s*100, sum = p + m;
        return sum === 0 ? 0 : Math.abs(p-m)/sum*100;
    });
    const adxRaw = calcRMA(dx, period);
    const adxArr = new Array(h.length).fill(null);
    for (let i = 0; i < adxRaw.length; i++) adxArr[i+1] = adxRaw[i];
    return adxArr;
}
function calcSuperTrend(h, l, c, factor, atrPeriod) {
    const atr = calcATR(h, l, c, atrPeriod);
    const dir = new Array(c.length).fill(null);
    let pU=0, pL=0, pC=0, trend=null;
    for (let i = 1; i < c.length; i++) {
        if (!atr[i]) { pC = c[i]; continue; }
        const hl2 = (h[i]+l[i])/2;
        let up = hl2+factor*atr[i], lo = hl2-factor*atr[i];
        lo = lo > pL || pC < pL ? lo : pL;
        up = up < pU || pC > pU ? up : pU;
        if (!atr[i-1]) trend = 1;
        else if (trend === -1 && c[i] > up) trend = 1;
        else if (trend === 1  && c[i] < lo) trend = -1;
        if (!trend) trend = 1;
        dir[i] = -trend; pU = up; pL = lo; pC = c[i];
    }
    return dir;
}
function calcVWAP(ohlcv) {
    const vwap = new Array(ohlcv.length).fill(null);
    let tv=0, v=0, lastDate=null;
    for (let i = 0; i < ohlcv.length; i++) {
        const d = new Date(ohlcv[i][0]).getUTCDate();
        if (lastDate !== null && d !== lastDate) { tv = 0; v = 0; }
        const tp = (ohlcv[i][2]+ohlcv[i][3]+ohlcv[i][4])/3;
        tv += tp*ohlcv[i][5]; v += ohlcv[i][5];
        vwap[i] = v === 0 ? null : tv/v; lastDate = d;
    }
    return vwap;
}

// ── Trailing Stop ─────────────────────────
class TSM {
    constructor() { this.reset(); }
    reset() { this.active=false;this.side=null;this.entryPrice=0;this.currentSL=0;this.trailActive=false;this.peakPrice=0;this.atr=0; }
    open(side, ep, atr) {
        this.reset(); this.active=true; this.side=side;
        this.entryPrice=ep; this.peakPrice=ep; this.atr=atr;
        this.currentSL = side==='long' ? ep-atr*1.5 : ep+atr*1.5;
    }
    update(high, low) {
        if (!this.active) return { stopped: false };
        const isBuy = this.side === 'long';
        if (isBuy  && high > this.peakPrice) this.peakPrice = high;
        if (!isBuy && low  < this.peakPrice) this.peakPrice = low;
        const move = isBuy ? this.peakPrice-this.entryPrice : this.entryPrice-this.peakPrice;
        if (move >= this.atr * 1.0) this.trailActive = true;
        if (this.trailActive) {
            const nsl = isBuy ? this.peakPrice-this.atr : this.peakPrice+this.atr;
            if (isBuy  && nsl > this.currentSL) this.currentSL = nsl;
            if (!isBuy && nsl < this.currentSL) this.currentSL = nsl;
        }
        const stopped = isBuy ? low <= this.currentSL : high >= this.currentSL;
        return { stopped, exitPrice: this.currentSL };
    }
    close() { this.reset(); }
}

// ── State ─────────────────────────────────
let position   = null;
let fillEntry  = 0;
let entryPrice = 0;
const tsm      = new TSM();
let balance    = 100;
const startBal = 100;
let tradeLog   = [];
let tickCount  = 0;

// ── Public exchange for OHLCV only ────────
const publicEx = new ccxt.binance();

// ── Check Balance ─────────────────────────
async function checkBalance() {
    const data = await testnetCall('GET', 'account');
    if (data.code) {
        console.log(`  ❌ Balance error ${data.code}: ${data.msg}`);
        return null;
    }
    const usdt = parseFloat(data.balances.find(b => b.asset==='USDT')?.free || 0);
    const btc  = parseFloat(data.balances.find(b => b.asset==='BTC')?.free  || 0);
    console.log(`  💰 Testnet Balance → USDT: $${usdt.toFixed(2)} | BTC: ${btc.toFixed(4)}`);
    return { usdt, btc };
}

// ── Place Order ───────────────────────────
async function placeOrder(side, qty) {
    try {
        const order = await testnetOrderCall(side.toUpperCase(), qty);
        if (order.code) {
            console.log(`  ❌ Order failed ${order.code}: ${order.msg}`);
            return null;
        }
        console.log(`  ✅ ORDER PLACED → ${side.toUpperCase()} ${qty} BTC`);
        console.log(`     Order ID : ${order.orderId}`);
        console.log(`     Status   : ${order.status}`);
        return order;
    } catch (err) {
        console.error(`  ❌ Order error: ${err.message}`);
        return null;
    }
}

// ── Main Tick ─────────────────────────────
async function tick() {
    tickCount++;
    const now = new Date().toISOString();
    console.log(`\n${'─'.repeat(62)}`);
    console.log(`  ⏱️  Tick #${tickCount} | ${now}`);

    try {
        // Fetch 300 closed 15m candles (public — no auth needed)
        const ohlcv = await publicEx.fetchOHLCV(SYMBOL, '15m', undefined, 300);
        const bars  = ohlcv.slice(0, -1); // remove unclosed candle
        const n     = bars.length;

        const H = bars.map(d=>d[2]), L = bars.map(d=>d[3]);
        const C = bars.map(d=>d[4]), V = bars.map(d=>d[5]);

        const ema200 = calcEMA(C, 200);
        const rsi    = calcRSI(C, 14);
        const adx    = calcADX(H, L, C, 14);
        const atr    = calcATR(H, L, C, 14);
        const volSma = calcSMA(V, 20);
        const vwap   = calcVWAP(bars);
        const stDir  = calcSuperTrend(H, L, C, 4, 12);

        const i       = n - 1; // latest closed bar
        const price   = C[i];
        const curEma  = ema200[i], curRsi = rsi[i];
        const curAdx  = adx[i],   prevAdx = adx[i-1];
        const curAtr  = atr[i],   curVSma = volSma[i];
        const curVwap = vwap[i],  dir15   = stDir[i];

        console.log(`  📈 Price  : $${price.toFixed(2)}`);
        console.log(`  EMA200: ${curEma?.toFixed(2)} | RSI: ${curRsi?.toFixed(2)} | ADX: ${curAdx?.toFixed(2)} | ATR: ${curAtr?.toFixed(2)}`);
        console.log(`  VWAP : ${curVwap?.toFixed(2)} | ST Dir: ${dir15} | Vol>${curVSma?.toFixed(0)}: ${V[i]>curVSma*1.2?'✅':'❌'}`);
        console.log(`  Position: ${position || 'NONE'}`);

        if (!curEma||!curRsi||!curAdx||!prevAdx||!curAtr||!curVSma||!curVwap||dir15===null) {
            console.log('  ⚠️  Indicators warming up...');
            return;
        }

        // ── EXIT ──────────────────────────────────
        if (position) {
            const { stopped, exitPrice } = tsm.update(H[i], L[i]);
            if (stopped) {
                const fillExit = position === 'long'
                    ? exitPrice - SLIPPAGE
                    : exitPrice + SLIPPAGE;
                const pnl = position === 'long'
                    ? (fillExit - fillEntry) * LOT_SIZE
                    : (fillEntry - fillExit) * LOT_SIZE;

                balance += pnl;

                console.log(`\n  🔴 EXIT ${position.toUpperCase()} — SL Hit`);
                console.log(`     Entry : $${fillEntry.toFixed(2)}`);
                console.log(`     Exit  : $${fillExit.toFixed(2)}`);
                console.log(`     PnL   : $${pnl.toFixed(2)} ${pnl > 0 ? '✅ WIN' : '❌ LOSS'}`);
                console.log(`     Balance: $${balance.toFixed(2)}`);

                const closeSide = position === 'long' ? 'SELL' : 'BUY';
                await placeOrder(closeSide, LOT_SIZE);

                tradeLog.push({
                    time:    now,
                    side:    position,
                    entry:   fillEntry.toFixed(2),
                    exit:    fillExit.toFixed(2),
                    pnl:     pnl.toFixed(2),
                    result:  pnl > 0 ? 'WIN' : 'LOSS',
                    balance: balance.toFixed(2)
                });

                position = null; tsm.close();
            } else {
                console.log(`  🔒 Holding ${position.toUpperCase()} | SL: $${tsm.currentSL.toFixed(2)} | Peak: $${tsm.peakPrice.toFixed(2)}`);
            }
        }

        // ── ENTRY ─────────────────────────────────
        if (!position) {
            const buySignal =
                dir15 === -1 &&
                price > curVwap && price > curEma &&
                curRsi > 58 && curRsi < 72 &&
                curAdx > 32 && curAdx > prevAdx &&
                V[i] > curVSma * 1.2;

            const sellSignal =
                dir15 === 1 &&
                price < curVwap && price < curEma &&
                curRsi > 28 && curRsi < 42 &&
                curAdx > 32 && curAdx > prevAdx &&
                V[i] > curVSma * 1.2;

            if (buySignal) {
                entryPrice = price;
                fillEntry  = price + SLIPPAGE;
                position   = 'long';
                tsm.open('long', fillEntry, curAtr);

                console.log(`\n  🟢 BUY SIGNAL!`);
                console.log(`     Entry : $${fillEntry.toFixed(2)} (+$${SLIPPAGE} slippage)`);
                console.log(`     SL    : $${tsm.currentSL.toFixed(2)}`);
                console.log(`     PosVal: $${(fillEntry*LOT_SIZE).toFixed(2)}`);
                await placeOrder('BUY', LOT_SIZE);

            } else if (sellSignal) {
                entryPrice = price;
                fillEntry  = price - SLIPPAGE;
                position   = 'short';
                tsm.open('short', fillEntry, curAtr);

                console.log(`\n  🔴 SELL SIGNAL!`);
                console.log(`     Entry : $${fillEntry.toFixed(2)} (-$${SLIPPAGE} slippage)`);
                console.log(`     SL    : $${tsm.currentSL.toFixed(2)}`);
                console.log(`     PosVal: $${(fillEntry*LOT_SIZE).toFixed(2)}`);
                await placeOrder('SELL', LOT_SIZE);

            } else {
                // Show why no signal
                console.log(`  ⏳ No signal | Conditions:`);
                console.log(`     ST=${dir15} RSI=${curRsi?.toFixed(1)} ADX=${curAdx?.toFixed(1)} Price${price>curVwap?'>':'<'}VWAP Price${price>curEma?'>':'<'}EMA`);
            }
        }

        // ── P&L Summary ───────────────────────────
        const net = balance - startBal;
        const wins = tradeLog.filter(t=>t.result==='WIN').length;
        console.log(`\n  📊 P&L → Trades:${tradeLog.length} | Wins:${wins} | Balance:$${balance.toFixed(2)} | Net:$${net.toFixed(2)}`);

    } catch (err) {
        console.error(`  ❌ Tick error: ${err.message}`);
    }
}

// ── Scheduler ────────────────────────────
async function waitAndRun() {
    const now   = Date.now();
    const ms15  = INTERVAL * 60 * 1000;
    const next  = Math.ceil(now / ms15) * ms15 + 5000; // 5s after candle close
    const wait  = next - now;
    const mins  = Math.floor(wait / 60000);
    const secs  = Math.floor((wait % 60000) / 1000);
    console.log(`\n  ⏰ Next candle close in: ${mins}m ${secs}s`);
    setTimeout(async () => { await tick(); waitAndRun(); }, wait);
}

// ── Start ─────────────────────────────────
async function main() {
    console.log('═'.repeat(62));
    console.log('  🚀 PAPER TRADE BOT — Binance Testnet (Fixed)');
    console.log('  Symbol   : BTC/USDT | Lot: 0.001 BTC | Cap: $100');
    console.log('  Slippage : $2/side | Direct API (no ccxt auth)');
    console.log('═'.repeat(62));

    if (API_KEY === 'APNI_TESTNET_API_KEY') {
        console.log('\n❌ Keys nahi daali! PaperTrade.js me apni keys dalo.\n');
        return;
    }

    console.log('\n📊 Checking Testnet Account...');
    await checkBalance();

    await tick();
    waitAndRun();
}

main().catch(console.error);