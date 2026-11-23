import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { liveIntent, getWeather, getStockQuote, parseToolCalls } from '../src/tools.js';
import { resolveAsk } from '../src/ask.js';

const INDEX = JSON.parse(readFileSync(new URL('../src/knowledge-index.json', import.meta.url)));
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });

const GEO = { results: [{ name: 'Austin', admin1: 'Texas', country: 'United States', country_code: 'US', latitude: 30.27, longitude: -97.74 }] };
const FORECAST = {
  current: { time: '2026-11-22T13:00', temperature_2m: 21.4, apparent_temperature: 20.9, relative_humidity_2m: 40, precipitation: 0, weather_code: 2, wind_speed_10m: 12 },
  daily: { time: ['2026-11-22', '2026-11-23', '2026-11-24'], weather_code: [2, 61, 0], temperature_2m_max: [23, 18, 20], temperature_2m_min: [11, 9, 8], precipitation_probability_max: [5, 70, 0] },
};
const SEARCH = { quotes: [{ symbol: 'NVDA', quoteType: 'EQUITY' }] };
const CHART = { chart: { result: [{ meta: { symbol: 'NVDA', longName: 'NVIDIA Corporation', currency: 'USD', fullExchangeName: 'NasdaqGS', regularMarketPrice: 125.53, regularMarketChangePercent: -14.009, regularMarketDayHigh: 140, regularMarketDayLow: 124, fiftyTwoWeekHigh: 243.37, fiftyTwoWeekLow: 90, regularMarketTime: 1795208401, marketState: 'CLOSED' }, indicators: { quote: [{ close: [162.85, 150, 146, 145.98, 125.53] }] } }] } };

function stub() {
  const urls = [];
  globalThis.__fetchStub = async (url) => {
    urls.push(url);
    if (url.includes('geocoding-api')) return json(url.includes('Nowhereville') ? {} : GEO);
    if (url.includes('api.open-meteo.com')) return json(FORECAST);
    if (url.includes('/v1/finance/search')) return json(url.includes('zzzz') ? { quotes: [] } : SEARCH);
    if (url.includes('/v8/finance/chart/')) return url.includes('ZZZZ') ? json({ chart: { result: null } }, 404) : json(CHART);
    throw new Error('unexpected ' + url);
  };
  return urls;
}
afterEach(() => { delete globalThis.__fetchStub; });

test('liveIntent spots weather and market questions, not concept questions', () => {
  for (const q of ['what is the weather', 'Will it rain in Austin tomorrow?', 'how cold outside']) assert.equal(liveIntent(q), 'weather', q);
  for (const q of ['how much up is nvidea', "how's nvidia doing today", 'price of $AAPL', 'TSLA stock', 'is AMD up today?', 'how much is apple down this week'])
    assert.equal(liveIntent(q), 'market', q);
  for (const q of ['What is the P/E ratio?', 'How is RSI calculated?', 'How do I tune a PID controller?', 'What is the Sharpe ratio?'])
    assert.equal(liveIntent(q), null, q);
});

test('getWeather: named city and caller location', async () => {
  stub();
  const w = await getWeather('Austin, Texas');
  assert.equal(w.place, 'Austin, Texas, United States');
  assert.equal(w.current.temperature_c, 21.4);
  assert.equal(w.current.condition, 'partly cloudy');
  assert.equal(w.forecast[1].condition, 'light rain');
  const here = await getWeather('', { latitude: '52.5', longitude: '13.4', city: 'Berlin', country: 'DE' });
  assert.equal(here.place, 'Berlin, DE');
  assert.equal(here.location_is_approximate, true);
  assert.match((await getWeather('', null)).error, /Ask which city/);
  assert.match((await getWeather('Nowhereville')).error, /No place/);
});

test('getStockQuote: resolves names, computes change, reports errors', async () => {
  const urls = stub();
  const q = await getStockQuote('nvidia');
  assert.equal(q.symbol, 'NVDA');
  assert.equal(q.price, 125.53);
  assert.equal(q.change_pct, -14.01);
  assert.equal(q.previous_close, 145.98);
  assert.equal(q.five_day_change_pct, -22.92);
  assert.equal(q.market_state, 'CLOSED');
  assert.ok(urls.some((u) => u.includes('search?q=nvidia')));
  const direct = await getStockQuote('NVDA');
  assert.equal(direct.symbol, 'NVDA');
  assert.match((await getStockQuote('ZZZZ')).error, /ZZZZ/);
});

test('parseToolCalls accepts object and string arguments, ignores unknown tools', () => {
  assert.deepEqual(parseToolCalls({ tool_calls: [{ name: 'get_stock_quote', arguments: { symbol: 'NVDA' } }] }), [{ name: 'get_stock_quote', args: { symbol: 'NVDA' } }]);
  assert.deepEqual(parseToolCalls({ tool_calls: [{ function: { name: 'get_weather', arguments: '{"location":"Paris"}' } }] }), [{ name: 'get_weather', args: { location: 'Paris' } }]);
  assert.deepEqual(parseToolCalls({ tool_calls: [{ name: 'rm_rf', arguments: {} }] }), []);
  assert.deepEqual(parseToolCalls({ response: 'hi' }), []);
});

function fakeAI(firstReply) {
  const calls = [];
  return { calls, run: async (model, input) => { calls.push(input); return calls.length === 1 ? firstReply : { response: 'NVIDIA closed at $125.53, down 14.01% on Friday (Yahoo Finance).' }; } };
}
const base = (ai, question, extra = {}) => resolveAsk({
  index: INDEX, question, topK: 3, sourcesOnly: false, log: { error() {} },
  env: { REPO_URL: 'x', AI: ai }, reserveGeneral: async () => ({ ok: true }), ...extra,
});

test('model tool call → live data → worded answer with live_data and disclaimer', async () => {
  stub();
  const ai = fakeAI({ response: null, tool_calls: [{ name: 'get_stock_quote', arguments: { symbol: 'NVDA' } }] });
  const r = await base(ai, 'how much up is nvidea');
  assert.equal(r.mode, 'live');
  assert.equal(r.confidence, 'live-data');
  assert.match(r.answer, /125\.53/);
  assert.equal(r.live_data[0].data.symbol, 'NVDA');
  assert.match(r.disclaimer, /not financial advice/);
  assert.ok(ai.calls[0].tools.some((t) => t.name === 'get_stock_quote'));
  assert.match(ai.calls[1].messages[0].content, /<live_data>[\s\S]*"price": 125\.53/);
  assert.ok(!ai.calls[1].tools || ai.calls[1].tools.every((t) => t.name !== 'get_weather' || true));
});

test('if the model ignores tools on a live question, the Worker fetches anyway', async () => {
  const urls = stub();
  const ai = fakeAI({ response: 'Please check a weather app.' });
  const r = await base(ai, 'What is the weather in Austin today?');
  assert.equal(r.mode, 'live');
  assert.ok(urls.some((u) => u.includes('geocoding-api') && u.includes('Austin')));
  assert.ok(!/check a weather app/i.test(r.answer));
  const r2 = await base(fakeAI({ response: 'no idea' }), 'what is the weather', { where: { latitude: '30.27', longitude: '-97.74', city: 'Austin', country: 'US' } });
  assert.equal(r2.live_data[0].data.place, 'Austin, US');
});

test('tools are not offered for ordinary questions', async () => {
  const ai = fakeAI({ response: 'You asked about forces.', tool_calls: [{ name: 'get_weather', arguments: { location: 'Paris' } }] });
  const r = await base(ai, 'What did I ask you about physics earlier?');
  assert.equal(ai.calls[0].tools, undefined);
  assert.equal(r.mode, 'general'); // a stray tool call from the model is ignored
});

test('live questions skip the docs; tool errors are reported, not hidden', async () => {
  stub();
  const r = await base(fakeAI({ tool_calls: [{ name: 'get_stock_quote', arguments: { symbol: 'ZZZZ' } }] }), 'price of $ZZZZ stock');
  assert.equal(r.mode, 'general'); // tool failed → not labelled live-data
  assert.match(r.live_data[0].error, /ZZZZ/);
  const docs = await base(fakeAI({ response: 'x' }), 'What is the P/E ratio?');
  assert.equal(docs.mode, 'docs');
  const off = await base(fakeAI({ response: 'x' }), 'how much up is nvidia', { sourcesOnly: true });
  assert.equal(off.answered, false);
});
