import fetch from 'node-fetch';
import { EMA, RSI } from 'technicalindicators';

const BINANCE_BASE_URL = process.env.BINANCE_MARKET_BASE_URL || 'https://api.binance.com';
const COINGECKO_BASE_URL = process.env.COINGECKO_BASE_URL || 'https://api.coingecko.com/api/v3';
const MARKET_TIMEOUT_MS = Number(process.env.MARKET_TIMEOUT_MS || 6000);

function withTimeout(ms) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeoutId),
  };
}

function pctChange(first, last) {
  if (!first || !last) return null;
  return Number((((last - first) / first) * 100).toFixed(2));
}

function classifyTrend({ close, ema20, ema50, change24h, rsi }) {
  if (!close || !ema20 || !ema50) return 'unknown';
  const bullish = close > ema20 && ema20 > ema50 && change24h > 0;
  const bearish = close < ema20 && ema20 < ema50 && change24h < 0;

  if (bullish && rsi >= 50) return 'bullish';
  if (bearish && rsi <= 50) return 'bearish';
  return 'mixed';
}

async function fetchKlines(interval, limit) {
  const request = withTimeout(MARKET_TIMEOUT_MS);
  try {
    const url = `${BINANCE_BASE_URL}/api/v3/klines?symbol=BTCUSDT&interval=${interval}&limit=${limit}`;
    const response = await fetch(url, { signal: request.signal });
    if (!response.ok) throw new Error(`Binance market data failed with status ${response.status}`);
    return response.json();
  } finally {
    request.clear();
  }
}

async function fetchJson(url) {
  const request = withTimeout(MARKET_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: request.signal,
      headers: {
        accept: 'application/json',
        'user-agent': 'ChartMindAI/2.0',
      },
    });
    if (!response.ok) throw new Error(`Market data failed with status ${response.status}`);
    return response.json();
  } finally {
    request.clear();
  }
}

function summarizeKlines(klines) {
  const closes = klines.map((candle) => Number(candle[4])).filter(Number.isFinite);
  const volumes = klines.map((candle) => Number(candle[5])).filter(Number.isFinite);
  const lastClose = closes.at(-1);
  const ema20 = EMA.calculate({ values: closes, period: 20 }).at(-1);
  const ema50 = EMA.calculate({ values: closes, period: 50 }).at(-1);
  const rsi = RSI.calculate({ values: closes, period: 14 }).at(-1);
  const recentVolume = volumes.slice(-6).reduce((sum, value) => sum + value, 0) / Math.max(volumes.slice(-6).length, 1);
  const baselineVolume = volumes.slice(-30, -6).reduce((sum, value) => sum + value, 0) / Math.max(volumes.slice(-30, -6).length, 1);

  return {
    price: Number(lastClose?.toFixed(2)),
    ema20: Number(ema20?.toFixed(2)),
    ema50: Number(ema50?.toFixed(2)),
    rsi: Number(rsi?.toFixed(2)),
    change: pctChange(closes[0], lastClose),
    volumeState: baselineVolume && recentVolume > baselineVolume * 1.15
      ? 'expanding'
      : baselineVolume && recentVolume < baselineVolume * 0.85
        ? 'contracting'
        : 'normal',
  };
}

function summarizePrices(prices) {
  const closes = prices.map((point) => Number(point[1])).filter(Number.isFinite);
  const lastClose = closes.at(-1);
  const ema20 = EMA.calculate({ values: closes, period: 20 }).at(-1);
  const ema50 = EMA.calculate({ values: closes, period: 50 }).at(-1);
  const rsi = RSI.calculate({ values: closes, period: 14 }).at(-1);

  return {
    price: Number(lastClose?.toFixed(2)),
    ema20: Number(ema20?.toFixed(2)),
    ema50: Number(ema50?.toFixed(2)),
    rsi: Number(rsi?.toFixed(2)),
    change: pctChange(closes[0], lastClose),
    volumeState: 'not provided',
  };
}

async function getCoinGeckoContext() {
  const [chart, market] = await Promise.all([
    fetchJson(`${COINGECKO_BASE_URL}/coins/bitcoin/market_chart?vs_currency=usd&days=90`),
    fetchJson(`${COINGECKO_BASE_URL}/coins/markets?vs_currency=usd&ids=bitcoin&price_change_percentage=24h,7d`),
  ]);
  const higherTimeframe = summarizePrices(chart.prices || []);
  const intraday = {
    ...higherTimeframe,
    change: Number(market?.[0]?.price_change_percentage_24h?.toFixed?.(2) ?? higherTimeframe.change),
    price: Number(market?.[0]?.current_price?.toFixed?.(2) ?? higherTimeframe.price),
    volumeState: market?.[0]?.total_volume ? `24h volume ${Number(market[0].total_volume).toLocaleString('en-US')}` : 'not provided',
  };
  const trend = classifyTrend({
    close: intraday.price,
    ema20: higherTimeframe.ema20,
    ema50: higherTimeframe.ema50,
    change24h: intraday.change,
    rsi: higherTimeframe.rsi,
  });

  return {
    source: 'CoinGecko bitcoin market data',
    fetchedAt: new Date().toISOString(),
    trend,
    intraday,
    higherTimeframe,
    note: 'Use BTC as broad crypto market regime context. Do not override the uploaded chart setup with BTC data.',
  };
}

export async function getBitcoinMarketContext() {
  try {
    const [fourHour, daily] = await Promise.all([
      fetchKlines('4h', 80),
      fetchKlines('1d', 90),
    ]);
    const intraday = summarizeKlines(fourHour);
    const higherTimeframe = summarizeKlines(daily);
    const trend = classifyTrend({
      close: intraday.price,
      ema20: intraday.ema20,
      ema50: intraday.ema50,
      change24h: higherTimeframe.change,
      rsi: intraday.rsi,
    });

    return {
      source: 'Binance BTCUSDT klines',
      fetchedAt: new Date().toISOString(),
      trend,
      intraday,
      higherTimeframe,
      note: 'Use BTC as broad crypto market regime context. Do not override the uploaded chart setup with BTC data.',
    };
  } catch (error) {
    console.error('[marketData]', error.message);
    try {
      return await getCoinGeckoContext();
    } catch (fallbackError) {
      console.error('[marketData:fallback]', fallbackError.message);
      return {
        source: 'unavailable',
        fetchedAt: new Date().toISOString(),
        trend: 'unknown',
        error: 'BTC market context unavailable during this analysis.',
      };
    }
  }
}
