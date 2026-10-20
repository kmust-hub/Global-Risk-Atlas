import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const HOST = '127.0.0.1';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';

const cache = {
  history: null,
  historyAt: 0,
  quote: null,
  quoteAt: 0,
  bootstrap: null,
  bootstrapAt: 0,
  error: null
};

let fallback = null;

function chinaParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short', hour12: false
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
    weekday: parts.weekday,
    minutes: Number(parts.hour) * 60 + Number(parts.minute)
  };
}

function marketState(now = chinaParts()) {
  const weekend = now.weekday === 'Sat' || now.weekday === 'Sun';
  if (weekend) return { isOpen: false, label: '周末休市' };
  if (now.minutes < 9 * 60 + 15) return { isOpen: false, label: '盘前' };
  if (now.minutes <= 11 * 60 + 35) return { isOpen: true, label: '交易中' };
  if (now.minutes < 12 * 60 + 55) return { isOpen: false, label: '午间休市' };
  if (now.minutes <= 15 * 60 + 5) return { isOpen: true, label: '交易中' };
  return { isOpen: false, label: '已收盘' };
}

async function fetchText(url, options = {}, attempts = 2) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeout || 15000);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'user-agent': UA,
          'accept': 'text/html,application/json,text/plain,*/*',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
          ...(options.headers || {})
        }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastError = err;
      if (i + 1 < attempts) await new Promise(r => setTimeout(r, 350));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

function parseEastmoneyQuote(html) {
  const match = html.match(/var quotedata\s*=\s*(\{.*?\});/s);
  if (!match) throw new Error('quotedata missing');
  const raw = JSON.parse(match[1]);
  const digits = Number(raw.decimal59 ?? 2);
  return {
    code: raw.code,
    name: raw.name,
    price: Number(raw.price) / 10 ** digits,
    change: Number(raw.zde) / 10 ** digits,
    changePct: Number(raw.zdf) / 100,
    tradeStatus: raw.trade_status
  };
}

async function fetchEastmoneyQuote(secid) {
  const html = await fetchText(`https://wap.eastmoney.com/quote/stock/${secid}.html?_=${Date.now()}`, {
    headers: { referer: 'https://quote.eastmoney.com/' }
  });
  return parseEastmoneyQuote(html);
}

function parseTencentDaily(payload, symbol) {
  const obj = JSON.parse(payload);
  const node = obj?.data?.[symbol];
  const rows = node?.qfqday || node?.day;
  if (!Array.isArray(rows) || rows.length < 100) throw new Error(`Tencent daily missing: ${symbol}`);
  return Object.fromEntries(rows.map(row => [row[0], Number(row[2])]));
}

async function fetchTencentDaily(symbol) {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},day,,,2000,qfq&_=${Date.now()}`;
  return parseTencentDaily(await fetchText(url, { headers: { referer: 'https://gu.qq.com/' } }), symbol);
}

async function fetchTencentMonthly(symbol) {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},month,,,500,qfq&_=${Date.now()}`;
  const payload = await fetchText(url, { headers: { referer: 'https://gu.qq.com/' } });
  const obj = JSON.parse(payload);
  const node = obj?.data?.[symbol];
  const rows = node?.qfqmonth || node?.month;
  if (!Array.isArray(rows) || rows.length < 100) throw new Error(`Tencent monthly missing: ${symbol}`);
  return rows.map(row => ({ date: row[0], close: Number(row[2]) }));
}

function alignSeries(zzhlMap, cybMap, monthlyRows) {
  const dates = Object.keys(zzhlMap).filter(d => cybMap[d] != null).sort();
  const monthlySorted = monthlyRows
    .filter(row => Number.isFinite(row.close))
    .sort((a, b) => a.date.localeCompare(b.date));
  return dates.map(date => {
    const month = date.slice(0, 7);
    const prior = monthlySorted.filter(row => row.date.slice(0, 7) < month);
    const zzhl = Number(zzhlMap[date]);
    const closes90 = prior.slice(-89).map(row => row.close).concat(zzhl);
    const closes40 = prior.slice(-39).map(row => row.close).concat(zzhl);
    return {
      date,
      zzhl,
      cyb: Number(cybMap[date]),
      ma90: closes90.length >= 90 ? mean(closes90) : null,
      ma40: closes40.length >= 40 ? mean(closes40) : null,
      r: Number(cybMap[date]) / zzhl
    };
  });
}

function lastCompleteMonthClose(series) {
  const out = [];
  for (const row of series) {
    const month = row.date.slice(0, 7);
    if (out.length && out[out.length - 1].month === month) {
      out[out.length - 1] = { ...row, month };
    } else {
      out.push({ ...row, month });
    }
  }
  return out;
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function enrich(series, liveQuote = null) {
  const working = series.map(row => ({ ...row }));
  if (liveQuote?.isLive) {
    const point = {
      date: liveQuote.date,
      zzhl: liveQuote.zzhl.price,
      cyb: liveQuote.cyb.price
    };
    point.r = point.cyb / point.zzhl;
    const last = working.at(-1);
    if (last?.date === point.date) working[working.length - 1] = point;
    else if (point.date > last?.date) working.push(point);
  }

  const monthly = lastCompleteMonthClose(working);
  const current = working.at(-1);
  const ma90 = monthly.length >= 90 ? mean(monthly.slice(-90).map(row => row.zzhl)) : null;
  const ma40 = monthly.length >= 40 ? mean(monthly.slice(-40).map(row => row.zzhl)) : null;
  current.ma90 = ma90;
  current.ma40 = ma40;
  const previous = working.at(-2);
  const strategy = {
    R: current.r,
    ma90,
    ma40,
    dist90Pct: ma90 ? (current.zzhl / ma90 - 1) * 100 : null,
    dist40Pct: ma40 ? (current.zzhl / ma40 - 1) * 100 : null,
    zone: current.r <= 0.33 ? '创业板买入区' : current.r >= 0.65 ? '创业板清仓区' : current.r >= 0.52 ? '创业板减仓区' : '规则未触发'
  };
  const changePct = (now, prev) => prev ? (now / prev - 1) * 100 : null;
  const quote = liveQuote ? {
    zzhl: {
      ...liveQuote.zzhl,
      date: liveQuote.date,
      changePct: liveQuote.isLive ? liveQuote.zzhl.changePct : changePct(current.zzhl, previous?.zzhl)
    },
    cyb: {
      ...liveQuote.cyb,
      date: liveQuote.date,
      changePct: liveQuote.isLive ? liveQuote.cyb.changePct : changePct(current.cyb, previous?.cyb)
    }
  } : {
    zzhl: { code: '000922', name: '中证红利', price: current.zzhl, date: current.date, changePct: changePct(current.zzhl, previous?.zzhl) },
    cyb: { code: '399006', name: '创业板指', price: current.cyb, date: current.date, changePct: changePct(current.cyb, previous?.cyb) }
  };
  return { series: working, quote, strategy };
}

const FULL_HISTORY_FILE = path.join(ROOT, '..', 'exports', 'combined_R_MA90_MA40_daily.csv');

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function readFullHistory() {
  const text = (await fs.readFile(FULL_HISTORY_FILE, 'utf8')).replace(/^\uFEFF/, '').trim();
  const lines = text.split(/\r?\n/);
  const headers = lines.shift().split(',');
  return lines.map(line => {
    const values = line.split(',');
    const row = Object.fromEntries(headers.map((header, index) => [header, values[index]]));
    return {
      date: row.date,
      zzhl: Number(row.zzhl_close),
      cyb: Number(row.cyb_close),
      ma90: numberOrNull(row.zzhl_ma90),
      ma40: numberOrNull(row.zzhl_ma40),
      r: Number(row.R)
    };
  }).filter(row => row.date && Number.isFinite(row.zzhl) && Number.isFinite(row.cyb));
}

async function getFallback() {
  if (fallback) return fallback;
  try {
    fallback = { series: await readFullHistory() };
  } catch {
    fallback = JSON.parse(await fs.readFile(path.join(ROOT, 'data', 'initial-data.json'), 'utf8'));
  }
  return fallback;
}

async function getHistory(force = false) {
  if (!force && cache.history && Date.now() - cache.historyAt < 10 * 60 * 1000) return cache.history;
  const localRows = await readFullHistory().catch(() => null);
  try {
    const [zzhl, cyb, monthly] = await Promise.all([
      fetchTencentDaily('sh000922'),
      fetchTencentDaily('sz399006'),
      fetchTencentMonthly('sh000922')
    ]);
    const recent = alignSeries(zzhl, cyb, monthly);
    const byDate = new Map((localRows || (await getFallback()).series).map(row => [row.date, row]));
    recent.forEach(row => byDate.set(row.date, row));
    cache.history = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    cache.historyAt = Date.now();
    return cache.history;
  } catch (error) {
    cache.error = String(error?.message || error);
    if (cache.history) return cache.history;
    if (localRows) return localRows;
    return (await getFallback()).series;
  }
}

async function getLiveQuote() {
  const now = chinaParts();
  const market = marketState(now);
  if (!market.isOpen && cache.quote && Date.now() - cache.quoteAt < 5 * 60 * 1000) return cache.quote;
  if (market.isOpen && cache.quote && Date.now() - cache.quoteAt < 10 * 1000) return cache.quote;
  try {
    const [zzhl, cyb] = await Promise.all([
      fetchEastmoneyQuote('1.000922'),
      fetchEastmoneyQuote('0.399006')
    ]);
    cache.quote = {
      zzhl,
      cyb,
      isLive: market.isOpen,
      date: market.isOpen ? now.date : null,
      fetchedAt: new Date().toISOString(),
      market
    };
    cache.quoteAt = Date.now();
    return cache.quote;
  } catch (error) {
    cache.error = String(error?.message || error);
    if (cache.quote) return cache.quote;
    return null;
  }
}

function marketMeta(now = chinaParts()) {
  const market = marketState(now);
  return {
    marketStatus: market.label,
    isLive: market.isOpen,
    pollMs: market.isOpen ? 10000 : 300000,
    nowChina: `${now.date} ${now.time}`,
    ...(cache.error ? { lastError: cache.error } : {})
  };
}

async function buildBootstrap(force = false) {
  if (!force && cache.bootstrap && Date.now() - cache.bootstrapAt < 2 * 60 * 1000) return cache.bootstrap;
  const history = await getHistory(force);
  const live = await getLiveQuote();
  const snapshot = enrich(history, live);
  const data = {
    ...snapshot,
    meta: {
      ...marketMeta(),
      lastDate: snapshot.series.at(-1)?.date,
      historyStart: snapshot.series[0]?.date,
      historyCount: snapshot.series.length,
      generatedAt: new Date().toISOString(),
      sources: {
        quotes: '东方财富移动行情',
        indices: '本地完整历史 + 腾讯日线与月线'
      }
    }
  };
  cache.bootstrap = data;
  cache.bootstrapAt = Date.now();
  return data;
}

async function getQuotePayload(force = false) {
  const history = await getHistory(force);
  const live = await getLiveQuote();
  const snapshot = enrich(history, live);
  return {
    quote: snapshot.quote,
    strategy: snapshot.strategy,
    latestPoint: snapshot.series.at(-1),
    meta: {
      ...marketMeta(),
      lastDate: snapshot.series.at(-1)?.date,
      historyStart: snapshot.series[0]?.date,
      historyCount: snapshot.series.length,
      generatedAt: new Date().toISOString()
    }
  };
}

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

async function serveStatic(req, res) {
  let pathname = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname);
  if (pathname === '/') pathname = '/index.html';
  const file = path.resolve(ROOT, `.${pathname}`);
  if (!file.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, {
      'content-type': mime[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache'
    });
    res.end(data);
  } catch {
    res.writeHead(404).end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/api/bootstrap' || url.pathname === '/api/quote') {
      const force = url.searchParams.get('force') === '1';
      const payload = url.pathname === '/api/bootstrap'
        ? await buildBootstrap(force)
        : await getQuotePayload(force);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(payload));
      return;
    }
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, ...marketMeta(), cacheError: cache.error }));
      return;
    }
    await serveStatic(req, res);
  } catch (error) {
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: String(error?.message || error) }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Live market dashboard: http://${HOST}:${PORT}`);
});
