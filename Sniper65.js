// ─────────────────────────────────────────────
//  sniper65.js — "65 Ultra-Sniper MTF" Backtest
//  Ported from Pine Script v5
//
//  STRATEGY LOGIC (faithful port):
//   • Supertrend(4,12) on 5m current chart
//   • Supertrend direction on 15m (MTF, no lookahead)
//   • VWAP, EMA200, RSI(14), ADX/DMI(14)
//
//  BUY  : close > ST  AND  15m ST bearish  AND  close > VWAP
//          AND  close > EMA200  AND  RSI 58–72
//          AND  ADX > 32 & rising  AND  volume spike
//
//  SELL : close < ST  AND  15m ST bullish  AND  close < VWAP
//          AND  close < EMA200  AND  RSI 28–42
//          AND  ADX > 32 & rising  AND  volume spike
//
//  EXIT : Trailing stop — 1.5×ATR hard SL, 2-tick trail
//
//  NOTE: True MTF requires two Binance API calls (5m + 15m).
//        15m candles are aligned to the same timestamp window.
// ─────────────────────────────────────────────

'use strict';
const axios = require('axios');

// ══════════════════════════════════════════════
//  CONFIG
// ══════════════════════════════════════════════

const CONFIG = {
  symbol        : 'BTCUSDT',
  interval5m    : '5m',
  interval15m   : '15m',
  limit         : 1000,         // 1000 × 5m ≈ 3.5 days (enough for validation)
  initialCapital: 5000,
  riskPct       : 1.0,          // 100% of capital per trade (matches Pine default_qty_value=5000)
  commission    : 0.0004,
  slippage      : 0.0002,       // 2 ticks simulated
  trailATRMult  : 1.5,          // hard SL = 1.5 × ATR
};

const PARAMS = {
  stFactor      : 4,
  stPeriod      : 12,
  rsiPeriod     : 14,
  emaPeriod     : 200,
  adxPeriod     : 14,
  dmiPeriod     : 14,
  volSmaPeriod  : 20,
  volMult       : 1.2,
  adxMin        : 32,
  rsiBuyMin     : 58,  rsiBuyMax  : 72,
  rsiSellMin    : 28,  rsiSellMax : 42,
};

// ══════════════════════════════════════════════
//  INDICATORS
// ══════════════════════════════════════════════

function ema(data, period) {
  const k = 2 / (period + 1), result = [];
  for (let i = 0; i < data.length; i++)
    result.push(i === 0 ? data[0] : data[i] * k + result[i-1] * (1 - k));
  return result;
}

function sma(data, period) {
  return data.map((_, i) => {
    if (i < period - 1) return null;
    let s = 0; for (let j = i-period+1; j <= i; j++) s += data[j];
    return s / period;
  });
}

function rsi(closes, period = 14) {
  const result = Array(period).fill(null);
  let ag = 0, al = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i-1]; ag += d > 0 ? d : 0; al += d < 0 ? -d : 0;
  }
  ag /= period; al /= period;
  result.push(al === 0 ? 100 : 100 - 100/(1+ag/al));
  for (let i = period+1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    ag = (ag*(period-1)+(d>0?d:0))/period;
    al = (al*(period-1)+(d<0?-d:0))/period;
    result.push(al === 0 ? 100 : 100 - 100/(1+ag/al));
  }
  return result;
}

function atrArr(highs, lows, closes, period = 14) {
  const tr = [highs[0]-lows[0]];
  for (let i = 1; i < closes.length; i++)
    tr.push(Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1])));
  const result = Array(period-1).fill(null);
  let s = tr.slice(0,period).reduce((a,b)=>a+b,0); result.push(s/period);
  for (let i = period; i < tr.length; i++)
    result.push((result[result.length-1]*(period-1)+tr[i])/period);
  return result;
}

// ADX + DMI — returns { adx, diPlus, diMinus }
function dmi(highs, lows, closes, period = 14) {
  const n = closes.length;
  const pDM=Array(n).fill(0), mDM=Array(n).fill(0), trA=Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up=highs[i]-highs[i-1], dn=lows[i-1]-lows[i];
    pDM[i]=(up>dn&&up>0)?up:0; mDM[i]=(dn>up&&dn>0)?dn:0;
    trA[i]=Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1]));
  }
  const sTR=Array(n).fill(null),sP=Array(n).fill(null),sM=Array(n).fill(null);
  let tS=0,pS=0,mS=0;
  for (let i=1;i<=period;i++){tS+=trA[i];pS+=pDM[i];mS+=mDM[i];}
  sTR[period]=tS;sP[period]=pS;sM[period]=mS;
  for (let i=period+1;i<n;i++){
    sTR[i]=sTR[i-1]-sTR[i-1]/period+trA[i];
    sP[i]=sP[i-1]-sP[i-1]/period+pDM[i];
    sM[i]=sM[i-1]-sM[i-1]/period+mDM[i];
  }
  const diP=Array(n).fill(null),diM=Array(n).fill(null),dx=Array(n).fill(null);
  for (let i=period;i<n;i++){
    if(!sTR[i])continue;
    diP[i]=100*sP[i]/sTR[i]; diM[i]=100*sM[i]/sTR[i];
    const ds=diP[i]+diM[i]; dx[i]=ds===0?0:100*Math.abs(diP[i]-diM[i])/ds;
  }
  const adxA=Array(n).fill(null); let dSum=0,cnt=0;
  for (let i=period;i<n;i++){
    if(dx[i]===null)continue;
    if(cnt<period){dSum+=dx[i];cnt++;if(cnt===period)adxA[i]=dSum/period;}
    else adxA[i]=(adxA[i-1]*(period-1)+dx[i])/period;
  }
  return { adx: adxA, diPlus: diP, diMinus: diM };
}

// Supertrend — returns { value, direction } arrays
// direction: +1 = bullish (price above), -1 = bearish (price below)
function supertrend(highs, lows, closes, factor = 4, period = 12) {
  const atr  = atrArr(highs, lows, closes, period);
  const n    = closes.length;
  const val  = Array(n).fill(null);
  const dir  = Array(n).fill(null);
  let upperBand = 0, lowerBand = 0;
  let prevUpper = 0, prevLower = 0;
  let prevDir   = 1;

  for (let i = period; i < n; i++) {
    if (!atr[i]) continue;
    const hl2  = (highs[i] + lows[i]) / 2;
    const bu   = hl2 + factor * atr[i];   // basic upper
    const bl   = hl2 - factor * atr[i];   // basic lower

    // Final upper band
    upperBand = (bu < prevUpper || closes[i-1] > prevUpper) ? bu : prevUpper;
    // Final lower band
    lowerBand = (bl > prevLower || closes[i-1] < prevLower) ? bl : prevLower;

    // Direction
    if (prevDir === -1 && closes[i] > prevUpper) dir[i] = 1;
    else if (prevDir === 1 && closes[i] < prevLower) dir[i] = -1;
    else dir[i] = prevDir;

    val[i]    = dir[i] === 1 ? lowerBand : upperBand;
    prevUpper = upperBand;
    prevLower = lowerBand;
    prevDir   = dir[i];
  }
  return { value: val, direction: dir };
}

// VWAP — daily rolling VWAP (resets each "day" approximated by 288 5m candles)
function vwap(highs, lows, closes, volumes, resetEvery = 288) {
  const result = [];
  let cumPV = 0, cumVol = 0;
  for (let i = 0; i < closes.length; i++) {
    if (i % resetEvery === 0) { cumPV = 0; cumVol = 0; }
    const tp = (highs[i] + lows[i] + closes[i]) / 3;
    cumPV  += tp * volumes[i];
    cumVol += volumes[i];
    result.push(cumVol > 0 ? cumPV / cumVol : closes[i]);
  }
  return result;
}

// ══════════════════════════════════════════════
//  MTF ALIGNMENT
//  Map each 5m candle index → corresponding 15m
//  supertrend direction (no lookahead: use [1])
// ══════════════════════════════════════════════

function align15mTo5m(candles5m, candles15m) {
  // Build a timestamp→direction map for 15m (using previous bar = [1])
  const st15 = (() => {
    const H = candles15m.map(c => c.high);
    const L = candles15m.map(c => c.low);
    const C = candles15m.map(c => c.close);
    return supertrend(H, L, C, PARAMS.stFactor, PARAMS.stPeriod);
  })();

  // For each 5m candle, find the 15m bar that was CLOSED before it (no-lookahead)
  const dirMap = [];
  let j = 0;
  for (let i = 0; i < candles5m.length; i++) {
    const ts5 = candles5m[i].ts;
    // Advance 15m pointer while the next 15m bar's open is before/at our 5m ts
    while (j + 1 < candles15m.length && candles15m[j + 1].ts <= ts5) j++;
    // Use [j-1] for no-lookahead (the bar before the last completed 15m)
    const safeIdx = Math.max(0, j - 1);
    dirMap.push(st15.direction[safeIdx]);
  }
  return dirMap;
}

// ══════════════════════════════════════════════
//  DATA FETCH
// ══════════════════════════════════════════════

async function fetchCandles(interval, limit) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${CONFIG.symbol}&interval=${interval}&limit=${limit}`;
  const { data } = await axios.get(url, { timeout: 10_000 });
  return data.map(k => ({
    ts    : k[0],
    date  : new Date(k[0]).toLocaleString('en-US'),
    open  : parseFloat(k[1]), high  : parseFloat(k[2]),
    low   : parseFloat(k[3]), close : parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

// ══════════════════════════════════════════════
//  BACKTEST ENGINE
// ══════════════════════════════════════════════

function runBacktest(candles5m, dir15m) {
  const closes  = candles5m.map(c => c.close);
  const highs   = candles5m.map(c => c.high);
  const lows    = candles5m.map(c => c.low);
  const volumes = candles5m.map(c => c.volume);

  const st      = supertrend(highs, lows, closes, PARAMS.stFactor, PARAMS.stPeriod);
  const rsiA    = rsi(closes, PARAMS.rsiPeriod);
  const atr5    = atrArr(highs, lows, closes, 14);
  const ema200  = ema(closes, PARAMS.emaPeriod);
  const vwapA   = vwap(highs, lows, closes, volumes);
  const volSmaA = sma(volumes, PARAMS.volSmaPeriod);
  const { adx: adxA } = dmi(highs, lows, closes, PARAMS.dmiPeriod);

  let capital   = CONFIG.initialCapital;
  let peak      = capital;
  let maxDD     = 0;
  const trades  = [];
  let position  = null;   // { type, entry, sl, trailHigh/Low, size }

  const warmup = Math.max(PARAMS.emaPeriod, PARAMS.stPeriod + 10, PARAMS.adxPeriod * 2) + 5;

  for (let i = warmup; i < candles5m.length; i++) {
    const close   = closes[i];
    const high    = highs[i];
    const low     = lows[i];
    const atrNow  = atr5[i];
    const rsiNow  = rsiA[i];
    const adxNow  = adxA[i];
    const adxPrev = adxA[i-1];
    const vwapNow = vwapA[i];
    const ema200N = ema200[i];
    const stVal   = st.value[i];
    const stDir   = st.direction[i];
    const st15Dir = dir15m[i];
    const vol     = volumes[i];
    const volAvg  = volSmaA[i];
    const date    = candles5m[i].date;

    if (!atrNow || !rsiNow || !adxNow || !adxPrev || !stVal || !stDir || !volAvg) continue;

    const adxRising = adxNow > PARAMS.adxMin && adxNow > adxPrev;
    const highVol   = vol > volAvg * PARAMS.volMult;

    // ── MANAGE OPEN POSITION ──────────────────
    if (position) {
      const { type, sl } = position;

      // Hard stop loss check
      let stopped = false;
      if (type === 'LONG'  && low  <= sl) { stopped = true; }
      if (type === 'SHORT' && high >= sl) { stopped = true; }

      if (stopped) {
        const exitPrice  = type === 'LONG' ? sl : sl;
        const comm       = exitPrice * position.size * CONFIG.commission;
        const netPnL     = (type === 'LONG'
          ? (exitPrice - position.entry) * position.size
          : (position.entry - exitPrice) * position.size) - comm;
        capital += netPnL;
        if (capital > peak) peak = capital;
        const dd = (peak - capital) / peak;
        if (dd > maxDD) maxDD = dd;
        trades.push({
          '#': trades.length+1, Date: position.openDate, ExitDate: date,
          Type: type, Entry: position.entry.toFixed(2), Exit: exitPrice.toFixed(2),
          'PnL($)': netPnL.toFixed(2), 'Cap($)': capital.toFixed(2),
          ADX: adxNow.toFixed(1), RSI: rsiNow.toFixed(1),
          Reason: 'STOP LOSS', Status: netPnL > 0 ? 'PROFIT ✅' : 'LOSS ❌',
        });
        position = null;
        continue;
      }

      // Trailing stop update (Pine: trail_points=2 ticks, trail_offset=0.5 ticks)
      // Approximate: trail activates when price moves > 2 pts from entry, trails by offset
      const trailDist = atrNow * 0.5;  // trail offset ≈ 0.5× current ATR
      if (type === 'LONG') {
        const newTrailSL = high - trailDist;
        if (newTrailSL > position.sl) position.sl = newTrailSL;
        // Check trail hit
        if (low <= position.sl) {
          const exitPrice = position.sl;
          const comm = exitPrice * position.size * CONFIG.commission;
          const netPnL = (exitPrice - position.entry) * position.size - comm;
          capital += netPnL;
          if (capital > peak) peak = capital;
          const dd = (peak - capital) / peak;
          if (dd > maxDD) maxDD = dd;
          trades.push({
            '#': trades.length+1, Date: position.openDate, ExitDate: date,
            Type: type, Entry: position.entry.toFixed(2), Exit: exitPrice.toFixed(2),
            'PnL($)': netPnL.toFixed(2), 'Cap($)': capital.toFixed(2),
            ADX: adxNow.toFixed(1), RSI: rsiNow.toFixed(1),
            Reason: 'TRAIL STOP', Status: netPnL > 0 ? 'PROFIT ✅' : 'LOSS ❌',
          });
          position = null;
          continue;
        }
      } else {
        const newTrailSL = low + trailDist;
        if (newTrailSL < position.sl) position.sl = newTrailSL;
        if (high >= position.sl) {
          const exitPrice = position.sl;
          const comm = exitPrice * position.size * CONFIG.commission;
          const netPnL = (position.entry - exitPrice) * position.size - comm;
          capital += netPnL;
          if (capital > peak) peak = capital;
          const dd = (peak - capital) / peak;
          if (dd > maxDD) maxDD = dd;
          trades.push({
            '#': trades.length+1, Date: position.openDate, ExitDate: date,
            Type: type, Entry: position.entry.toFixed(2), Exit: exitPrice.toFixed(2),
            'PnL($)': netPnL.toFixed(2), 'Cap($)': capital.toFixed(2),
            ADX: adxNow.toFixed(1), RSI: rsiNow.toFixed(1),
            Reason: 'TRAIL STOP', Status: netPnL > 0 ? 'PROFIT ✅' : 'LOSS ❌',
          });
          position = null;
          continue;
        }
      }
    }

    // ── ENTRY SIGNALS ─────────────────────────
    if (!position) {
      const entryClose = close * (1 + CONFIG.slippage);  // simulate slippage

      const buySig = stDir > 0
        && st15Dir !== null && st15Dir < 0    // 15m ST bearish
        && close > vwapNow
        && close > ema200N
        && rsiNow > PARAMS.rsiBuyMin && rsiNow < PARAMS.rsiBuyMax
        && adxRising && highVol;

      const sellSig = stDir < 0
        && st15Dir !== null && st15Dir > 0    // 15m ST bullish
        && close < vwapNow
        && close < ema200N
        && rsiNow > PARAMS.rsiSellMin && rsiNow < PARAMS.rsiSellMax
        && adxRising && highVol;

      if (buySig) {
        const sl   = entryClose - atrNow * CONFIG.trailATRMult;
        const size = (capital * CONFIG.riskPct) / entryClose;
        position   = { type: 'LONG', entry: entryClose, sl, size, openDate: date };
      } else if (sellSig) {
        const sl   = entryClose + atrNow * CONFIG.trailATRMult;
        const size = (capital * CONFIG.riskPct) / entryClose;
        position   = { type: 'SHORT', entry: entryClose, sl, size, openDate: date };
      }
    }
  }

  // Close any open position at end of data
  if (position) {
    const last      = candles5m[candles5m.length - 1];
    const exitPrice = last.close;
    const comm      = exitPrice * position.size * CONFIG.commission;
    const netPnL    = (position.type === 'LONG'
      ? (exitPrice - position.entry) * position.size
      : (position.entry - exitPrice) * position.size) - comm;
    capital += netPnL;
    trades.push({
      '#': trades.length+1, Date: position.openDate, ExitDate: last.date,
      Type: position.type, Entry: position.entry.toFixed(2), Exit: exitPrice.toFixed(2),
      'PnL($)': netPnL.toFixed(2), 'Cap($)': capital.toFixed(2),
      ADX: '—', RSI: '—', Reason: 'END OF DATA',
      Status: netPnL > 0 ? 'PROFIT ✅' : 'LOSS ❌',
    });
  }

  return { trades, finalCapital: capital, maxDrawdown: maxDD };
}

// ══════════════════════════════════════════════
//  REPORT
// ══════════════════════════════════════════════

function printReport(trades, finalCapital, maxDD, candles5m) {
  const wins   = trades.filter(t => t.Status.includes('✅'));
  const losses = trades.filter(t => t.Status.includes('❌'));
  const totalPnL  = trades.reduce((s,t)=>s+parseFloat(t['PnL($)']),0);
  const grossWin  = wins.reduce((s,t)=>s+parseFloat(t['PnL($)']),0);
  const grossLoss = losses.reduce((s,t)=>s+parseFloat(t['PnL($)']),0);
  const winRate   = trades.length ? ((wins.length/trades.length)*100).toFixed(2) : '0';
  const pf        = Math.abs(grossLoss)>0 ? (grossWin/Math.abs(grossLoss)).toFixed(2) : '∞';
  const retPct    = (((finalCapital/CONFIG.initialCapital)-1)*100).toFixed(2);
  const avgWin    = wins.length   ? (grossWin /wins.length).toFixed(2)   : '0.00';
  const avgLoss   = losses.length ? (grossLoss/losses.length).toFixed(2) : '0.00';

  const trailWins  = trades.filter(t=>t.Reason==='TRAIL STOP'&&t.Status.includes('✅')).length;
  const trailLoss  = trades.filter(t=>t.Reason==='TRAIL STOP'&&t.Status.includes('❌')).length;

  let maxC=0,c=0;
  for (const t of trades){c=t.Status.includes('❌')?c+1:0;maxC=Math.max(maxC,c);}

  console.log('\n--- COMPLETE TRADE LIST ---');
  console.table(trades);

  const s = '─'.repeat(54);
  console.log(`\n┌${s}┐`);
  console.log(`│         🎯  65 Ultra-Sniper MTF — Summary            │`);
  console.log(`├${s}┤`);
  console.log(`│  Symbol   : ${CONFIG.symbol}  |  Chart: ${CONFIG.interval5m}  |  MTF: ${CONFIG.interval15m}          │`);
  console.log(`│  Period   : ${candles5m[0].date} → ${candles5m[candles5m.length-1].date}  │`);
  console.log(`│  Entry    : ST(4,12) + VWAP + EMA200 + RSI + ADX>32   │`);
  console.log(`│  Exit     : Trailing Stop (1.5×ATR hard + 0.5×ATR trail)│`);
  console.log(`├${s}┤`);
  console.log(`│  Initial Capital    : $${String(CONFIG.initialCapital.toFixed(2)).padEnd(29)}│`);
  console.log(`│  Final Balance      : $${String(finalCapital.toFixed(2)).padEnd(29)}│`);
  console.log(`│  Net P&L            : $${String(totalPnL.toFixed(2)).padEnd(29)}│`);
  console.log(`│  Return             :  ${String(retPct+'%').padEnd(30)}│`);
  console.log(`│  Max Drawdown       :  ${String((maxDD*100).toFixed(2)+'%').padEnd(30)}│`);
  console.log(`├${s}┤`);
  console.log(`│  Total Trades       : ${String(trades.length).padEnd(31)}│`);
  console.log(`│  Wins / Losses      : ${wins.length} / ${losses.length}                                   │`);
  console.log(`│  Win Rate           : ${String(winRate+'%').padEnd(31)}│`);
  console.log(`│  Avg Win            : $${String(avgWin).padEnd(29)}│`);
  console.log(`│  Avg Loss           : $${String(avgLoss).padEnd(29)}│`);
  console.log(`│  Profit Factor      : ${String(pf).padEnd(31)}│`);
  console.log(`│  Trail Stop Exits   : ${trailWins} wins / ${trailLoss} losses                    │`);
  console.log(`│  Max Consec. Losses : ${String(maxC).padEnd(31)}│`);
  console.log(`└${s}┘\n`);
}

// ══════════════════════════════════════════════
//  MAIN
// ══════════════════════════════════════════════

async function main() {
  console.log('\n🎯  65 Ultra-Sniper MTF Backtest');
  console.log('━'.repeat(48));
  console.log('  Source : Pine Script v5 port');
  console.log('  Chart  : 5m  |  MTF: 15m (no lookahead)');
  console.log('  Signal : SuperTrend + VWAP + EMA200 + RSI + ADX');
  console.log('  Exit   : Trailing stop (1.5×ATR hard, 0.5×ATR trail)');
  console.log('━'.repeat(48));

  let candles5m, candles15m;
  console.log(`📡  Fetching ${CONFIG.limit} × 5m candles...`);

  try {
    candles5m  = await fetchCandles(CONFIG.interval5m,  CONFIG.limit);
    // Fetch 15m: need enough bars to cover the same period
    const limit15m = Math.ceil(CONFIG.limit / 3) + 50;
    console.log(`📡  Fetching ${limit15m} × 15m candles (MTF)...`);
    candles15m = await fetchCandles(CONFIG.interval15m, limit15m);
    console.log(`✅  5m: ${candles5m.length} candles  |  15m: ${candles15m.length} candles`);
    console.log(`📅  Period: ${candles5m[0].date} → ${candles5m[candles5m.length-1].date}\n`);
  } catch (e) {
    console.error('❌  Binance fetch failed:', e.message);
    process.exit(1);
  }

  // Align 15m ST direction to 5m timeline (no lookahead)
  const dir15m = align15mTo5m(candles5m, candles15m);

  const { trades, finalCapital, maxDrawdown } = runBacktest(candles5m, dir15m);

  if (trades.length === 0) {
    console.log('⚠️  No signals fired in this period.');
    console.log('    Possible reasons:');
    console.log('    • ADX rarely exceeded 32 (low momentum period)');
    console.log('    • 5m ST and 15m ST directions rarely conflicted');
    console.log('    • RSI conditions for entries not met simultaneously');
    console.log('\n    Try increasing limit or testing on a more volatile period.');
    return;
  }

  printReport(trades, finalCapital, maxDrawdown, candles5m);
}

main();