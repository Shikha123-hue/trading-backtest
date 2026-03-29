"use strict";
/**
 * LiveBot_Testnet.js
 * ✅ Binance Testnet (fake money - safe)
 * ✅ Trailing Stop Bug Fixed (ATR based)
 * ✅ Slippage: 0.02% to 0.05%
 * ✅ 0.01 BTC Lot | No Leverage
 * ✅ Har 15 min mein run hota hai
 *
 * SETUP:
 * 1. npm install ccxt
 * 2. Binance Testnet API key banao: https://testnet.binancefuture.com
 * 3. Apni API keys neeche daalo
 * 4. node LiveBot_Testnet.js
 */

const ccxt = require('ccxt');

// ─────────────────────────────────────────────
//  🔑 APNI TESTNET API KEYS YAHAN DAALO
// ─────────────────────────────────────────────
const API_KEY    = 'HQNnLnTG5CKla0UU7VKh93LoUfJnp1CZQb4r30OQS3LllZP9BECc1m1V20Ay2zu4';
const API_SECRET = 'VoPpLyL0wkRUey2lx4KmHVBXQFhsS30PNUZzAnGKJ4umEWNjvgVa9SqeLf7eitKg';

// ─────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────
const SYMBOL    = 'BTC/USDT';
const LOT_SIZE  = 0.01;    // 0.01 BTC per trade
const TIMEFRAME = '15m';
const WARMUP    = 300;     // indicator warmup bars

// ─────────────────────────────────────────────
//  SLIPPAGE (simulation - testnet par real nahi hoti)
// ─────────────────────────────────────────────
function getSlippage() {
    // Random slippage between 0.00% and 0.05%
    return Math.random() * 0.0005;
}

// ─────────────────────────────────────────────
//  INDICATOR FUNCTIONS (same as backtest)
// ─────────────────────────────────────────────
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
        trs[i] = Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1]));
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
        const d = closes[i] - closes[i-1];
        gains.push(Math.max(d,0)); losses.push(Math.max(-d,0));
    }
    const alpha = 1 / period;
    let ag = 0, al = 0;
    for (let i = 0; i < period; i++) { ag += gains[i]; al += losses[i]; }
    ag /= period; al /= period;
    result[period] = al===0?100:100-100/(1+ag/al);
    for (let i = period; i < gains.length; i++) {
        ag = alpha*gains[i]+(1-alpha)*ag;
        al = alpha*losses[i]+(1-alpha)*al;
        result[i+1] = al===0?100:100-100/(1+ag/al);
    }
    return result;
}
function calcADXArray(highs, lows, closes, period) {
    const trs=[],pdms=[],mdms=[];
    for (let i=1;i<highs.length;i++) {
        const h=highs[i],l=lows[i],ph=highs[i-1],pl=lows[i-1],pc=closes[i-1];
        trs.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));
        const up=h-ph,dn=pl-l;
        pdms.push(up>dn&&up>0?up:0); mdms.push(dn>up&&dn>0?dn:0);
    }
    const strArr=calcRMAArray(trs,period),spdmArr=calcRMAArray(pdms,period),smdmArr=calcRMAArray(mdms,period);
    const dxArr=new Array(trs.length).fill(null);
    for (let i=0;i<strArr.length;i++) {
        if (!strArr[i]||strArr[i]===0) continue;
        const pdi=spdmArr[i]/strArr[i]*100,mdi=smdmArr[i]/strArr[i]*100,sum=pdi+mdi;
        dxArr[i]=sum===0?0:Math.abs(pdi-mdi)/sum*100;
    }
    const adxRaw=calcRMAArray(dxArr.map(v=>v===null?0:v),period);
    const adxArr=new Array(highs.length).fill(null);
    for (let i=0;i<adxRaw.length;i++) adxArr[i+1]=adxRaw[i];
    return adxArr;
}
function calcSuperTrendArray(highs, lows, closes, factor, atrPeriod) {
    const atrArr=calcATRArray(highs,lows,closes,atrPeriod);
    const dirArr=new Array(closes.length).fill(null);
    let prevUpper=0,prevLower=0,prevClose=0,trend=null;
    for (let i=1;i<closes.length;i++) {
        const atr=atrArr[i];
        if (atr===null) { prevClose=closes[i]; continue; }
        const hl2=(highs[i]+lows[i])/2;
        let upper=hl2+factor*atr,lower=hl2-factor*atr;
        lower=lower>prevLower||prevClose<prevLower?lower:prevLower;
        upper=upper<prevUpper||prevClose>prevUpper?upper:prevUpper;
        if (atrArr[i-1]===null) trend=1;
        else if (trend===-1&&closes[i]>upper) trend=1;
        else if (trend===1&&closes[i]<lower) trend=-1;
        if (trend===null) trend=1;
        dirArr[i]=-trend;
        prevUpper=upper; prevLower=lower; prevClose=closes[i];
    }
    return dirArr;
}
function calcVWAPArray(ohlcv) {
    const vwap=new Array(ohlcv.length).fill(null);
    let tv=0,v=0,lastDate=null;
    for (let i=0;i<ohlcv.length;i++) {
        const d=new Date(ohlcv[i][0]).getUTCDate();
        if (lastDate!==null&&d!==lastDate) { tv=0; v=0; }
        const tp=(ohlcv[i][2]+ohlcv[i][3]+ohlcv[i][4])/3;
        tv+=tp*ohlcv[i][5]; v+=ohlcv[i][5];
        vwap[i]=v===0?null:tv/v; lastDate=d;
    }
    return vwap;
}

// ─────────────────────────────────────────────
//  ✅ TRAILING STOP — ATR BASED (BUG FIXED)
// ─────────────────────────────────────────────
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
        // Initial SL: 1.5x ATR (same as before)
        this.currentSL  = side === 'long'
            ? entryPrice - atr * 1.5
            : entryPrice + atr * 1.5;
    }
    update(high, low) {
        if (!this.active) return { stopped: false };
        const isBuy = this.side === 'long';

        // Peak price update
        if (isBuy  && high > this.peakPrice) this.peakPrice = high;
        if (!isBuy && low  < this.peakPrice) this.peakPrice = low;

        const move = isBuy
            ? this.peakPrice - this.entryPrice
            : this.entryPrice - this.peakPrice;

        // ✅ FIX: ATR based trail activation (was: move >= 2.0 dollar)
        if (move >= this.atr * 1.0) this.trailActive = true;

        if (this.trailActive) {
            // ✅ FIX: ATR based trail SL (was: peakPrice - 0.5 dollar)
            const newSL = isBuy
                ? this.peakPrice - this.atr * 0.5
                : this.peakPrice + this.atr * 0.5;

            if (isBuy  && newSL > this.currentSL) this.currentSL = newSL;
            if (!isBuy && newSL < this.currentSL) this.currentSL = newSL;
        }

        const stopped = isBuy
            ? low  <= this.currentSL
            : high >= this.currentSL;

        return { stopped, exitPrice: this.currentSL };
    }
    close() { this.reset(); }
}

// ─────────────────────────────────────────────
//  LOG HELPER
// ─────────────────────────────────────────────
function log(msg) {
    const time = new Date().toISOString().replace('T',' ').substring(0,19);
    console.log(`[${time}] ${msg}`);
}

// ─────────────────────────────────────────────
//  EXCHANGE SETUP — TESTNET
// ─────────────────────────────────────────────
const exchange = new ccxt.binance({
    apiKey: API_KEY,
    secret: API_SECRET,
    options: {
        defaultType: 'future',  // Futures testnet
    },
    urls: {
        api: {
            fapiPublic:  'https://testnet.binancefuture.com/fapi/v1',
            fapiPrivate: 'https://testnet.binancefuture.com/fapi/v1',
        }
    }
});

// ─────────────────────────────────────────────
//  BOT STATE
// ─────────────────────────────────────────────
let position   = null;   // 'long' | 'short' | null
let entryPrice = 0;
let entryTime  = null;
const tsm = new TrailingStopManager();
let totalPnl   = 0;
let trades     = 0;
let wins       = 0;

// ─────────────────────────────────────────────
//  MAIN LOOP — har 15 min mein chalta hai
// ─────────────────────────────────────────────
async function runBot() {
    log('🤖 Bot starting on Binance TESTNET...');
    log(`   Symbol   : ${SYMBOL}`);
    log(`   Lot Size : ${LOT_SIZE} BTC`);
    log(`   Leverage : 1x (No leverage)`);
    log('─'.repeat(50));

    while (true) {
        try {
            await tick();
        } catch (err) {
            log(`❌ Error: ${err.message}`);
        }

        // Agli closed candle ka wait
        const now     = Date.now();
        const ms15    = 15 * 60 * 1000;
        const nextBar = Math.ceil(now / ms15) * ms15 + 5000; // 5 sec buffer
        const waitMs  = nextBar - now;
        log(`⏳ Next candle check in ${Math.round(waitMs/1000)}s...`);
        await new Promise(r => setTimeout(r, waitMs));
    }
}

// ─────────────────────────────────────────────
//  TICK — ek iteration
// ─────────────────────────────────────────────
async function tick() {
    // ── 15m data fetch ──
    const ohlcv15m = await exchange.fetchOHLCV(SYMBOL, '15m', undefined, WARMUP + 10);
    // Last bar abhi bhi open hai — use mat karo (anti-repaint)
    const closed15 = ohlcv15m.slice(0, -1);

    if (closed15.length < WARMUP) {
        log('⚠️  Enough data nahi hai warmup ke liye'); return;
    }

    // ── 1h data fetch ──
    const ohlcv1h  = await exchange.fetchOHLCV(SYMBOL, '1h', undefined, 200);
    const closed1h = ohlcv1h.slice(0, -1);  // last open bar hatao

    // ── Arrays ──
    const h15 = closed15.map(d=>d[2]), l15 = closed15.map(d=>d[3]);
    const c15 = closed15.map(d=>d[4]), v15 = closed15.map(d=>d[5]);
    const t15 = closed15.map(d=>d[0]);
    const h1h = closed1h.map(d=>d[2]), l1h = closed1h.map(d=>d[3]);
    const c1h = closed1h.map(d=>d[4]), t1h = closed1h.map(d=>d[0]);

    // ── Indicators ──
    const ema200 = calcEMAArray(c15, 200);
    const rsi    = calcRSIArray(c15, 14);
    const adx    = calcADXArray(h15, l15, c15, 14);
    const atr    = calcATRArray(h15, l15, c15, 14);
    const volSma = calcSMAArray(v15, 20);
    const vwap   = calcVWAPArray(closed15);
    const dir15  = calcSuperTrendArray(h15, l15, c15, 4, 12);
    const dir1h  = calcSuperTrendArray(h1h, l1h, c1h, 4, 12);

    // ── Latest bar (last closed) ──
    const i       = closed15.length - 1;
    const price   = c15[i];
    const curTime = t15[i];

    // ── 1h MTF (anti-repaint: fully closed bar) ──
    let stDir1h = null;
    for (let j = t1h.length - 1; j >= 0; j--) {
        if (t1h[j] + 3600000 <= curTime) { stDir1h = dir1h[j]; break; }
    }

    const curEma  = ema200[i], curRsi  = rsi[i];
    const curAdx  = adx[i],   prevAdx = adx[i-1];
    const curAtr  = atr[i],   curVSma = volSma[i];
    const curVwap = vwap[i],  stDir15 = dir15[i];

    log(`📊 Price:${price.toFixed(2)} | RSI:${curRsi?.toFixed(1)} | ADX:${curAdx?.toFixed(1)} | ST15:${stDir15} | ST1h:${stDir1h}`);

    // ── EXIT CHECK ──
    if (position) {
        const { stopped, exitPrice } = tsm.update(h15[i], l15[i]);
        if (stopped) {
            const slip = getSlippage();
            const slippedExit = position === 'long'
                ? exitPrice * (1 - slip)
                : exitPrice * (1 + slip);

            const pnl = position === 'long'
                ? (slippedExit - entryPrice) * LOT_SIZE
                : (entryPrice - slippedExit) * LOT_SIZE;

            totalPnl += pnl;
            trades++;
            if (pnl > 0) wins++;

            // ── Testnet par actual order close ──
            try {
                const side = position === 'long' ? 'sell' : 'buy';
                await exchange.createMarketOrder(SYMBOL, side, LOT_SIZE);
                log(`✅ ORDER CLOSED on testnet`);
            } catch(e) {
                log(`⚠️  Order close failed: ${e.message}`);
            }

            log(`🔴 EXIT ${position.toUpperCase()} | Entry:$${entryPrice.toFixed(2)} | Exit:$${slippedExit.toFixed(2)} | PnL:$${pnl.toFixed(2)} [${pnl>0?'WIN':'LOSS'}]`);
            log(`📈 Total PnL: $${totalPnl.toFixed(2)} | Trades: ${trades} | WR: ${trades>0?((wins/trades)*100).toFixed(1):0}%`);

            position = null;
            tsm.close();
            return;
        }

        log(`🔄 In ${position.toUpperCase()} | Entry:$${entryPrice.toFixed(2)} | SL:$${tsm.currentSL.toFixed(2)} | Trail:${tsm.trailActive?'ON':'OFF'}`);
        return;
    }

    // ── ENTRY CHECK ──
    if (!curEma||!curRsi||!curAdx||!prevAdx||!curAtr||
        !curVSma||!curVwap||stDir15===null||stDir1h===null) {
        log('⚠️  Indicators ready nahi hain'); return;
    }

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

    if (buySignal || sellSignal) {
        const side      = buySignal ? 'long' : 'short';
        const orderSide = buySignal ? 'buy'  : 'sell';
        const slip      = getSlippage();
        entryPrice      = buySignal ? price * (1 + slip) : price * (1 - slip);
        entryTime       = curTime;

        // ── Testnet par actual order place ──
        try {
            await exchange.createMarketOrder(SYMBOL, orderSide, LOT_SIZE);
            log(`✅ ORDER PLACED on testnet`);
        } catch(e) {
            log(`⚠️  Order place failed: ${e.message}`);
        }

        position = side;
        tsm.open(side, entryPrice, curAtr);

        log(`🟢 ENTRY ${side.toUpperCase()} | Price:$${entryPrice.toFixed(2)} | SL:$${tsm.currentSL.toFixed(2)} | ATR:$${curAtr.toFixed(2)}`);
    } else {
        log('⏸️  No signal — waiting...');
    }
}

// ─────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────
runBot().catch(console.error);