import { evaluate } from './math.js';
// Live-data tools for general answers: current weather (Open-Meteo, no key) and
// stock quotes (Yahoo Finance chart endpoint, unofficial, no key).
// The model only chooses a tool and its arguments; the Worker fetches the data
// and the model words the answer from that data, citing the source.

const FETCH_TIMEOUT_MS = 8000;
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; OpenVerseAi/1.0)' };

// Questions that need live data skip the docs (which would otherwise answer
// "what's NVDA's price" with the P/E ratio section).
const WEATHER_RE = /\b(weather|forecast|temperature|rain(ing|y)?|snow(ing|y)?|sunny|umbrella|humid(ity)?|windy|degrees outside|hot outside|cold outside)\b/i;
const MARKET_RE = new RegExp(
  [
    '\\b(stock|stocks|share price|shares|ticker|quote|market cap)\\b',
    '\\bprice of\\b',
    '\\btrading at\\b',
    '\\bhow (much|far) (is|did|has|are)?\\s*\\S*\\s*(up|down)\\b',
    '\\bhow much (up|down)\\b',
    '\\b(up|down) (today|this week|this month|this year)\\b',
    "\\bhow('?s| is| are) \\S+( \\S+)? (doing|trading)\\b",
    '\\$[A-Za-z]{1,5}\\b',
  ].join('|'),
  'i'
);

// Questions involving numbers get the exact calculator tool.
const NUMERIC_RE = /\d|\b(calculate|compute|solve|how (much|many|long|far|fast)|percent(age)?|average|mean|median|sum|total|equation|interest|payment|area|volume|perimeter|speed|velocity|acceleration|force|torque|momentum|energy|power|voltage|current|resistance|convert|ratio|probability|derivative|integral)\b/i;
export function numericIntent(question) {
  return NUMERIC_RE.test(question);
}

export const CALC_TOOL = {
  name: 'calculate',
  description: 'Evaluate a math expression EXACTLY. Use it for every computation instead of mental arithmetic. ' +
    'Supports + - * / ^ (power), parentheses, scientific notation (6.02e23), sqrt, cbrt, abs, exp, ln, log (base 10) or log(x, base), ' +
    'sin/cos/tan (radians; use rad(deg) to convert), asin, acos, atan, round(x, digits), floor, ceil, min, max, pi, e. ' +
    'Write percentages as decimals (8.25% → 0.0825). % means remainder.',
  parameters: {
    type: 'object',
    properties: { expression: { type: 'string', description: 'e.g. 18500*(0.069/12)/(1-(1+0.069/12)^-60)' } },
    required: ['expression'],
  },
};

export function liveIntent(question) {
  if (WEATHER_RE.test(question)) return 'weather';
  if (MARKET_RE.test(question)) return 'market';
  return null;
}

export const TOOL_DEFS = [
  {
    name: 'get_weather',
    description: 'Current weather and a 3-day forecast. Use for any question about weather, temperature, rain or wind.',
    parameters: {
      type: 'object',
      properties: {
        location: { type: 'string', description: 'City name, e.g. "Berlin" or "Austin, Texas". Leave empty for the user\'s current location.' },
      },
      required: [],
    },
  },
  {
    name: 'get_stock_quote',
    description: 'Latest price and change for a stock, ETF or index. Use for questions about a company\'s share price or how much it is up or down.',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Ticker symbol such as NVDA, AAPL, SPY, ^GSPC. Correct misspellings of company names to the right ticker.' },
      },
      required: ['symbol'],
    },
  },
];

async function getJson(url, cacheTtl) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: UA, signal: ctrl.signal, cf: { cacheTtl, cacheEverything: true } });
    if (!res.ok) throw new Error(`${new URL(url).hostname} returned HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const WMO = {
  0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'freezing fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 56: 'freezing drizzle', 57: 'heavy freezing drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'heavy freezing rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains', 80: 'light showers', 81: 'showers',
  82: 'violent showers', 85: 'snow showers', 86: 'heavy snow showers', 95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'severe thunderstorm with hail',
};

// `where` = optional { latitude, longitude, city, country } from request.cf (caller's approximate location).
export async function getWeather(location, where = null) {
  let place;
  const name = String(location || '').trim();
  if (name) {
    const g = await getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name.split(',')[0])}&count=5&language=en`, 86400);
    const hits = g.results || [];
    const hint = name.split(',').slice(1).join(' ').trim().toLowerCase();
    const hit = (hint && hits.find((h) => [h.admin1, h.country, h.country_code].some((x) => x && x.toLowerCase().includes(hint)))) || hits[0];
    if (!hit) return { error: `No place called "${name}" was found.` };
    place = { name: [hit.name, hit.admin1, hit.country].filter(Boolean).join(', '), latitude: hit.latitude, longitude: hit.longitude };
  } else if (where && where.latitude && where.longitude) {
    place = { name: [where.city, where.country].filter(Boolean).join(', ') || 'your area', latitude: where.latitude, longitude: where.longitude, approximate: true };
  } else {
    return { error: 'No location given and the user\'s location is unknown. Ask which city.' };
  }
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
    '&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=3';
  const w = await getJson(url, 600);
  const c = w.current || {};
  const d = w.daily || {};
  return {
    source: 'Open-Meteo',
    source_url: `https://open-meteo.com/en/docs#latitude=${place.latitude}&longitude=${place.longitude}`,
    place: place.name,
    location_is_approximate: Boolean(place.approximate),
    local_time: c.time,
    current: {
      condition: WMO[c.weather_code] || `code ${c.weather_code}`,
      temperature_c: c.temperature_2m,
      feels_like_c: c.apparent_temperature,
      humidity_pct: c.relative_humidity_2m,
      precipitation_mm: c.precipitation,
      wind_kmh: c.wind_speed_10m,
    },
    forecast: (d.time || []).map((day, i) => ({
      date: day,
      condition: WMO[d.weather_code[i]] || `code ${d.weather_code[i]}`,
      high_c: d.temperature_2m_max[i],
      low_c: d.temperature_2m_min[i],
      rain_chance_pct: d.precipitation_probability_max[i],
    })),
  };
}

async function resolveSymbol(input) {
  const raw = String(input || '').trim().replace(/^\$/, '');
  if (!raw) return null;
  if (/^[\^A-Za-z][A-Za-z0-9.=^-]{0,9}$/.test(raw) && raw === raw.toUpperCase()) return raw;
  const s = await getJson(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(raw)}&quotesCount=5&newsCount=0`, 86400);
  const q = (s.quotes || []).find((x) => ['EQUITY', 'ETF', 'INDEX', 'MUTUALFUND', 'CRYPTOCURRENCY'].includes(x.quoteType));
  return q ? q.symbol : raw.toUpperCase();
}

export async function getStockQuote(symbolOrName) {
  const symbol = await resolveSymbol(symbolOrName);
  if (!symbol) return { error: 'No stock symbol given.' };
  let chart;
  try {
    chart = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`, 60);
  } catch (err) {
    return { error: `Could not fetch a quote for ${symbol}: ${err.message}` };
  }
  const r = chart && chart.chart && chart.chart.result && chart.chart.result[0];
  if (!r || !r.meta || r.meta.regularMarketPrice == null) return { error: `No quote found for "${symbol}".` };
  const m = r.meta;
  const closes = ((r.indicators && r.indicators.quote && r.indicators.quote[0] && r.indicators.quote[0].close) || []).filter((x) => x != null);
  const price = m.regularMarketPrice;
  const pct = typeof m.regularMarketChangePercent === 'number'
    ? m.regularMarketChangePercent
    : closes.length >= 2 ? ((price - closes[closes.length - 2]) / closes[closes.length - 2]) * 100 : null;
  const prevClose = pct != null ? price / (1 + pct / 100) : null;
  const round = (x, n = 2) => (x == null ? null : Math.round(x * 10 ** n) / 10 ** n);
  const weekStart = closes.length ? closes[0] : null;
  return {
    source: 'Yahoo Finance (unofficial, may be delayed)',
    source_url: `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}`,
    symbol: m.symbol || symbol,
    name: m.longName || m.shortName || symbol,
    currency: m.currency,
    exchange: m.fullExchangeName || m.exchangeName,
    price: round(price),
    change: prevClose != null ? round(price - prevClose) : null,
    change_pct: round(pct),
    previous_close: round(prevClose),
    five_day_change_pct: weekStart ? round(((price - weekStart) / weekStart) * 100) : null,
    day_high: round(m.regularMarketDayHigh),
    day_low: round(m.regularMarketDayLow),
    fifty_two_week_high: round(m.fiftyTwoWeekHigh),
    fifty_two_week_low: round(m.fiftyTwoWeekLow),
    as_of: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : null,
    market_state: m.marketState || null,
  };
}

// Normalises Workers AI tool calls ({name, arguments} with object or JSON-string args).
export function parseToolCalls(out) {
  const calls = (out && (out.tool_calls || out.result?.tool_calls || out.choices?.[0]?.message?.tool_calls || out.result?.choices?.[0]?.message?.tool_calls)) || [];
  return calls
    .map((c) => {
      const fn = c.function || c;
      let args = fn.arguments ?? {};
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
      return { name: fn.name, args: args || {} };
    })
    .filter((c) => c.name === 'get_weather' || c.name === 'get_stock_quote' || c.name === 'calculate')
    .slice(0, 6);
}

export async function runTool(call, where) {
  try {
    if (call.name === 'get_weather') return await getWeather(call.args.location, where);
    if (call.name === 'get_stock_quote') return await getStockQuote(call.args.symbol || call.args.ticker || call.args.company);
    if (call.name === 'calculate') return evaluate(call.args.expression ?? call.args.expr ?? '');
  } catch (err) {
    return { error: `${call.name} failed: ${err.message}` };
  }
  return { error: `unknown tool ${call.name}` };
}
