#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const snapshotDir = path.join(root, "data", "snapshots");
const conflictsPath = path.join(root, "data", "conflicts.json");
const healthEventsPath = path.join(root, "data", "health-events.json");
const financialEventsPath = path.join(root, "data", "financial-events.json");
const outputPath = path.join(root, "public", "data.js");
const snapshotPath = path.join(snapshotDir, "latest.json");
const today = new Date();
const endDate = formatDate(today);
const startDate = "1982-09-27";
const userAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";

async function fetchText(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(25_000),
    headers: {
      "user-agent": userAgent,
      accept: "text/csv,application/json,text/html;q=0.9,*/*;q=0.8",
      ...options.headers,
    },
  });

  if (!response.ok) {
    throw new Error(`Request failed ${response.status}: ${url}`);
  }

  return response.text();
}

async function withRetry(operation, label, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        console.warn(`${label}: attempt ${attempt} failed, retrying`);
        await new Promise((resolve) => setTimeout(resolve, attempt * 800));
      }
    }
  }
  throw lastError;
}

async function writeAtomic(filePath, content) {
  const temporaryPath = `${filePath}.tmp`;
  await writeFile(temporaryPath, content, "utf8");
  await rename(temporaryPath, filePath);
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = lines.shift().split(",").map((value) => value.trim());

  return lines
    .map((line) => {
      const values = line.split(",");
      return Object.fromEntries(
        headers.map((header, index) => [header, values[index]?.trim() ?? ""]),
      );
    })
    .filter((row) => Object.values(row).some(Boolean));
}

function decodeXml(value = "") {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

function stripHtml(value) {
  return decodeXml(value)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function xmlTag(block, tag) {
  const match = block.match(
    new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"),
  );
  return match ? decodeXml(match[1]).trim() : "";
}

function parseRssItems(xml, source, category, limit = 12) {
  return [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)]
    .slice(0, limit)
    .map((match) => {
      const item = match[0];
      const title = stripHtml(xmlTag(item, "title"));
      const url = stripHtml(xmlTag(item, "link"));
      const published = new Date(xmlTag(item, "pubDate"));
      return {
        id: `${source}-${hashText(`${title}${url}`).slice(0, 12)}`,
        category,
        title,
        summary: stripHtml(xmlTag(item, "description")).slice(0, 240),
        source,
        url,
        publishedAt: Number.isFinite(published.getTime())
          ? published.toISOString()
          : new Date().toISOString(),
      };
    })
    .filter((item) => item.title && item.url);
}

function hashText(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseFredSeries(text, column) {
  return parseCsv(text)
    .map((row) => {
      const rawValue = row[column];
      return {
        date: row.observation_date,
        value:
          rawValue === "" || rawValue === "." || rawValue === undefined
            ? Number.NaN
            : Number(rawValue),
      };
    })
    .filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date) && Number.isFinite(row.value));
}

function parseStooqSeries(text) {
  const csvStart = text.search(/(?:^|\r?\n)Date,(?:Open|Close)/i);
  if (csvStart === -1) {
    throw new Error("Stooq response did not contain a CSV table");
  }

  const csv = text.slice(csvStart).trim();
  return parseCsv(csv)
    .map((row) => ({
      date: row.Date,
      open: Number(row.Open),
      high: Number(row.High),
      low: Number(row.Low),
      value: Number(row.Close),
    }))
    .filter(
      (row) =>
        /^\d{4}-\d{2}-\d{2}$/.test(row.date) &&
        Number.isFinite(row.value) &&
        row.value > 0,
    )
    .map((row) => ({ ...row, hasOhlc: true }));
}

function mergeCookies(cookieJar, response) {
  const incoming =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie")].filter(Boolean);

  for (const header of incoming) {
    const pair = header.split(";", 1)[0];
    const separator = pair.indexOf("=");
    if (separator > 0) {
      cookieJar.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
  }
}

function cookieHeader(cookieJar) {
  return [...cookieJar.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
}

function solveChallenge(challenge, difficulty) {
  const target = "0".repeat(difficulty);
  let nonce = 0;

  while (nonce < 50_000_000) {
    const digest = createHash("sha256").update(`${challenge}${nonce}`).digest("hex");
    if (digest.startsWith(target)) {
      return nonce;
    }
    nonce += 1;
  }

  throw new Error("Unable to solve Stooq browser challenge");
}

async function fetchStooqSeries(symbol) {
  const url = new URL("https://stooq.com/q/d/l/");
  url.searchParams.set("s", symbol);
  url.searchParams.set("d1", "1982-01-01");
  url.searchParams.set("d2", endDate);
  url.searchParams.set("i", "d");

  const cookieJar = new Map();
  let response = await fetch(url, {
    headers: {
      "user-agent": userAgent,
      accept: "text/csv,text/html;q=0.9,*/*;q=0.8",
    },
  });
  mergeCookies(cookieJar, response);
  let text = await response.text();

  if (/requires JavaScript to verify your browser/i.test(text)) {
    const challenge =
      /const c="([^"]+)"/.exec(text)?.[1] ??
      (() => {
        throw new Error("Stooq challenge token not found");
      })();
    const difficulty = Number(/const d=(\d+)/.exec(text)?.[1] ?? 4);
    const nonce = solveChallenge(challenge, difficulty);
    const verifyUrl = new URL("/__verify", url.origin);
    const verifyResponse = await fetch(verifyUrl, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: cookieHeader(cookieJar),
        "user-agent": userAgent,
        origin: url.origin,
        referer: url.origin,
        "sec-fetch-site": "same-origin",
      },
      body: new URLSearchParams({ c: challenge, n: String(nonce) }),
    });
    mergeCookies(cookieJar, verifyResponse);

    response = await fetch(url, {
      headers: {
        cookie: cookieHeader(cookieJar),
        referer: `${url.origin}/q/d/?s=${encodeURIComponent(symbol)}`,
        "user-agent": userAgent,
        accept: "text/csv,text/html;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "same-origin",
        "sec-fetch-user": "?1",
        "upgrade-insecure-requests": "1",
      },
    });
    text = await response.text();
  }

  if (!response.ok) {
    throw new Error(`Stooq request failed ${response.status}`);
  }

  return parseStooqSeries(text);
}

async function fetchFred(id, column = id) {
  const url = new URL("https://fred.stlouisfed.org/graph/fredgraph.csv");
  url.searchParams.set("id", id);
  return parseFredSeries(await fetchText(url), column);
}

async function fetchFredWithRetry(id, column = id) {
  return withRetry(() => fetchFred(id, column), `FRED ${id}`);
}

async function fetchEastmoneySeries(secid) {
  const url = new URL("https://push2his.eastmoney.com/api/qt/stock/kline/get");
  url.searchParams.set("secid", secid);
  url.searchParams.set("fields1", "f1,f2,f3,f4,f5,f6");
  url.searchParams.set("fields2", "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61");
  url.searchParams.set("klt", "101");
  url.searchParams.set("fqt", "1");
  url.searchParams.set("beg", "19800101");
  url.searchParams.set("end", "20500101");

  const response = await fetch(url, {
    headers: {
      "user-agent": userAgent,
      accept: "application/json,text/plain,*/*",
      referer: "https://quote.eastmoney.com/",
    },
  });
  if (!response.ok) {
    throw new Error(`Eastmoney request failed ${response.status}`);
  }

  const payload = await response.json();
  const rows = payload?.data?.klines;
  if (!Array.isArray(rows)) {
    throw new Error("Eastmoney response did not contain kline rows");
  }

  return rows
    .map((line) => {
      const [date, open, close, high, low] = line.split(",");
      return {
        date,
        open: Number(open),
        high: Number(high),
        low: Number(low),
        value: Number(close),
      };
    })
    .filter(
      (row) =>
        /^\d{4}-\d{2}-\d{2}$/.test(row.date) &&
        Number.isFinite(row.value) &&
        row.value > 0,
    );
}

async function optionalEastmoney(secid, label) {
  try {
    const rows = await fetchEastmoneySeries(secid);
    console.log(`${label}: loaded ${rows.length} rows from Eastmoney`);
    return rows;
  } catch (error) {
    console.warn(`${label}: Eastmoney unavailable (${error.message})`);
    return [];
  }
}

async function fetchSinaSeries(symbol) {
  const url = new URL(
    `https://stock.finance.sina.com.cn/futures/api/jsonp.php/var%20_${symbol}=/GlobalFuturesService.getGlobalFuturesDailyKLine`,
  );
  url.searchParams.set("symbol", symbol);

  const text = await fetchText(url, {
    headers: {
      accept: "application/javascript,text/plain,*/*",
      referer: "https://finance.sina.com.cn/",
    },
  });
  const match = text.match(/=\((\[[\s\S]*\])\);/);
  if (!match) {
    throw new Error("Sina response did not contain a data array");
  }

  return JSON.parse(match[1])
    .map((row) => ({
      date: row.date,
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      value: Number(row.close),
      hasOhlc: true,
    }))
    .filter(
      (row) =>
        /^\d{4}-\d{2}-\d{2}$/.test(row.date) &&
        Number.isFinite(row.value) &&
        row.value > 0,
    );
}

async function fetchTencentChunk(symbol, startDate, endDate) {
  const url = new URL("https://web.ifzq.gtimg.cn/appstock/app/usfqkline/get");
  url.searchParams.set(
    "param",
    `${symbol},day,${startDate},${endDate},640,qfq`,
  );
  const response = await fetch(url, {
    headers: {
      "user-agent": userAgent,
      accept: "application/json,text/plain,*/*",
      referer: "https://gu.qq.com/",
    },
  });
  if (!response.ok) {
    throw new Error(`Tencent request failed ${response.status}`);
  }

  const payload = await response.json();
  const rows = payload?.data?.[symbol]?.day;
  if (payload?.code !== 0 || !Array.isArray(rows)) {
    throw new Error(payload?.msg || "Tencent response did not contain kline rows");
  }

  return rows.map((line) => {
    const [date, open, close, high, low] = line;
    return {
      date,
      open: Number(open),
      high: Number(high),
      low: Number(low),
      value: Number(close),
      hasOhlc: true,
    };
  });
}

async function fetchTencentChinaChunk(symbol, startDate, endDate) {
  const url = new URL("https://web.ifzq.gtimg.cn/appstock/app/kline/kline");
  url.searchParams.set("param", `${symbol},day,${startDate},${endDate},640`);
  const response = await fetch(url, {
    headers: {
      "user-agent": userAgent,
      accept: "application/json,text/plain,*/*",
      referer: "https://gu.qq.com/",
    },
  });
  if (!response.ok) {
    throw new Error(`Tencent China request failed ${response.status}`);
  }

  const payload = await response.json();
  const rows = payload?.data?.[symbol]?.day;
  if (payload?.code !== 0 || !Array.isArray(rows)) {
    throw new Error(payload?.msg || "Tencent China response did not contain kline rows");
  }

  return rows.map((line) => {
    const [date, open, close, high, low] = line;
    return {
      date,
      open: Number(open),
      high: Number(high),
      low: Number(low),
      value: Number(close),
      hasOhlc: true,
    };
  });
}

async function fetchTencentSeries(symbol, startYear) {
  const currentYear = today.getUTCFullYear();
  const chunks = [];
  for (let year = startYear; year <= currentYear; year += 2) {
    chunks.push({
      start: `${year}-01-01`,
      end: `${Math.min(year + 1, currentYear)}-12-31`,
    });
  }

  const rows = [];
  for (let index = 0; index < chunks.length; index += 5) {
    const batch = await Promise.all(
      chunks.slice(index, index + 5).map((chunk) =>
        fetchTencentChunk(symbol, chunk.start, chunk.end),
      ),
    );
    rows.push(...batch.flat());
  }

  const byDate = new Map(rows.map((row) => [row.date, row]));
  return [...byDate.values()]
    .filter(
      (row) =>
        /^\d{4}-\d{2}-\d{2}$/.test(row.date) &&
        Number.isFinite(row.value) &&
        row.value > 0,
    )
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchTencentChinaSeries(symbol, startYear) {
  const currentYear = today.getUTCFullYear();
  const chunks = [];
  for (let year = startYear; year <= currentYear; year += 2) {
    chunks.push({
      start: `${year}-01-01`,
      end: `${Math.min(year + 1, currentYear)}-12-31`,
    });
  }

  const rows = [];
  for (let index = 0; index < chunks.length; index += 5) {
    const batch = await Promise.all(
      chunks.slice(index, index + 5).map((chunk) =>
        fetchTencentChinaChunk(symbol, chunk.start, chunk.end),
      ),
    );
    rows.push(...batch.flat());
  }

  const byDate = new Map(rows.map((row) => [row.date, row]));
  return [...byDate.values()]
    .filter(
      (row) =>
        /^\d{4}-\d{2}-\d{2}$/.test(row.date) &&
        Number.isFinite(row.value) &&
        row.value > 0,
    )
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function optionalTencent(symbol, label, startYear) {
  try {
    const rows = await fetchTencentSeries(symbol, startYear);
    console.log(`${label}: loaded ${rows.length} rows from Tencent`);
    return rows;
  } catch (error) {
    console.warn(`${label}: Tencent unavailable (${error.message})`);
    return [];
  }
}

async function optionalTencentChina(symbol, label, startYear) {
  try {
    const rows = await fetchTencentChinaSeries(symbol, startYear);
    console.log(`${label}: loaded ${rows.length} rows from Tencent China`);
    return rows;
  } catch (error) {
    console.warn(`${label}: Tencent China unavailable (${error.message})`);
    return [];
  }
}

async function optionalSina(symbol, label) {
  try {
    const rows = await fetchSinaSeries(symbol);
    console.log(`${label}: loaded ${rows.length} rows from Sina`);
    return rows;
  } catch (error) {
    console.warn(`${label}: Sina unavailable (${error.message})`);
    return [];
  }
}

async function safeFetch(label, operation, fallback = []) {
  try {
    return await operation();
  } catch (error) {
    console.warn(`${label}: news source unavailable (${error.message})`);
    return fallback;
  }
}

function macroNewsItem({
  id,
  title,
  summary,
  url,
  dataDate,
  category = "经济数据",
  source = "FRED",
}) {
  return {
    id,
    category,
    title,
    summary,
    source,
    url,
    publishedAt: new Date().toISOString(),
    dataDate,
  };
}

async function fetchMacroNews() {
  const [cpiRows, payrollRows, unemploymentRows] = await Promise.all([
    fetchFredWithRetry("CPIAUCSL"),
    fetchFredWithRetry("PAYEMS"),
    fetchFredWithRetry("UNRATE"),
  ]);
  const cpiLatest = cpiRows.at(-1);
  const cpiYearAgo = cpiRows.at(-13);
  const payrollLatest = payrollRows.at(-1);
  const payrollPrevious = payrollRows.at(-2);
  const unemploymentLatest = unemploymentRows.at(-1);
  const news = [];

  if (cpiLatest && cpiYearAgo) {
    const yoy = (cpiLatest.value / cpiYearAgo.value - 1) * 100;
    news.push(
      macroNewsItem({
        id: `macro-cpi-${cpiLatest.date}`,
        title: `美国CPI最新数据：同比 ${yoy >= 0 ? "+" : ""}${yoy.toFixed(1)}%（${cpiLatest.date.slice(0, 7)}）`,
        summary: "美国劳工统计局消费者价格指数，经 FRED 更新。",
        url: "https://fred.stlouisfed.org/series/CPIAUCSL",
        dataDate: cpiLatest.date,
      }),
    );
  }
  if (payrollLatest && payrollPrevious) {
    const change = payrollLatest.value - payrollPrevious.value;
    news.push(
      macroNewsItem({
        id: `macro-payrolls-${payrollLatest.date}`,
        title: `美国非农新增就业 ${change >= 0 ? "+" : ""}${(change / 10).toFixed(1)} 万人（${payrollLatest.date.slice(0, 7)}）`,
        summary: "美国非农就业总人数月度变化，经 FRED 更新。",
        url: "https://fred.stlouisfed.org/series/PAYEMS",
        dataDate: payrollLatest.date,
      }),
    );
  }
  if (unemploymentLatest) {
    news.push(
      macroNewsItem({
        id: `macro-unemployment-${unemploymentLatest.date}`,
        title: `美国失业率最新值 ${unemploymentLatest.value.toFixed(1)}%（${unemploymentLatest.date.slice(0, 7)}）`,
        summary: "美国月度失业率，经 FRED 更新。",
        url: "https://fred.stlouisfed.org/series/UNRATE",
        dataDate: unemploymentLatest.date,
      }),
    );
  }

  return news;
}

async function fetchResourceNews() {
  const series = [
    {
      id: "PCOPPUSDM",
      label: "全球铜价",
      unit: "美元/吨",
      url: "https://fred.stlouisfed.org/series/PCOPPUSDM",
    },
    {
      id: "PIORECRUSDM",
      label: "全球铁矿石价格",
      unit: "美元/吨",
      url: "https://fred.stlouisfed.org/series/PIORECRUSDM",
    },
    {
      id: "PZINCUSDM",
      label: "全球锌价",
      unit: "美元/吨",
      url: "https://fred.stlouisfed.org/series/PZINCUSDM",
    },
    {
      id: "PNICKUSDM",
      label: "全球镍价",
      unit: "美元/吨",
      url: "https://fred.stlouisfed.org/series/PNICKUSDM",
    },
    {
      id: "PALUMUSDM",
      label: "全球铝价",
      unit: "美元/吨",
      url: "https://fred.stlouisfed.org/series/PALUMUSDM",
    },
  ];
  const results = await Promise.all(
    series.map((item) =>
      safeFetch(
        item.id,
        async () => {
          const rows = await fetchFredWithRetry(item.id);
          const latest = rows.at(-1);
          const previous = rows.at(-2);
          if (!latest) {
            return null;
          }
          const change =
            previous && previous.value !== 0
              ? (latest.value / previous.value - 1) * 100
              : null;
          return macroNewsItem({
            id: `resource-${item.id}-${latest.date}`,
            category: "矿产资源",
            source: "FRED Commodities",
            title: `${item.label}最新值 ${latest.value.toFixed(1)} ${item.unit}（${latest.date.slice(0, 7)}）${
              change === null
                ? ""
                : `，环比 ${change >= 0 ? "+" : ""}${change.toFixed(1)}%`
            }`,
            summary: `${item.label}月度国际价格，经 FRED 更新。`,
            url: item.url,
            dataDate: latest.date,
          });
        },
        null,
      ),
    ),
  );
  return results.filter(Boolean).slice(0, 4);
}

async function fetchFoodNews() {
  const series = [
    {
      id: "PFOODINDEXM",
      label: "全球食品价格指数",
      unit: "指数",
      url: "https://fred.stlouisfed.org/series/PFOODINDEXM",
    },
    {
      id: "PWHEAMTUSDM",
      label: "全球小麦价格",
      unit: "美元/吨",
      url: "https://fred.stlouisfed.org/series/PWHEAMTUSDM",
    },
    {
      id: "PMAIZMTUSDM",
      label: "全球玉米价格",
      unit: "美元/吨",
      url: "https://fred.stlouisfed.org/series/PMAIZMTUSDM",
    },
    {
      id: "PSOYBUSDQ",
      label: "全球大豆价格",
      unit: "美元/吨",
      url: "https://fred.stlouisfed.org/series/PSOYBUSDQ",
    },
  ];
  const results = await Promise.all(
    series.map((item) =>
      safeFetch(
        item.id,
        async () => {
          const rows = await fetchFredWithRetry(item.id);
          const latest = rows.at(-1);
          const previous = rows.at(-2);
          if (!latest) {
            return null;
          }
          const change =
            previous && previous.value !== 0
              ? (latest.value / previous.value - 1) * 100
              : null;
          return macroNewsItem({
            id: `food-${item.id}-${latest.date}`,
            category: "粮食农业",
            source: "FAO / FRED",
            title: `${item.label}最新值 ${latest.value.toFixed(1)} ${item.unit}（${latest.date.slice(0, 7)}）${
              change === null
                ? ""
                : `，环比 ${change >= 0 ? "+" : ""}${change.toFixed(1)}%`
            }`,
            summary: `${item.label}月度数据，经 FRED 更新。`,
            url: item.url,
            dataDate: latest.date,
          });
        },
        null,
      ),
    ),
  );
  return results.filter(Boolean).slice(0, 4);
}

async function fetchMiningNews() {
  const fetchPosts = async (searchTerm = "") => {
    const url = new URL("https://www.mining.com/wp-json/wp/v2/posts");
    url.searchParams.set("per_page", searchTerm ? "8" : "30");
    url.searchParams.set("_fields", "id,date,link,title,excerpt");
    if (searchTerm) {
      url.searchParams.set("search", searchTerm);
    }
    const response = await fetch(url, {
      headers: {
        "user-agent": userAgent,
        accept: "application/json,text/plain,*/*",
        referer: "https://www.mining.com/",
      },
    });
    if (!response.ok) {
      throw new Error(`Mining.com request failed ${response.status}`);
    }
    return response.json();
  };
  const [general, rareEarth] = await Promise.all([
    fetchPosts(),
    fetchPosts("rare earth"),
  ]);
  console.log(
    `Mining.com: loaded ${general.length} general and ${rareEarth.length} rare-earth posts`,
  );
  const byId = new Map(
    [...general, ...rareEarth].map((item) => [item.id, item]),
  );
  const rareEarthIds = new Set(
    rareEarth.map((item) => `mining-${item.id}`),
  );
  return [...byId.values()]
    .map((item) => ({
      id: `mining-${item.id}`,
      category: "矿产资源",
      title: stripHtml(item.title?.rendered ?? ""),
      summary: stripHtml(item.excerpt?.rendered ?? "").slice(0, 240),
      source: "MINING.COM",
      url: item.link,
      publishedAt: new Date(item.date).toISOString(),
    }))
    .filter((item) =>
      /copper|rare earth|lithium|nickel|zinc|aluminum|aluminium|iron ore|mining|critical mineral|graphite|cobalt|silver|gold/i.test(
        item.title,
      ),
    )
    .sort(
      (a, b) =>
        Number(rareEarthIds.has(b.id)) - Number(rareEarthIds.has(a.id)) ||
        new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime(),
    )
    .slice(0, 12);
}

async function fetchFaoNews() {
  const xml = await fetchText("https://www.fao.org/feeds/fao-newsroom-rss");
  return parseRssItems(xml, "FAO", "粮食农业", 20).filter(
    (item) =>
      /food|agricultur|crop|wheat|maize|corn|soy|rice|fertilizer|fisher|livestock|hunger|harvest|grain/i.test(
        item.title,
      ),
  );
}

function classifyDomesticNews(title, summary = "") {
  const text = `${title} ${summary}`;
  if (/美联储|联邦基金|加息|降息|FOMC/i.test(text)) {
    return "美联储";
  }
  if (/CPI|非农|失业率|通胀|PMI|GDP|经济数据/i.test(text)) {
    return "经济数据";
  }
  if (/稀土|铜|锂|镍|锌|铝|铁矿石|有色|矿产|矿业/i.test(text)) {
    return "矿产资源";
  }
  if (/粮食|小麦|玉米|大豆|食品|农业|丰收/i.test(text)) {
    return "粮食农业";
  }
  if (/房地产|楼市|恒大|房贷|银行|债务|金融风险|违约/i.test(text)) {
    return "金融风险";
  }
  if (/疫情|病毒|公共卫生|流感/i.test(text)) {
    return "公共卫生";
  }
  if (/战争|冲突|袭击|空袭|导弹|制裁|停火|军事/i.test(text)) {
    return "地缘政治";
  }
  if (/原油|黄金|股市|指数|市场|汇率/i.test(text)) {
    return "全球市场";
  }
  return null;
}

async function fetchSinaRollNews() {
  const url = new URL("https://feed.mix.sina.com.cn/api/roll/get");
  url.searchParams.set("pageid", "153");
  url.searchParams.set("lid", "2516");
  url.searchParams.set("num", "50");
  url.searchParams.set("page", "1");
  const response = await fetch(url, {
    headers: {
      "user-agent": userAgent,
      accept: "application/json,text/plain,*/*",
      referer: "https://finance.sina.com.cn/",
    },
  });
  if (!response.ok) {
    throw new Error(`Sina roll news request failed ${response.status}`);
  }
  const payload = await response.json();
  return (payload?.result?.data ?? [])
    .map((item) => {
      const title = stripHtml(item.title ?? "");
      const summary = stripHtml(item.intro ?? "");
      const category = classifyDomesticNews(title, summary);
      if (!category) {
        return null;
      }
      return {
        id: `sina-${item.docid ?? hashText(title).slice(0, 12)}`,
        category,
        title,
        summary: summary.slice(0, 240),
        source: "新浪财经",
        url: item.url,
        publishedAt: new Date(Number(item.ctime) * 1000).toISOString(),
      };
    })
    .filter(Boolean)
    .slice(0, 12);
}

async function fetchChinanewsRollNews() {
  const dates = [today, new Date(today.getTime() - 86_400_000)];
  const pages = await Promise.all(
    dates.map(async (date) => {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, "0");
      const day = String(date.getDate()).padStart(2, "0");
      const url = `https://www.chinanews.com.cn/scroll-news/${year}/${month}${day}/news.shtml`;
      const html = await fetchText(url, {
        headers: {
          accept: "text/html,*/*",
        },
      });
      return [...html.matchAll(
        /<div class="dd_bt"><a href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/div><div class="dd_time">([^<]+)<\/div>/gi,
      )].map((match) => {
        const title = stripHtml(match[2]);
        const category = classifyDomesticNews(title);
        if (!category) {
          return null;
        }
        const time = match[3].trim();
        const [timeMonth, timeDay, clock] = time.match(/(\d+)-(\d+)\s+(\d+:\d+)/)?.slice(1) ?? [];
        const publishedAt =
          timeMonth && timeDay && clock
            ? new Date(
                `${year}-${String(timeMonth).padStart(2, "0")}-${String(timeDay).padStart(2, "0")}T${clock}:00+08:00`,
              )
            : date;
        return {
          id: `chinanews-${hashText(`${title}${match[1]}`).slice(0, 12)}`,
          category,
          title,
          summary: "",
          source: "中国新闻网",
          url: new URL(match[1], "https://www.chinanews.com.cn").toString(),
          publishedAt: publishedAt.toISOString(),
        };
      });
    }),
  );
  return pages.flat().filter(Boolean).slice(0, 12);
}

async function fetchEastmoneyNews() {
  const xml = await fetchText("https://rss.eastmoney.com/rss_partener.xml");
  return parseRssItems(xml, "东方财富", "全球市场", 30)
    .map((item) => ({
      ...item,
      category: classifyDomesticNews(item.title, item.summary) ?? item.category,
    }))
    .slice(0, 12);
}

async function fetchDomesticNews() {
  const results = await Promise.all([
    safeFetch("Sina Finance", fetchSinaRollNews),
    safeFetch("China News Service", fetchChinanewsRollNews),
    safeFetch("Eastmoney", fetchEastmoneyNews),
  ]);
  return results.flat();
}

async function fetchNoaaEnsoNews() {
  const html = await fetchText(
    "https://www.climate.gov/news-features/blogs/enso",
    {
      headers: {
        accept: "text/html,*/*",
      },
    },
  );
  const match = html.match(
    /href="([^"]+)"[^>]*class="[^"]*heading-2__link[^"]*"[^>]*>([\s\S]*?)<\/a>/i,
  );
  if (!match) {
    return [];
  }
  const title = stripHtml(match[2]);
  return [
    {
      id: `noaa-${hashText(title).slice(0, 12)}`,
      category: "气候风险",
      title,
      summary: "NOAA Climate.gov 最新 ENSO、厄尔尼诺或拉尼娜分析。",
      source: "NOAA",
      url: new URL(match[1], "https://www.climate.gov").toString(),
      publishedAt: new Date().toISOString(),
    },
  ];
}

function newsScore(item) {
  const keywords = [
    "nonfarm",
    "payroll",
    "employment",
    "unemployment",
    "cpi",
    "inflation",
    "interest rate",
    "federal reserve",
    "rate cut",
    "rate hike",
    "gdp",
    "recession",
    "oil",
    "gold",
    "market",
    "tariff",
    "war",
    "conflict",
    "sanction",
    "el niño",
    "el nino",
    "la niña",
    "la nina",
    "drought",
    "hurricane",
    "copper",
    "rare earth",
    "lithium",
    "iron ore",
    "mining",
    "wheat",
    "maize",
    "soybean",
    "fertilizer",
    "grain",
    "food price",
    "铜价",
    "铁矿石",
    "锌价",
    "镍价",
    "铝价",
    "食品价格",
    "小麦",
    "玉米",
    "大豆",
  ];
  const text = `${item.title} ${item.summary}`.toLowerCase();
  const categoryWeight = {
    经济数据: 12,
    全球市场: 8,
    地缘政治: 6,
    气候风险: 7,
    矿产资源: 10,
    粮食农业: 10,
    金融风险: 10,
    公共卫生: 8,
    美联储: 4,
  };
  let score = keywords.reduce(
    (score, keyword) => score + (text.includes(keyword) ? 4 : 0),
    categoryWeight[item.category] ?? 0,
  );
  if (/rare earth/.test(text)) {
    score += 30;
  }
  if (/copper|铜/.test(text)) {
    score += 8;
  }
  return score;
}

function rankNewsItems(results) {
  const seen = new Set();
  const rankedItems = results
    .flat()
    .filter((item) => {
      const key = item.title.toLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .map((item) => ({ ...item, score: newsScore(item) }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime(),
    );
  const sourceCaps = {
    FRED: 3,
    "UN News": 5,
    MarketWatch: 4,
    "Federal Reserve": 4,
    NOAA: 1,
    "FRED Commodities": 4,
    "FAO / FRED": 4,
    "MINING.COM": 4,
    FAO: 4,
    新浪财经: 4,
    中国新闻网: 4,
    东方财富: 3,
  };
  const sourceCounts = new Map();
  const selected = [];
  for (const item of rankedItems) {
    const count = sourceCounts.get(item.source) ?? 0;
    const cap = sourceCaps[item.source] ?? 3;
    if (count >= cap) {
      continue;
    }
    selected.push(item);
    sourceCounts.set(item.source, count + 1);
    if (selected.length === 16) {
      break;
    }
  }
  if (selected.length < 16) {
    for (const item of rankedItems) {
      if (!selected.includes(item)) {
        selected.push(item);
      }
      if (selected.length === 16) {
        break;
      }
    }
  }
  return selected;
}

async function fetchNewsItems({ includeData = true } = {}) {
  const results = await Promise.all([
    safeFetch(
      "Federal Reserve",
      async () => {
        const items = parseRssItems(
          await fetchText("https://www.federalreserve.gov/feeds/press_all.xml"),
          "Federal Reserve",
          "美联储",
          50,
        );
        return items.filter(
          (item) =>
            !/enforcement|application|approval|termination|orders|membership/i.test(
              item.title,
            ) &&
            /monetary|interest rate|federal open market|inflation|employment|economic|minutes|speech|testimony|policy/i.test(
              item.title,
            ),
        );
      },
    ),
    safeFetch(
      "MarketWatch",
      async () => {
        const items = parseRssItems(
          await fetchText(
            "https://feeds.content.dowjones.io/public/rss/mw_topstories",
          ),
          "MarketWatch",
          "全球市场",
          20,
        );
        return items.filter(
          (item) =>
            !/executor|IRA|401\(k\)|student loan|credit card|personal finance|inherited/i.test(
              item.title,
            ),
        );
      },
    ),
    safeFetch(
      "UN News",
      async () => {
        const items = parseRssItems(
          await fetchText(
            "https://news.un.org/feed/subscribe/en/news/all/rss.xml",
          ),
          "UN News",
          "地缘政治",
          20,
        );
        return items.map((item) => ({
          ...item,
          category:
            /climate|flood|drought|el niño|el nino|la niña|la nina|enso|heat|wildfire|hurricane/i.test(
              item.title,
            )
              ? "气候风险"
              : item.category,
        }));
      },
    ),
    safeFetch("NOAA", fetchNoaaEnsoNews),
    safeFetch("MINING.COM", fetchMiningNews),
    safeFetch("FAO", fetchFaoNews),
    safeFetch("Domestic news", fetchDomesticNews),
    ...(includeData
      ? [
          safeFetch("Macro data", fetchMacroNews),
          safeFetch("Resource data", fetchResourceNews),
          safeFetch("Food data", fetchFoodNews),
        ]
      : []),
  ]);

  const items = rankNewsItems(results);
  if (items.length) {
    return items;
  }
  try {
    const previous = JSON.parse(await readFile(snapshotPath, "utf8"));
    return previous.news ?? [];
  } catch {
    return [];
  }
}

async function previousMarketRows(key) {
  try {
    const previous = JSON.parse(await readFile(snapshotPath, "utf8"));
    return (previous.markets?.[key] ?? []).map((row) => ({
      date: row[0],
      value: row[1],
      open: row[2],
      high: row[3],
      low: row[4],
      hasOhlc: row[5] !== 0 && row[2] !== undefined,
    }));
  } catch {
    return [];
  }
}

async function withPreviousMarket(key, operation, label) {
  try {
    return await operation();
  } catch (error) {
    const previous = await previousMarketRows(key);
    if (previous.length) {
      console.warn(`${label}: using previous successful snapshot`);
      return previous;
    }
    throw error;
  }
}

function compactMarketPoints(rows) {
  return rows.map((row) =>
    row.open === undefined
      ? [row.date, row.value]
      : [row.date, row.value, row.open, row.high, row.low, row.hasOhlc === false ? 0 : 1],
  );
}

function mergeOhlcWithClose(ohlcRows, closeRows) {
  const ohlcByDate = new Map(ohlcRows.map((row) => [row.date, row]));
  const closeByDate = new Map(closeRows.map((row) => [row.date, row]));
  return [...new Set([...closeByDate.keys(), ...ohlcByDate.keys()])]
    .sort()
    .map(
      (date) =>
        ohlcByDate.get(date) ??
        closeByDate.get(date) ?? {
          date,
          value: Number.NaN,
        },
    )
    .filter((row) => Number.isFinite(row.value));
}

function combineTargetRate(targetRows, rangeUpperRows, rangeLowerRows) {
  const upperByDate = new Map(rangeUpperRows.map((row) => [row.date, row.value]));
  const lowerByDate = new Map(rangeLowerRows.map((row) => [row.date, row.value]));
  const byDate = new Map();

  for (const row of targetRows) {
    byDate.set(row.date, { date: row.date, target: row.value });
  }
  for (const date of new Set([...upperByDate.keys(), ...lowerByDate.keys()])) {
    const upper = upperByDate.get(date);
    const lower = lowerByDate.get(date);
    if (Number.isFinite(upper) && Number.isFinite(lower)) {
      byDate.set(date, { date, upper, lower, target: (upper + lower) / 2 });
    }
  }

  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function buildRateEvents(rateRows) {
  const events = [];
  let previous;

  for (const row of rateRows) {
    if (row.date < "1990-01-01") {
      previous = row;
      continue;
    }
    if (!previous) {
      previous = row;
      continue;
    }

    const previousTarget = previous.target;
    const target = row.target;
    const targetChanged = Math.abs(target - previousTarget) > 0.0001;
    const rangeChanged =
      Number.isFinite(previous.upper) &&
      Number.isFinite(row.upper) &&
      (Math.abs(row.upper - previous.upper) > 0.0001 ||
        Math.abs(row.lower - previous.lower) > 0.0001);

    if (targetChanged || rangeChanged) {
      const delta = Number((target - previousTarget).toFixed(4));
      events.push({
        id: `fed-${row.date}`,
        date: row.date,
        type: delta < 0 ? "cut" : "hike",
        delta,
        target,
        upper: row.upper ?? null,
        lower: row.lower ?? null,
        sourceLabel: "Federal Reserve target rate",
        sourceUrl: `https://fred.stlouisfed.org/series/${
          Number.isFinite(row.upper) ? "DFEDTARU" : "DFEDTAR"
        }`,
      });
    }

    previous = row;
  }

  return events;
}

function addTradingWindows(marketRows, events) {
  const dates = marketRows.map((row) => row[0]);

  return events.map((event) => {
    const index = lowerBound(dates, event.date);
    const eventIndex = index < dates.length && dates[index] === event.date ? index : index - 1;
    const before = eventIndex > 0 ? eventIndex - 1 : null;

    return {
      ...event,
      tradingDate: dates[Math.max(0, eventIndex)] ?? event.date,
      window: {
        pre5: returnBetween(marketRows, Math.max(0, eventIndex - 5), eventIndex),
        pre10: returnBetween(marketRows, Math.max(0, eventIndex - 10), eventIndex),
        pre20: returnBetween(marketRows, Math.max(0, eventIndex - 20), eventIndex),
        d1: returnBetween(marketRows, before, eventIndex),
        d5: returnBetween(marketRows, eventIndex, Math.min(dates.length - 1, eventIndex + 5)),
        d20: returnBetween(marketRows, eventIndex, Math.min(dates.length - 1, eventIndex + 20)),
      },
    };
  });
}

function lowerBound(values, target) {
  let low = 0;
  let high = values.length;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle] < target) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  return low;
}

function returnBetween(rows, startIndex, endIndex) {
  if (
    startIndex === null ||
    endIndex === null ||
    startIndex < 0 ||
    endIndex < 0 ||
    startIndex >= rows.length ||
    endIndex >= rows.length ||
    startIndex === endIndex
  ) {
    return null;
  }

  const start = rows[startIndex][1];
  const end = rows[endIndex][1];
  return Number((((end - start) / start) * 100).toFixed(2));
}

function buildConflictWindows(marketRows, conflicts) {
  return conflicts.map((event) => {
    const index = lowerBound(
      marketRows.map((row) => row[0]),
      event.date,
    );
    const eventIndex = index < marketRows.length ? index : marketRows.length - 1;

    return {
      ...event,
      type: "conflict",
      tradingDate: marketRows[eventIndex]?.[0] ?? event.date,
      window: {
        pre5: returnBetween(marketRows, Math.max(0, eventIndex - 5), eventIndex),
        pre10: returnBetween(marketRows, Math.max(0, eventIndex - 10), eventIndex),
        pre20: returnBetween(marketRows, Math.max(0, eventIndex - 20), eventIndex),
        d1:
          eventIndex > 0
            ? returnBetween(marketRows, eventIndex - 1, eventIndex)
            : null,
        d5: returnBetween(
          marketRows,
          eventIndex,
          Math.min(marketRows.length - 1, eventIndex + 5),
        ),
        d20: returnBetween(
          marketRows,
          eventIndex,
          Math.min(marketRows.length - 1, eventIndex + 20),
        ),
      },
    };
  });
}

function compareSeries(primaryRows, referenceRows) {
  const reference = new Map(referenceRows.map((row) => [row.date, row.value]));
  const differences = primaryRows
    .filter((row) => reference.has(row.date))
    .map((row) => {
      const base = reference.get(row.date);
      return base === 0 ? 0 : Math.abs((row.value - base) / base) * 100;
    });

  if (differences.length === 0) {
    return null;
  }

  return {
    points: differences.length,
    meanAbsPercent: Number(
      (differences.reduce((sum, value) => sum + value, 0) / differences.length).toFixed(4),
    ),
    maxAbsPercent: Number(Math.max(...differences).toFixed(4)),
  };
}

async function optionalStooq(symbol, label) {
  try {
    const rows = await fetchStooqSeries(symbol);
    console.log(`${label}: loaded ${rows.length} rows from Stooq`);
    return rows;
  } catch (error) {
    console.warn(`${label}: Stooq unavailable (${error.message})`);
    return [];
  }
}

async function main() {
  console.log(`Refreshing market data through ${endDate}`);
  let previousSnapshot = {};
  try {
    previousSnapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  } catch {
    previousSnapshot = {};
  }
  const [
    fredSp500,
    fredNasdaq100,
    fredTarget,
    fredUpper,
    fredLower,
    stooqSp500,
    eastmoneySp500,
    eastmoneyNasdaq100,
    tencentSp500,
    tencentNasdaq100,
    fredBrent,
    sinaBrent,
    sinaGold,
    shanghai,
    chinext,
    csi300,
    newsItems,
  ] = await Promise.all([
      safeFetch("FRED SP500", () => fetchFredWithRetry("SP500")),
      safeFetch("FRED NASDAQ100", () => fetchFredWithRetry("NASDAQ100")),
      safeFetch("FRED DFEDTAR", () => fetchFredWithRetry("DFEDTAR")),
      safeFetch("FRED DFEDTARU", () => fetchFredWithRetry("DFEDTARU")),
      safeFetch("FRED DFEDTARL", () => fetchFredWithRetry("DFEDTARL")),
      optionalStooq("^spx", "S&P 500"),
      optionalEastmoney("100.SPX", "S&P 500"),
      optionalEastmoney("100.NDX", "Nasdaq-100"),
      optionalTencent("usINX", "S&P 500", 1982),
      optionalTencent("usNDX", "Nasdaq-100", 1985),
      withPreviousMarket(
        "brent",
        () => fetchFredWithRetry("DCOILBRENTEU"),
        "Brent",
      ),
      optionalSina("OIL", "Brent OHLC"),
      withPreviousMarket("gold", () => optionalSina("XAU", "Gold"), "Gold"),
      withPreviousMarket(
        "shanghai",
        () => optionalTencentChina("sh000001", "Shanghai Composite", 1990),
        "Shanghai Composite",
      ),
      withPreviousMarket(
        "chinext",
        () => optionalTencentChina("sz399006", "ChiNext", 2010),
        "ChiNext",
      ),
      withPreviousMarket(
        "csi300",
        () => optionalTencentChina("sh000300", "CSI 300", 2005),
        "CSI 300",
      ),
      fetchNewsItems(),
    ]);

  const sp500Candidates = [
    { source: "Tencent Finance", rows: tencentSp500 },
    { source: "Stooq", rows: stooqSp500 },
    { source: "Eastmoney", rows: eastmoneySp500 },
    { source: "FRED recent history only", rows: fredSp500 },
  ].sort((a, b) => b.rows.length - a.rows.length);
  const primarySp500 = sp500Candidates[0];
  const sp500Source = mergeOhlcWithClose(primarySp500.rows, fredSp500);
  const nasdaq100Candidates = [
    { source: "Tencent Finance", rows: tencentNasdaq100 },
    { source: "Eastmoney", rows: eastmoneyNasdaq100 },
  ];
  const primaryNasdaq100 =
    nasdaq100Candidates.find((candidate) => candidate.rows.length > 0) ?? {
      source: "FRED NASDAQ100",
      rows: fredNasdaq100,
    };
  const nasdaq100Source =
    primaryNasdaq100.source === "FRED NASDAQ100"
      ? fredNasdaq100
      : mergeOhlcWithClose(primaryNasdaq100.rows, fredNasdaq100);
  const nasdaq100 = nasdaq100Source.filter((row) => row.date >= "1985-01-01");
  const sp500 = sp500Source.filter((row) => row.date >= "1982-01-01");
  const brent = mergeOhlcWithClose(sinaBrent, fredBrent).filter(
    (row) => row.date >= "1987-01-01",
  );
  const gold = sinaGold.filter((row) => row.date >= "2006-01-01");
  const rateRows = combineTargetRate(fredTarget, fredUpper, fredLower);
  const freshRateEvents = buildRateEvents(rateRows);
  const baseRateEvents =
    freshRateEvents.length > 0
      ? freshRateEvents
      : previousSnapshot.rateEvents ?? [];
  const sp500Points = compactMarketPoints(sp500);
  const nasdaq100Points = compactMarketPoints(nasdaq100);
  const brentPoints = compactMarketPoints(brent);
  const goldPoints = compactMarketPoints(gold);
  const shanghaiPoints = compactMarketPoints(shanghai);
  const chinextPoints = compactMarketPoints(chinext);
  const csi300Points = compactMarketPoints(csi300);
  const rateEventsSp500 = addTradingWindows(
    sp500Points,
    baseRateEvents,
  );
  const rateEventsNasdaq100 = addTradingWindows(
    nasdaq100Points,
    baseRateEvents,
  );
  const rateEventsBrent = addTradingWindows(
    brentPoints,
    baseRateEvents,
  );
  const rateEventsGold = addTradingWindows(
    goldPoints,
    baseRateEvents,
  );
  const rateEvents = rateEventsSp500.map((event, index) => ({
    ...event,
    windows: {
      sp500: event.window,
      nasdaq100: rateEventsNasdaq100[index]?.window ?? null,
      brent: rateEventsBrent[index]?.window ?? null,
      gold: rateEventsGold[index]?.window ?? null,
    },
  }));
  const conflicts = JSON.parse(await readFile(conflictsPath, "utf8"));
  const health = JSON.parse(await readFile(healthEventsPath, "utf8"));
  const financial = JSON.parse(await readFile(financialEventsPath, "utf8"));
  const conflictWindowsSp500 = buildConflictWindows(
    sp500Points,
    conflicts.events,
  );
  const conflictWindowsNasdaq100 = buildConflictWindows(
    nasdaq100Points,
    conflicts.events,
  );
  const conflictWindowsBrent = buildConflictWindows(
    brentPoints,
    conflicts.events,
  );
  const conflictWindowsGold = buildConflictWindows(
    goldPoints,
    conflicts.events,
  );
  const conflictWindows = conflictWindowsSp500.map((event, index) => ({
    ...event,
    windows: {
      sp500: event.window,
      nasdaq100: conflictWindowsNasdaq100[index]?.window ?? null,
      brent: conflictWindowsBrent[index]?.window ?? null,
      gold: conflictWindowsGold[index]?.window ?? null,
    },
  }));
  const healthWindowsSp500 = buildConflictWindows(
    sp500Points,
    health.events,
  ).map((event) => ({ ...event, type: "health" }));
  const healthWindowsNasdaq100 = buildConflictWindows(
    nasdaq100Points,
    health.events,
  ).map((event) => ({ ...event, type: "health" }));
  const healthWindowsBrent = buildConflictWindows(
    brentPoints,
    health.events,
  ).map((event) => ({ ...event, type: "health" }));
  const healthWindowsGold = buildConflictWindows(
    goldPoints,
    health.events,
  ).map((event) => ({ ...event, type: "health" }));
  const healthEvents = healthWindowsSp500.map((event, index) => ({
    ...event,
    windows: {
      sp500: event.window,
      nasdaq100: healthWindowsNasdaq100[index]?.window ?? null,
      brent: healthWindowsBrent[index]?.window ?? null,
      gold: healthWindowsGold[index]?.window ?? null,
    },
  }));
  const financialWindowsSp500 = buildConflictWindows(
    sp500Points,
    financial.events,
  ).map((event) => ({ ...event, type: "financial" }));
  const financialWindowsNasdaq100 = buildConflictWindows(
    nasdaq100Points,
    financial.events,
  ).map((event) => ({ ...event, type: "financial" }));
  const financialWindowsBrent = buildConflictWindows(
    brentPoints,
    financial.events,
  ).map((event) => ({ ...event, type: "financial" }));
  const financialWindowsGold = buildConflictWindows(
    goldPoints,
    financial.events,
  ).map((event) => ({ ...event, type: "financial" }));
  const financialEvents = financialWindowsSp500.map((event, index) => ({
    ...event,
    windows: {
      sp500: event.window,
      nasdaq100: financialWindowsNasdaq100[index]?.window ?? null,
      brent: financialWindowsBrent[index]?.window ?? null,
      gold: financialWindowsGold[index]?.window ?? null,
    },
  }));

  const payload = {
    meta: {
      generatedAt: new Date().toISOString(),
      newsUpdatedAt: new Date().toISOString(),
      newsRefreshMinutes: 15,
      through:
        [
          sp500Points.at(-1)?.[0],
          nasdaq100Points.at(-1)?.[0],
          brentPoints.at(-1)?.[0],
          goldPoints.at(-1)?.[0],
          shanghaiPoints.at(-1)?.[0],
          chinextPoints.at(-1)?.[0],
          csi300Points.at(-1)?.[0],
        ]
          .filter(Boolean)
          .sort()
          .at(-1) ?? endDate,
      requestedThrough: endDate,
      start:
        [sp500Points[0]?.[0], brentPoints[0]?.[0], goldPoints[0]?.[0]]
          .filter(Boolean)
          .sort()[0] ?? startDate,
      sources: {
        sp500: `${primarySp500.source} primary, FRED fallback`,
        nasdaq100: `${primaryNasdaq100.source} primary, FRED fallback`,
        brent: "FRED DCOILBRENTEU / US EIA",
        gold: "Sina Finance XAU / London spot gold",
        china: "Tencent Finance daily index data",
        fed: "FRED DFEDTAR / DFEDTARU / DFEDTARL",
        conflicts: "Curated reviewed conflict milestones",
      },
      validation: {
        sp500VsFred: compareSeries(primarySp500.rows, fredSp500),
        nasdaq100VsFred: compareSeries(primaryNasdaq100.rows, fredNasdaq100),
      },
      definitions: conflicts.definitions,
      healthDefinitions: health.definitions,
      financialDefinitions: financial.definitions,
    },
    markets: {
      sp500: sp500Points,
      nasdaq100: nasdaq100Points,
      brent: brentPoints,
      gold: goldPoints,
      shanghai: shanghaiPoints,
      chinext: chinextPoints,
      csi300: csi300Points,
    },
    rateEvents,
    conflicts: conflictWindows,
    healthEvents,
    financialEvents,
    news: newsItems.map(({ score, ...item }) => item),
  };

  await mkdir(snapshotDir, { recursive: true });
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeAtomic(snapshotPath, `${JSON.stringify(payload, null, 2)}\n`);
  await writeAtomic(
    outputPath,
    `window.MARKET_EVENT_DATA = ${JSON.stringify(payload)};\n`,
  );

  console.log(
    `Wrote ${sp500.length} S&P 500 rows, ${nasdaq100.length} Nasdaq-100 rows, ` +
      `${brent.length} Brent rows, ${gold.length} gold rows, ` +
      `${shanghai.length} Shanghai rows, ${chinext.length} ChiNext rows, ` +
      `${csi300.length} CSI 300 rows, ${newsItems.length} news items, ` +
      `${rateEvents.length} rate changes, ${conflictWindows.length} conflict milestones, ` +
      `${healthEvents.length} public-health milestones, and ` +
      `${financialEvents.length} financial-risk milestones.`,
  );
}

export { fetchNewsItems, rankNewsItems };

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
