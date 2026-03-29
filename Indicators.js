// ─────────────────────────────────────────────
//  indicators.js — Pure Technical Indicators
// ─────────────────────────────────────────────

/**
 * Exponential Moving Average
 * Uses standard EMA formula: EMA = price * k + prevEMA * (1 - k)
 */
function ema(data, period) {
  const k = 2 / (period + 1);
  const result = [];
  for (let i = 0; i < data.length; i++) {
    if (i === 0) {
      result.push(data[0]);
    } else {
      result.push(data[i] * k + result[i - 1] * (1 - k));
    }
  }
  return result;
}

/**
 * Relative Strength Index (Wilder's Smoothing Method)
 * Returns array with null padding for the first `period` values
 */
function rsi(closes, period = 14) {
  const result = Array(period).fill(null);

  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain += diff > 0 ? diff : 0;
    avgLoss += diff < 0 ? -diff : 0;
  }
  avgGain /= period;
  avgLoss /= period;

  result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }

  return result;
}

/**
 * Average True Range (Wilder's Smoothing)
 * True Range = max(H-L, |H-prevC|, |L-prevC|)
 */
function atr(highs, lows, closes, period = 14) {
  const tr = [highs[0] - lows[0]];
  for (let i = 1; i < closes.length; i++) {
    const hl  = highs[i] - lows[i];
    const hpc = Math.abs(highs[i] - closes[i - 1]);
    const lpc = Math.abs(lows[i] - closes[i - 1]);
    tr.push(Math.max(hl, hpc, lpc));
  }

  const result = Array(period - 1).fill(null);
  let sum = tr.slice(0, period).reduce((a, b) => a + b, 0);
  result.push(sum / period);

  for (let i = period; i < tr.length; i++) {
    result.push((result[result.length - 1] * (period - 1) + tr[i]) / period);
  }
  return result;
}

/**
 * Simple Moving Average
 */
function sma(data, period) {
  return data.map((_, i) => {
    if (i < period - 1) return null;
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += data[j];
    return sum / period;
  });
}

/**
 * Bollinger Bands
 * Returns { upper, middle, lower }
 */
function bollingerBands(data, period = 20, multiplier = 2) {
  const middle = sma(data, period);
  const upper  = [];
  const lower  = [];

  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      upper.push(null);
      lower.push(null);
      continue;
    }
    const slice = data.slice(i - period + 1, i + 1);
    const mean  = middle[i];
    const std   = Math.sqrt(slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period);
    upper.push(mean + multiplier * std);
    lower.push(mean - multiplier * std);
  }
  return { upper, middle, lower };
}

module.exports = { ema, rsi, atr, sma, bollingerBands };