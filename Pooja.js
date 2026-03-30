"use strict";
/**
 * Backtest_15m.js
 * ✅ Lot Size     : 0.01 BTC fixed
 * ✅ Leverage     : 20x
 * ✅ Candle Close : Entry at bar close only
 * ✅ Anti-Repaint : 1h MTF fully closed bars
 * ✅ Pine-Exact   : Wilder's RMA indicators
 */
const ccxt = require('ccxt');

// ─── CONFIG ───────────────────────────────────
const LOT_SIZE = 0.01;   // 0.01 BTC base lot
const LEVERAGE = 20;     // 20x leverage
// Effective position = 0.01 × 20 = 0.2 BTC
// At $70,000 → effective position = $14,000

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

class TrailingStopManager {
    constructor() { this.reset(); }
    reset() { this.active=false;this.side=null;this.entryPrice=0;this.currentSL=0;this.trailActive=false;this.peakPrice=0; }
    open(side, entryPrice, atr) {
        this.reset(); this.active=true; this.side=side;
        this.entryPrice=entryPrice; this.peakPrice=entryPrice;
        this.currentSL=side==='long'?entryPrice-atr*1.5:entryPrice+atr*1.5;
    }
    update(high, low) {
        if (!this.active) return { stopped:false };
        const isBuy=this.side==='long';
        if (isBuy&&high>this.peakPrice) this.peakPrice=high;
        if (!isBuy&&low<this.peakPrice) this.peakPrice=low;
        const move=isBuy?this.peakPrice-this.entryPrice:this.entryPrice-this.peakPrice;
        if (move>=2.0) this.trailActive=true;
        if (this.trailActive) {
            const newSL=isBuy?this.peakPrice-0.5:this.peakPrice+0.5;
            if (isBuy&&newSL>this.currentSL) this.currentSL=newSL;
            if (!isBuy&&newSL<this.currentSL) this.currentSL=newSL;
        }
        const stopped=isBuy?low<=this.currentSL:high>=this.currentSL;
        return { stopped, exitPrice:this.currentSL };
    }
    close() { this.reset(); }
}

async function runBacktest() {
    const exchange = new ccxt.binance();
    const symbol   = 'BTC/USDT';
    const since    = exchange.parse8601('2026-01-01T00:00:00Z');

    console.log("Fetching 15m data...");
    let ohlcv15m=[],cur=since;
    while (cur<Date.now()) {
        const data=await exchange.fetchOHLCV(symbol,'15m',cur,1000);
        if (!data.length) break;
        ohlcv15m=ohlcv15m.concat(data);
        cur=data[data.length-1][0]+1;
    }
    console.log("Fetching 1h MTF data...");
    let ohlcv1h=[]; cur=since;
    while (cur<Date.now()) {
        const data=await exchange.fetchOHLCV(symbol,'1h',cur,1000);
        if (!data.length) break;
        ohlcv1h=ohlcv1h.concat(data);
        cur=data[data.length-1][0]+1;
    }
    console.log(`15m bars: ${ohlcv15m.length} | 1h bars: ${ohlcv1h.length}`);

    const h15=ohlcv15m.map(d=>d[2]),l15=ohlcv15m.map(d=>d[3]);
    const c15=ohlcv15m.map(d=>d[4]),v15=ohlcv15m.map(d=>d[5]);
    const t15=ohlcv15m.map(d=>d[0]);
    const h1h=ohlcv1h.map(d=>d[2]),l1h=ohlcv1h.map(d=>d[3]);
    const c1h=ohlcv1h.map(d=>d[4]),t1h=ohlcv1h.map(d=>d[0]);

    console.log("Computing indicators...");
    const ema200=calcEMAArray(c15,200);
    const rsi=calcRSIArray(c15,14);
    const adx=calcADXArray(h15,l15,c15,14);
    const atr=calcATRArray(h15,l15,c15,14);
    const volSma=calcSMAArray(v15,20);
    const vwap=calcVWAPArray(ohlcv15m);
    const dir15=calcSuperTrendArray(h15,l15,c15,4,12);
    const dir1h=calcSuperTrendArray(h1h,l1h,c1h,4,12);

    // Anti-repaint MTF map
    const mtf1hMap=new Map();
    for (let i=0;i<t15.length;i++) {
        const curTime=t15[i];
        let stDir1h=null;
        for (let j=t1h.length-1;j>=0;j--) {
            if (t1h[j]+3600000<=curTime) { stDir1h=dir1h[j]; break; }
        }
        mtf1hMap.set(curTime,stDir1h);
    }

    const stats = {
        long:  { trades:0,wins:0,losses:0,totalPnl:0,maxWin:-Infinity,maxLoss:Infinity },
        short: { trades:0,wins:0,losses:0,totalPnl:0,maxWin:-Infinity,maxLoss:Infinity }
    };
    const longLog=[], shortLog=[];

    // Effective lot = LOT_SIZE * LEVERAGE
    const EFFECTIVE_LOT = LOT_SIZE * LEVERAGE; // 0.01 × 20 = 0.2 BTC

    let balance=5000, position=null, entryPrice=0;
    const tsm=new TrailingStopManager();
    const WARMUP=300;

    for (let i=WARMUP;i<ohlcv15m.length-1;i++) {

        // EXIT
        if (position) {
            const { stopped, exitPrice } = tsm.update(h15[i],l15[i]);
            if (stopped) {
                // PnL with 20x leverage
                const pnl = position==='long'
                    ? (exitPrice - entryPrice) * EFFECTIVE_LOT
                    : (entryPrice - exitPrice) * EFFECTIVE_LOT;

                // Liquidation check — balance cannot go below 0
                const realPnl = Math.max(pnl, -balance);
                balance += realPnl;

                const s=stats[position];
                s.trades++; s.totalPnl+=realPnl;
                if (realPnl>0) { s.wins++;   if(realPnl>s.maxWin)  s.maxWin=realPnl; }
                else           { s.losses++; if(realPnl<s.maxLoss) s.maxLoss=realPnl; }

                const posValue = (entryPrice * EFFECTIVE_LOT).toFixed(2);
                const log = {
                    entry:  entryPrice.toFixed(2),
                    exit:   exitPrice.toFixed(2),
                    pnl:    realPnl.toFixed(2),
                    posVal: posValue,
                    result: realPnl>0?'WIN':'LOSS'
                };
                if (position==='long')  longLog.push(log);
                else                   shortLog.push(log);
                position=null; tsm.close(); continue;
            }
        }

        // ENTRY
        if (!position) {
            const price=c15[i], curTime=t15[i];
            const curEma=ema200[i], curRsi=rsi[i];
            const curAdx=adx[i],   prevAdx=adx[i-1];
            const curAtr=atr[i],   curVSma=volSma[i];
            const curVwap=vwap[i], stDir15=dir15[i];
            const stDir1h=mtf1hMap.get(curTime);

            if (!curEma||!curRsi||!curAdx||!prevAdx||!curAtr||
                !curVSma||!curVwap||stDir15===null||
                stDir1h===null||stDir1h===undefined) continue;

            const buySignal =
                stDir15===-1 && stDir1h===-1 &&
                price>curVwap && price>curEma &&
                curRsi>58 && curRsi<72 &&
                curAdx>32 && curAdx>prevAdx &&
                v15[i]>curVSma*1.2;

            const sellSignal =
                stDir15===1 && stDir1h===1 &&
                price<curVwap && price<curEma &&
                curRsi>28 && curRsi<42 &&
                curAdx>32 && curAdx>prevAdx &&
                v15[i]>curVSma*1.2;

            if (buySignal)       { position='long';  entryPrice=price; tsm.open('long', price,curAtr); }
            else if (sellSignal) { position='short'; entryPrice=price; tsm.open('short',price,curAtr); }
        }
    }

    // HELPERS
    const wr  = s => s.trades>0?((s.wins/s.trades)*100).toFixed(2):'0.00';
    const avg = s => s.trades>0?(s.totalPnl/s.trades).toFixed(2):'0.00';
    const fix = n => (n===Infinity||n===-Infinity)?'$0.00':'$'+n.toFixed(2);
    const totalTrades=stats.long.trades+stats.short.trades;
    const totalWins=stats.long.wins+stats.short.wins;
    const globalWR=totalTrades>0?((totalWins/totalTrades)*100).toFixed(2):'0.00';

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`   BACKTEST — 0.01 BTC | 20x Leverage`);
    console.log(`${'═'.repeat(60)}`);
    console.log(`  Symbol        : ${symbol}`);
    console.log(`  Period        : Jan 2026 → Now`);
    console.log(`  Lot Size      : ${LOT_SIZE} BTC (base)`);
    console.log(`  Leverage      : ${LEVERAGE}x`);
    console.log(`  Effective Lot : ${EFFECTIVE_LOT} BTC (0.01 × 20)`);
    console.log(`  Position Val  : ~$${(70000*EFFECTIVE_LOT).toFixed(0)}-$${(95000*EFFECTIVE_LOT).toFixed(0)} per trade`);
    console.log(`  Initial Cap   : $5,000.00`);
    console.log(`  Final Balance : $${balance.toFixed(2)}`);
    console.log(`  Net Profit    : $${(balance-5000).toFixed(2)}`);
    console.log(`  Return %      : ${((balance-5000)/5000*100).toFixed(2)}%`);
    console.log(`  Total Trades  : ${totalTrades}`);
    console.log(`  Win Rate      : ${globalWR}%`);
    console.log(`${'═'.repeat(60)}`);

    const L=stats.long;
    console.log(`\n  📈 BUY (LONG) — 0.2 BTC effective (20x)`);
    console.log(`  ${'─'.repeat(48)}`);
    console.log(`  Trades        : ${L.trades}`);
    console.log(`  Wins          : ${L.wins}`);
    console.log(`  Losses        : ${L.losses}`);
    console.log(`  Win Rate      : ${wr(L)}%`);
    console.log(`  Total P&L     : $${L.totalPnl.toFixed(2)}`);
    console.log(`  Avg P&L/Trade : $${avg(L)}`);
    console.log(`  Best Trade    : +${fix(L.maxWin)}`);
    console.log(`  Worst Trade   : ${fix(L.maxLoss)}`);

    const S=stats.short;
    console.log(`\n  📉 SELL (SHORT) — 0.2 BTC effective (20x)`);
    console.log(`  ${'─'.repeat(48)}`);
    console.log(`  Trades        : ${S.trades}`);
    console.log(`  Wins          : ${S.wins}`);
    console.log(`  Losses        : ${S.losses}`);
    console.log(`  Win Rate      : ${wr(S)}%`);
    console.log(`  Total P&L     : $${S.totalPnl.toFixed(2)}`);
    console.log(`  Avg P&L/Trade : $${avg(S)}`);
    console.log(`  Best Trade    : +${fix(S.maxWin)}`);
    console.log(`  Worst Trade   : ${fix(S.maxLoss)}`);

    console.log(`\n${'═'.repeat(70)}`);
    console.log(`\n  📈 BUY TRADE LOG (0.2 BTC effective = ~$14,000 position):`);
    console.log(`  ${'─'.repeat(68)}`);
    longLog.forEach((t,i)=>
        console.log(
            `  #${String(i+1).padStart(3,'0')} LONG  `+
            `Pos:$${t.posVal.padStart(8)} `+
            `Entry:$${t.entry.padStart(10)} `+
            `Exit:$${t.exit.padStart(10)} `+
            `PnL:$${t.pnl.padStart(8)} [${t.result}]`
        )
    );

    console.log(`\n  📉 SELL TRADE LOG (0.2 BTC effective = ~$14,000 position):`);
    console.log(`  ${'─'.repeat(68)}`);
    shortLog.forEach((t,i)=>
        console.log(
            `  #${String(i+1).padStart(3,'0')} SHORT `+
            `Pos:$${t.posVal.padStart(8)} `+
            `Entry:$${t.entry.padStart(10)} `+
            `Exit:$${t.exit.padStart(10)} `+
            `PnL:$${t.pnl.padStart(8)} [${t.result}]`
        )
    );
    console.log(`\n${'═'.repeat(70)}`);
}

runBacktest().catch(console.error);