(() => {
  "use strict";

  const DATA = window.MARKET_EVENT_DATA;
  const colors = {};

  const rangeStarts = {
    all: "1980-01-01",
    "1990": "1990-01-01",
    "2000": "2000-01-01",
    "2008": "2008-01-01",
    "2020": "2020-01-01",
    "2022": "2022-01-01",
    "2025": "2025-01-01",
  };

  const regionLabels = {
    Africa: "非洲",
    Asia: "亚洲",
    Caucasus: "高加索",
    Europe: "欧洲",
    Global: "全球",
    "Middle East": "中东",
    "United States": "美国",
  };

  const scopeLabels = {
    "Civil and interstate war": "内战与国家间战争",
    "Civil war": "内战",
    "Civil war and genocide": "内战与大屠杀",
    "Interstate and civil war": "国家间战争与内战",
    "Interstate war": "国家间战争",
    "Regional armed conflict": "地区武装冲突",
    Epidemic: "重大疫情",
    Pandemic: "全球大流行",
    "Global health emergency": "全球卫生紧急事件",
    "Asset bubble": "资产泡沫",
    "Currency and banking crisis": "货币与银行危机",
    "Real-estate and credit crisis": "房地产与信用危机",
    "Systemic financial crisis": "系统性金融危机",
    "Sovereign debt crisis": "主权债务危机",
    "Banking crisis": "银行业危机",
  };

  const state = {
    range: "1990",
    customRange: null,
    chartRanges: new Map(),
    types: new Set(["hike", "cut", "conflict", "health", "financial"]),
    query: "",
    hover: new Map(),
    viewport: new Map(),
    drag: new Map(),
  };

  const marketConfig = {
    sp500: {
      prefix: "sp500",
      summaryKey: "sp500",
      label: "标普500",
      canvas: document.querySelector("#sp500-chart"),
      color: "sp500",
      digits: 2,
      rebase: true,
      rows: DATA.markets.sp500.map(toMarketPoint),
    },
    nasdaq100: {
      prefix: "nasdaq",
      summaryKey: "nasdaq",
      label: "纳斯达克100",
      canvas: document.querySelector("#nasdaq-chart"),
      color: "nasdaq",
      digits: 2,
      rebase: true,
      rows: DATA.markets.nasdaq100.map(toMarketPoint),
    },
    brent: {
      prefix: "brent",
      summaryKey: "brent",
      label: "布伦特原油",
      canvas: document.querySelector("#brent-chart"),
      color: "brent",
      digits: 2,
      unit: "美元/桶",
      rebase: false,
      rows: DATA.markets.brent.map(toMarketPoint),
    },
    gold: {
      prefix: "gold",
      summaryKey: "gold",
      label: "黄金现货",
      canvas: document.querySelector("#gold-chart"),
      color: "gold",
      digits: 2,
      unit: "美元/盎司",
      rebase: false,
      rows: DATA.markets.gold.map(toMarketPoint),
    },
  };

  const chinaConfig = {
    label: "中国主要股指",
    canvas: document.querySelector("#china-chart"),
    series: [
      {
        label: "上证指数",
        summaryKey: "shanghai",
        color: "shanghai",
        rows: DATA.markets.shanghai.map(toMarketPoint),
      },
      {
        label: "创业板指",
        summaryKey: "chinext",
        color: "chinext",
        rows: DATA.markets.chinext.map(toMarketPoint),
      },
      {
        label: "沪深300",
        summaryKey: "csi300",
        color: "csi300",
        rows: DATA.markets.csi300.map(toMarketPoint),
      },
    ],
  };
  const allChartConfigs = { ...marketConfig, china: chinaConfig };

  const canvasState = new WeakMap();
  const allEvents = [
    ...DATA.rateEvents,
    ...DATA.conflicts,
    ...(DATA.healthEvents ?? []),
    ...(DATA.financialEvents ?? []),
  ].sort((a, b) => b.date.localeCompare(a.date));

  function toMarketPoint(row) {
    return {
      date: row[0],
      value: row[1],
      open: row[2],
      high: row[3],
      low: row[4],
      hasOhlc: row.length >= 6 ? row[5] === 1 : row[2] !== undefined,
    };
  }

  function readThemeColors() {
    const styles = getComputedStyle(document.documentElement);
    for (const name of [
      "text",
      "text-muted",
      "border",
      "border-strong",
      "sp500",
      "nasdaq",
      "brent",
      "gold",
      "shanghai",
      "chinext",
      "csi300",
      "hike",
      "cut",
      "conflict",
      "health",
      "financial",
      "surface",
      "surface-soft",
      "positive",
      "negative",
      "history-line",
    ]) {
      colors[name] = styles.getPropertyValue(`--${name}`).trim();
    }
  }

  function formatNumber(value, digits = 2) {
    if (!Number.isFinite(value)) {
      return "--";
    }
    return new Intl.NumberFormat("zh-CN", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value);
  }

  function formatPercent(value, digits = 2) {
    if (!Number.isFinite(value)) {
      return "--";
    }
    return `${value > 0 ? "+" : ""}${value.toFixed(digits)}%`;
  }

  function classForPercent(value) {
    if (!Number.isFinite(value)) {
      return "";
    }
    return value > 0 ? "positive" : value < 0 ? "negative" : "";
  }

  function formatDate(date) {
    const [year, month, day] = date.split("-");
    return `${year}.${month}.${day}`;
  }

  function humanDate(date) {
    const [year, month, day] = date.split("-");
    return `${year}年${Number(month)}月${Number(day)}日`;
  }

  function latestPoint(rows) {
    return rows.at(-1);
  }

  function changeFromPrevious(rows) {
    if (rows.length < 2) {
      return null;
    }
    const latest = rows.at(-1);
    const previous = rows.at(-2);
    return ((latest.value - previous.value) / previous.value) * 100;
  }

  function getRangeBounds() {
    if (state.customRange) {
      return {
        start: `${state.customRange.start}-01`,
        end:
          state.customRange.end >= DATA.meta.through.slice(0, 7)
            ? DATA.meta.through
            : monthEndDate(state.customRange.end),
      };
    }
    const requestedStart = rangeStarts[state.range];
    const marketStart = DATA.meta.start;
    const marketEnd = DATA.meta.through;
    return {
      start: requestedStart > marketStart ? requestedStart : marketStart,
      end: marketEnd,
    };
  }

  function monthEndDate(month) {
    const [year, monthNumber] = month.split("-").map(Number);
    return new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
  }

  function getChartBounds(chartKey) {
    const range = state.chartRanges.get(chartKey);
    if (!range) {
      return getRangeBounds();
    }
    return {
      start: `${range.start}-01`,
      end:
        range.end >= DATA.meta.through.slice(0, 7)
          ? DATA.meta.through
          : monthEndDate(range.end),
    };
  }

  function setAllChartRanges(startMonth, endMonth) {
    for (const key of Object.keys(allChartConfigs)) {
      const earliest = earliestMonthForChart(key);
      const start = startMonth < earliest ? earliest : startMonth;
      const end = endMonth < start ? start : endMonth;
      state.chartRanges.set(key, { start, end });
    }
    syncAllRangePickers();
  }

  function earliestMonthForChart(chartKey) {
    const config = allChartConfigs[chartKey];
    const firstDate = config.series
      ? Math.min(
          ...config.series.map((series) =>
            new Date(`${series.rows[0].date}T00:00:00Z`).getTime(),
          ),
        )
      : new Date(`${config.rows[0].date}T00:00:00Z`).getTime();
    return new Date(firstDate).toISOString().slice(0, 7);
  }

  function eventTypeLabel(event) {
    if (event.type === "hike") {
      return "加息";
    }
    if (event.type === "cut") {
      return "降息";
    }
    if (event.type === "health") {
      return "公共卫生";
    }
    if (event.type === "financial") {
      return "金融风险";
    }
    return "重大冲突";
  }

  function eventTitle(event) {
    if (event.type === "hike" || event.type === "cut") {
      const basisPoints = Math.abs(event.delta) * 100;
      const formatted = Number.isInteger(basisPoints)
        ? String(basisPoints)
        : basisPoints.toFixed(1);
      return `美联储${event.type === "hike" ? "加息" : "降息"} ${formatted} 个基点`;
    }
    return `${event.titleZh ?? event.title} / ${event.titleEn ?? event.title}`;
  }

  function eventTitleMarkup(event) {
    if (event.type === "hike" || event.type === "cut") {
      return `<span class="event-title-zh">${escapeHtml(eventTitle(event))}</span>`;
    }
    return `
      <span class="event-title-zh">${escapeHtml(event.titleZh ?? event.title)}</span>
      <span class="event-title-en">${escapeHtml(event.titleEn ?? event.title)}</span>
    `;
  }

  function eventDetail(event) {
    if (event.type === "hike" || event.type === "cut") {
      const target = Number.isFinite(event.upper)
        ? `${formatNumber(event.lower)}% 至 ${formatNumber(event.upper)}%`
        : `${formatNumber(event.target)}%`;
      return `目标利率生效为 ${target}`;
    }
    const region = regionLabels[event.region] ?? event.region;
    const scope = scopeLabels[event.scope] ?? event.scope;
    return `${region} · ${scope}`;
  }

  function eventSourceLabel(event) {
    const shortLabels = {
      "Federal Reserve target rate": "美联储利率",
      "China News Service": "中国新闻网",
      "UN news": "联合国新闻",
      "UN report": "联合国报告",
      "UCDP conflict data": "UCDP冲突数据",
      WHO: "世界卫生组织",
      "Bank of Japan": "日本央行",
      "Federal Reserve History": "美联储历史",
      "IMF GFSR": "IMF金融稳定报告",
      "US Treasury": "美国财政部",
      FDIC: "美国FDIC",
      IMF: "国际货币基金组织",
    };
    return shortLabels[event.sourceLabel] ?? event.sourceLabel;
  }

  function filteredEvents() {
    const { start, end } = getRangeBounds();
    const query = state.query.trim().toLowerCase();
    return allEvents.filter((event) => {
      if (!state.types.has(event.type)) {
        return false;
      }
      if (event.date < start || event.date > end) {
        return false;
      }
      if (!query) {
        return true;
      }
      const haystack = [
        event.date,
        event.type,
        event.title,
        event.titleZh,
        event.titleEn,
        event.detail,
        event.region,
        event.scope,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  }

  function visibleRows(config, start, end) {
    return config.rows.filter((row) => row.date >= start && row.date <= end);
  }

  function nearestIndex(rows, date) {
    let low = 0;
    let high = rows.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (rows[middle].date <= date) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    return low;
  }

  function nearestValue(rows, date) {
    if (!rows.length) {
      return null;
    }
    const index = nearestIndex(rows, date);
    const candidates = [rows[index], rows[index - 1], rows[index + 1]].filter(Boolean);
    return candidates.reduce((best, row) => {
      const distance = Math.abs(new Date(`${row.date}T00:00:00Z`) - new Date(`${date}T00:00:00Z`));
      return !best || distance < best.distance ? { row, distance } : best;
    }, null)?.row ?? null;
  }

  function updateRangeSummary(config, start, end) {
    const rows = visibleRows(config, start, end);
    return {
      rows,
      change:
        rows.length > 1
          ? ((rows.at(-1).value - rows[0].value) / rows[0].value) * 100
          : null,
    };
  }

  function setPeriodChange(elementId, rows) {
    const element = document.querySelector(`#${elementId}`);
    if (!element) {
      return;
    }
    const change =
      rows.length > 1
        ? ((rows.at(-1).value - rows[0].value) / rows[0].value) * 100
        : null;
    element.textContent = formatPercent(change);
    element.className = classForPercent(change);
  }

  function updateSummary() {
    for (const config of Object.values(marketConfig)) {
      const latest = latestPoint(config.rows);
      const change = changeFromPrevious(config.rows);
      const valueElement = document.querySelector(`#${config.summaryKey}-latest`);
      const changeElement = document.querySelector(`#${config.summaryKey}-change`);
      if (valueElement && latest) {
        valueElement.textContent = formatNumber(latest.value, config.digits);
      }
      if (changeElement && latest) {
        changeElement.textContent = `${formatDate(latest.date)} · ${formatPercent(change)}`;
        changeElement.className = `summary-change ${classForPercent(change)}`;
      }
    }
    const events = filteredEvents();
    const counts = { hike: 0, cut: 0, conflict: 0, health: 0, financial: 0 };
    for (const event of events) {
      counts[event.type] += 1;
    }
    document.querySelector("#event-count").textContent = events.length.toLocaleString("zh-CN");
    document.querySelector("#event-breakdown").textContent =
      `加息 ${counts.hike} · 降息 ${counts.cut} · 冲突 ${counts.conflict} · 卫生 ${counts.health} · 金融 ${counts.financial}`;
    document.querySelector("#table-summary").textContent =
      `${formatDate(getRangeBounds().start)} 至 ${formatDate(getRangeBounds().end)}，共 ${events.length} 个事件`;
  }

  function updateMarketHeadings() {
    for (const [key, config] of Object.entries(marketConfig)) {
      const { start, end } = getChartBounds(key);
      const summary = updateRangeSummary(config, start, end);
      const prefix = config.prefix;
      const assetStart = summary.rows[0]?.date ?? start;
      const assetEnd = summary.rows.at(-1)?.date ?? end;
      const modeLabel = config.rebase ? "相对区间起点 = 100" : config.unit;
      document.querySelector(`#${prefix}-range-label`).textContent =
        `${formatDate(assetStart)} 至 ${formatDate(assetEnd)}${modeLabel ? ` · ${modeLabel}` : ""}`;
      const element = document.querySelector(`#${prefix}-change-large`);
      element.textContent = formatPercent(summary.change);
      element.className = classForPercent(summary.change);
    }
    const {
      start: chinaStart,
      end: chinaEnd,
    } = getChartBounds("china");
    document.querySelector("#china-range-label").textContent =
      `${formatDate(chinaStart)} 至 ${formatDate(chinaEnd)} · 每月刻度 · 三个独立纵轴`;
  }

  function renderEventTable() {
    const tbody = document.querySelector("#event-table-body");
    const events = filteredEvents();
    if (!events.length) {
      tbody.innerHTML = '<tr><td class="empty-row" colspan="8">当前筛选条件下没有事件</td></tr>';
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const event of events) {
      const row = document.createElement("tr");
      const sp500 = event.windows?.sp500 ?? event.window ?? {};
      const nasdaq100 = event.windows?.nasdaq100 ?? {};
      const brent = event.windows?.brent ?? {};
      const gold = event.windows?.gold ?? {};
      row.innerHTML = `
        <td>${formatDate(event.date)}</td>
        <td><span class="event-type ${event.type}">${eventTypeLabel(event)}</span></td>
        <td>
          <span class="event-title">${eventTitleMarkup(event)}</span>
          <span class="event-detail">${escapeHtml(eventDetail(event))}</span>
        </td>
        <td class="numeric">${windowCell(sp500, "标普500")}</td>
        <td class="numeric">${windowCell(nasdaq100, "纳斯达克100")}</td>
        <td class="numeric">${windowCell(brent, "布伦特原油")}</td>
        <td class="numeric">${windowCell(gold, "黄金现货")}</td>
        <td><a class="source-link" href="${escapeAttribute(event.sourceUrl)}" target="_blank" rel="noreferrer">${escapeHtml(eventSourceLabel(event))}</a></td>
      `;
      fragment.append(row);
    }
    tbody.replaceChildren(fragment);
  }

  function windowCell(values, label) {
    return `
      <div class="window-matrix">
        <span class="window-asset">${escapeHtml(label)}</span>
        <div class="window-column">
          <span class="window-side">事件前</span>
          <div class="window-row"><span>5日</span><b class="${classForPercent(values?.pre5)}">${formatPercent(values?.pre5)}</b></div>
          <div class="window-row"><span>10日</span><b class="${classForPercent(values?.pre10)}">${formatPercent(values?.pre10)}</b></div>
          <div class="window-row"><span>20日</span><b class="${classForPercent(values?.pre20)}">${formatPercent(values?.pre20)}</b></div>
        </div>
        <div class="window-column">
          <span class="window-side">事件后</span>
          <div class="window-row"><span>1日</span><b class="${classForPercent(values?.d1)}">${formatPercent(values?.d1)}</b></div>
          <div class="window-row"><span>5日</span><b class="${classForPercent(values?.d5)}">${formatPercent(values?.d5)}</b></div>
          <div class="window-row"><span>20日</span><b class="${classForPercent(values?.d20)}">${formatPercent(values?.d20)}</b></div>
        </div>
      </div>
    `;
  }

  function renderSidebarNews() {
    const track = document.querySelector("#sidebar-news-track");
    const news = Array.isArray(DATA.news) ? DATA.news : [];
    if (!news.length) {
      track.innerHTML =
        '<div class="news-item"><span class="news-title">暂无新闻数据</span></div>';
      document.querySelector("#sidebar-news-time").textContent =
        "等待下一次数据更新";
      return;
    }

    const itemMarkup = (item) => {
      const published = new Date(item.publishedAt);
      const date = Number.isFinite(published.getTime())
        ? `${String(published.getMonth() + 1).padStart(2, "0")}-${String(
            published.getDate(),
          ).padStart(2, "0")}`
        : item.dataDate?.slice(0, 7) ?? "";
      return `
        <a class="news-item" href="${escapeAttribute(item.url)}" target="_blank" rel="noreferrer">
          <span class="news-meta">
            <span class="news-category">${escapeHtml(item.category)}</span>
            <span class="news-date">${escapeHtml(item.source)} · ${escapeHtml(date)}</span>
          </span>
          <span class="news-title">${escapeHtml(item.title)}</span>
        </a>
      `;
    };

    track.innerHTML = [...news, ...news].map(itemMarkup).join("");
    track.style.setProperty(
      "--news-duration",
      `${Math.max(42, news.length * 5.5)}s`,
    );
    document.querySelector("#sidebar-news-time").textContent =
      `新闻更新于 ${new Date(
        DATA.meta.newsUpdatedAt ?? DATA.meta.generatedAt,
      ).toLocaleString("zh-CN", {
        hour12: false,
      })}`;
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function escapeAttribute(value) {
    return escapeHtml(value);
  }

  function setupCanvas(canvas, marketKey) {
    const context = canvas.getContext("2d");
    const wrapper = canvas.parentElement;
    const chartTooltip = wrapper.querySelector(".chart-tooltip");
    const chartState = {
      context,
      wrapper,
      chartTooltip,
      layout: null,
      pinch: null,
    };
    canvasState.set(canvas, chartState);
    const observer = new ResizeObserver(() => {
      requestAnimationFrame(() => drawChart(marketKey));
    });
    observer.observe(wrapper);

    canvas.addEventListener("pointermove", (event) => {
      if (chartState.pinch) {
        return;
      }
      if (state.drag.has(marketKey)) {
        panChart(marketKey, event);
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      state.hover.set(marketKey, x);
      drawChart(marketKey);
    });
    canvas.addEventListener("pointerdown", (event) => {
      if (chartState.pinch) {
        return;
      }
      if (event.button !== 0) {
        return;
      }
      const chart = canvasState.get(canvas);
      const layout = chart?.layout;
      if (!layout) {
        return;
      }
      state.drag.set(marketKey, {
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        startX: event.clientX,
        startIndex: layout.startIndex,
        endIndex: layout.endIndex,
        plotWidth: layout.plotWidth,
        moved: false,
      });
      try {
        canvas.setPointerCapture?.(event.pointerId);
      } catch {
        // Synthetic pointer events do not own a browser pointer capture.
      }
      canvas.classList.add("is-panning");
    });
    canvas.addEventListener("pointerup", (event) => {
      const drag = state.drag.get(marketKey);
      if (drag && !drag.moved && drag.pointerType !== "mouse") {
        const layout = canvasState.get(canvas)?.layout;
        if (layout) {
          const rect = canvas.getBoundingClientRect();
          const x = Math.max(
            layout.margin.left,
            Math.min(
              layout.margin.left + layout.plotWidth,
              event.clientX - rect.left,
            ),
          );
          state.hover.set(marketKey, x);
          drawChart(marketKey);
        }
      }
      state.drag.delete(marketKey);
      try {
        canvas.releasePointerCapture?.(event.pointerId);
      } catch {
        // Ignore pointers that were not captured.
      }
      canvas.classList.remove("is-panning");
    });
    canvas.addEventListener("pointercancel", () => {
      state.drag.delete(marketKey);
      canvas.classList.remove("is-panning");
    });
    canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      zoomChart(marketKey, event);
    }, { passive: false });
    canvas.addEventListener("dblclick", () => {
      resetChartViewport(marketKey);
    });
    canvas.addEventListener("touchstart", (event) => {
      if (event.touches.length !== 2 || !chartState.layout) {
        return;
      }
      const first = event.touches[0];
      const second = event.touches[1];
      const distance = Math.hypot(
        first.clientX - second.clientX,
        first.clientY - second.clientY,
      );
      chartState.pinch = {
        distance,
        startIndex: chartState.layout.startIndex,
        endIndex: chartState.layout.endIndex,
      };
      state.drag.delete(marketKey);
      event.preventDefault();
    }, { passive: false });
    canvas.addEventListener("touchmove", (event) => {
      if (event.touches.length !== 2 || !chartState.pinch) {
        return;
      }
      const layout = chartState.layout;
      const first = event.touches[0];
      const second = event.touches[1];
      const distance = Math.hypot(
        first.clientX - second.clientX,
        first.clientY - second.clientY,
      );
      const startSpan =
        chartState.pinch.endIndex - chartState.pinch.startIndex;
      const nextSpan = Math.max(
        Math.min(20, layout.baseRows.length - 1),
        Math.min(
          layout.baseRows.length - 1,
          Math.round(
            startSpan * (chartState.pinch.distance / Math.max(1, distance)),
          ),
        ),
      );
      const midpoint = (first.clientX + second.clientX) / 2;
      const rect = canvas.getBoundingClientRect();
      const ratio = Math.max(
        0,
        Math.min(
          1,
          (midpoint - rect.left - layout.margin.left) / layout.plotWidth,
        ),
      );
      const anchorIndex =
        chartState.pinch.startIndex +
        ratio * (chartState.pinch.endIndex - chartState.pinch.startIndex);
      let nextStart = Math.round(anchorIndex - ratio * nextSpan);
      nextStart = Math.max(
        0,
        Math.min(layout.baseRows.length - 1 - nextSpan, nextStart),
      );
      state.viewport.set(marketKey, {
        start: nextStart,
        end: nextStart + nextSpan,
      });
      drawChart(marketKey);
      event.preventDefault();
    }, { passive: false });
    canvas.addEventListener("touchend", (event) => {
      if (event.touches.length < 2) {
        chartState.pinch = null;
      }
    });
    canvas.addEventListener("pointerleave", (event) => {
      if (state.drag.has(marketKey)) {
        return;
      }
      if (event.pointerType === "touch") {
        return;
      }
      state.hover.delete(marketKey);
      chartTooltip.hidden = true;
      drawChart(marketKey);
    });

  }

  function drawChart(marketKey) {
    if (marketKey === "china") {
      drawChinaChart();
      return;
    }
    const config = marketConfig[marketKey];
    const canvas = config.canvas;
    const chart = canvasState.get(canvas);
    if (!chart) {
      return;
    }
    const { context, wrapper, chartTooltip } = chart;
    const rect = wrapper.getBoundingClientRect();
    const width = Math.max(320, rect.width);
    const height = Math.max(240, rect.height);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);

    const { start, end } = getChartBounds(marketKey);
    const baseRows = visibleRows(config, start, end);
    const viewport = getViewportRows(marketKey, baseRows);
    const rows = viewport.rows;
    if (rows.length < 2) {
      chartTooltip.hidden = true;
      return;
    }
    setPeriodChange(`${config.prefix}-change-large`, rows);
    updateChartRangeLabel(config, rows);

    const margin = {
      top: 18,
      right: width < 560 ? 28 : 36,
      bottom: 120,
      left: width < 560 ? 58 : 72,
    };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const startTime = new Date(`${rows[0].date}T00:00:00Z`).getTime();
    const endTime = new Date(`${rows.at(-1).date}T00:00:00Z`).getTime();
    const timeSpan = Math.max(1, endTime - startTime);
    const xScale = (date) => {
      const time = new Date(`${date}T00:00:00Z`).getTime();
      return margin.left + ((time - startTime) / timeSpan) * plotWidth;
    };
    const rebaseBase = config.rebase ? rows[0].value : null;
    const toChartValue = (value) =>
      Number.isFinite(value) && rebaseBase ? (value / rebaseBase) * 100 : value;
    const comparisonSeries = buildComparisonSeries(
      config,
      rows[0].date,
      rows.at(-1).date,
    );
    const values = rows.flatMap((row) =>
      [row.value, row.open, row.high, row.low]
        .filter(Number.isFinite)
        .map(toChartValue),
    );
    let minValue = Math.min(...values);
    let maxValue = Math.max(...values);
    const valuePadding = (maxValue - minValue || maxValue * 0.08) * 0.08;
    minValue = Math.max(0, minValue - valuePadding);
    maxValue += valuePadding;
    const yScale = (value) =>
      margin.top + plotHeight - ((value - minValue) / (maxValue - minValue)) * plotHeight;
    let comparisonYScale = null;
    if (comparisonSeries.length) {
      const comparisonValues = comparisonSeries.flatMap((series) => series.values);
      let comparisonMin = Math.min(...comparisonValues);
      let comparisonMax = Math.max(...comparisonValues);
      const comparisonPadding =
        (comparisonMax - comparisonMin || comparisonMax * 0.08) * 0.06;
      comparisonMin -= comparisonPadding;
      comparisonMax += comparisonPadding;
      const logMin = Math.log10(Math.max(1, comparisonMin));
      const logMax = Math.log10(Math.max(1, comparisonMax));
      comparisonYScale = (value) =>
        margin.top +
        plotHeight -
        ((Math.log10(Math.max(1, value)) - logMin) / (logMax - logMin)) *
          plotHeight;
    }

    drawGrid(context, rows, xScale, yScale, margin, plotWidth, plotHeight, minValue, maxValue);
    if (comparisonYScale) {
      drawComparisonAxis(
        context,
        comparisonYScale,
        margin,
        plotWidth,
        plotHeight,
        comparisonSeries,
      );
    }
    drawPrimarySeries(context, config, rows, xScale, yScale, toChartValue, plotWidth);
    drawComparisonLines(
      context,
      comparisonSeries,
      xScale,
      comparisonYScale,
      plotWidth,
    );

    const events = filteredEvents();
    const visibleEvents = events.filter(
      (event) => event.date >= rows[0].date && event.date <= rows.at(-1).date,
    );
    const clusters = clusterEvents(visibleEvents, xScale, width < 560 ? 28 : 22);
    drawEventTimeline(
      context,
      visibleEvents,
      xScale,
      margin,
      plotWidth,
      plotHeight,
      width < 560 ? 28 : 22,
    );

    const hoverX = state.hover.get(marketKey);
    if (Number.isFinite(hoverX) && hoverX >= margin.left && hoverX <= margin.left + plotWidth) {
      const hoverDate = xToDate(
        hoverX,
        margin.left,
        plotWidth,
        rows[0].date,
        rows.at(-1).date,
      );
      const row = nearestValue(rows, hoverDate);
      if (row) {
        const x = xScale(row.date);
        const y = yScale(toChartValue(row.value));
        context.strokeStyle = colors["border-strong"];
        context.globalAlpha = 0.65;
        context.lineWidth = 1;
        context.beginPath();
        context.moveTo(x, margin.top);
        context.lineTo(x, margin.top + plotHeight);
        context.stroke();
        context.globalAlpha = 1;
        context.fillStyle = colors[config.color];
        context.beginPath();
        context.arc(x, y, 3.4, 0, Math.PI * 2);
        context.fill();
        showTooltip(
          chartTooltip,
          wrapper,
          row.date,
          x,
          y,
          clusters,
          hoverX,
          marketKey,
          rows,
          comparisonSeries,
        );
      }
    } else {
      chartTooltip.hidden = true;
    }

    chart.layout = {
      baseRows,
      rows,
      startIndex: viewport.startIndex,
      endIndex: viewport.endIndex,
      margin,
      plotWidth,
      plotHeight,
      xScale,
      yScale,
      toChartValue,
    };
  }

  function getViewportRows(marketKey, baseRows) {
    if (baseRows.length < 2) {
      return { rows: baseRows, startIndex: 0, endIndex: Math.max(0, baseRows.length - 1) };
    }
    const viewport = state.viewport.get(marketKey);
    if (!viewport) {
      return { rows: baseRows, startIndex: 0, endIndex: baseRows.length - 1 };
    }
    const startIndex = Math.max(0, Math.min(viewport.start, baseRows.length - 2));
    const endIndex = Math.max(
      startIndex + 1,
      Math.min(viewport.end, baseRows.length - 1),
    );
    return {
      rows: baseRows.slice(startIndex, endIndex + 1),
      startIndex,
      endIndex,
    };
  }

  function zoomChart(marketKey, event) {
    const canvas = allChartConfigs[marketKey].canvas;
    const chart = canvasState.get(canvas);
    const layout = chart?.layout;
    if (!layout || layout.baseRows.length < 20) {
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const x = Math.max(
      layout.margin.left,
      Math.min(layout.margin.left + layout.plotWidth, event.clientX - rect.left),
    );
    const ratio = (x - layout.margin.left) / layout.plotWidth;
    const span = layout.endIndex - layout.startIndex;
    const nextSpan = Math.max(
      Math.min(20, layout.baseRows.length - 1),
      Math.min(
        layout.baseRows.length - 1,
        Math.round(span * (event.deltaY < 0 ? 0.8 : 1.25)),
      ),
    );
    const anchorIndex = layout.startIndex + ratio * span;
    let nextStart = Math.round(anchorIndex - ratio * nextSpan);
    nextStart = Math.max(
      0,
      Math.min(layout.baseRows.length - 1 - nextSpan, nextStart),
    );
    state.viewport.set(marketKey, {
      start: nextStart,
      end: nextStart + nextSpan,
    });
    drawChart(marketKey);
  }

  function zoomChartBy(marketKey, direction) {
    const canvas = allChartConfigs[marketKey].canvas;
    const chart = canvasState.get(canvas);
    const layout = chart?.layout;
    if (!layout || layout.baseRows.length < 20) {
      return;
    }
    const currentSpan = layout.endIndex - layout.startIndex;
    const factor = direction === "in" ? 0.72 : 1 / 0.72;
    const nextSpan = Math.max(
      Math.min(20, layout.baseRows.length - 1),
      Math.min(
        layout.baseRows.length - 1,
        Math.round(currentSpan * factor),
      ),
    );
    const centerIndex = (layout.startIndex + layout.endIndex) / 2;
    let nextStart = Math.round(centerIndex - nextSpan / 2);
    nextStart = Math.max(
      0,
      Math.min(layout.baseRows.length - 1 - nextSpan, nextStart),
    );
    state.viewport.set(marketKey, {
      start: nextStart,
      end: nextStart + nextSpan,
    });
    drawChart(marketKey);
  }

  function panChart(marketKey, event) {
    const drag = state.drag.get(marketKey);
    const canvas = allChartConfigs[marketKey].canvas;
    const chart = canvasState.get(canvas);
    if (!drag || !chart?.layout) {
      return;
    }
    const deltaX = event.clientX - drag.startX;
    if (Math.abs(deltaX) < 2) {
      return;
    }
    drag.moved = true;
    const span = drag.endIndex - drag.startIndex;
    const indexDelta = Math.round((-deltaX / drag.plotWidth) * span);
    const maxStart = chart.layout.baseRows.length - 1 - span;
    const nextStart = Math.max(0, Math.min(maxStart, drag.startIndex + indexDelta));
    state.viewport.set(marketKey, {
      start: nextStart,
      end: nextStart + span,
    });
    const rect = canvas.getBoundingClientRect();
    const x = Math.max(
      chart.layout.margin.left,
      Math.min(
        chart.layout.margin.left + chart.layout.plotWidth,
        event.clientX - rect.left,
      ),
    );
    state.hover.set(marketKey, x);
    drawChart(marketKey);
  }

  function resetChartViewport(marketKey) {
    state.viewport.delete(marketKey);
    drawChart(marketKey);
  }

  function buildComparisonSeries(config, startDate, endDate) {
    if (!config.comparisons?.length) {
      return [];
    }
    return config.comparisons
      .map((comparison) => {
        const rows = visibleRows(comparison, startDate, endDate);
        if (!rows.length) {
          return null;
        }
        const base = rows[0].value;
        return {
          ...comparison,
          rows,
          base,
          values: rows.map((row) => (row.value / base) * 100),
        };
      })
      .filter(Boolean);
  }

  function drawPrimarySeries(
    context,
    config,
    rows,
    xScale,
    yScale,
    toChartValue,
    plotWidth,
  ) {
    const firstOhlcIndex = rows.findIndex(
      (row) => row.hasOhlc && Number.isFinite(row.open),
    );
    const closeOnlyRows =
      firstOhlcIndex === -1 ? rows : rows.slice(0, firstOhlcIndex);
    const points = downsample(
      closeOnlyRows,
      Math.max(250, Math.floor(plotWidth * 1.5)),
    );
    context.save();
    if (points.length > 1) {
      context.beginPath();
      points.forEach((point, index) => {
        const x = xScale(point.date);
        const y = yScale(toChartValue(point.value));
        if (index === 0) {
          context.moveTo(x, y);
        } else {
          context.lineTo(x, y);
        }
      });
      context.strokeStyle = colors["history-line"];
      context.globalAlpha = 0.7;
      context.lineWidth = 1.1;
      context.setLineDash([4, 3]);
      context.lineJoin = "round";
      context.lineCap = "round";
      context.stroke();
    }
    context.restore();

    const candleRows = aggregateCandles(
      rows,
      Math.max(40, Math.floor(plotWidth / 4)),
    );
    const candleWidth = Math.max(
      1,
      Math.min(8, (plotWidth / candleRows.length) * 0.72),
    );
    for (const row of candleRows) {
      const x = xScale(row.date);
      const open = yScale(toChartValue(row.open));
      const close = yScale(toChartValue(row.value));
      const high = yScale(toChartValue(row.high));
      const low = yScale(toChartValue(row.low));
      const rising = row.value >= row.open;
      const color = rising ? colors.positive : colors.negative;

      context.save();
      context.strokeStyle = color;
      context.fillStyle = color;
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(x, high);
      context.lineTo(x, low);
      context.stroke();

      const top = Math.min(open, close);
      const bodyHeight = Math.max(1, Math.abs(close - open));
      context.fillRect(x - candleWidth / 2, top, candleWidth, bodyHeight);
      context.restore();
    }
  }

  function aggregateCandles(rows, targetCount) {
    if (rows.length <= targetCount) {
      return rows;
    }
    const result = [];
    const bucketSize = rows.length / targetCount;
    for (let bucket = 0; bucket < targetCount; bucket += 1) {
      const start = Math.floor(bucket * bucketSize);
      const end = Math.max(start + 1, Math.floor((bucket + 1) * bucketSize));
      const slice = rows.slice(start, end);
      const withOhlc = slice.filter((row) => row.hasOhlc && Number.isFinite(row.open));
      if (!withOhlc.length) {
        const first = slice[0];
        const last = slice.at(-1);
        result.push({
          date: last.date,
          open: first.value,
          high: Math.max(...slice.map((row) => row.value)),
          low: Math.min(...slice.map((row) => row.value)),
          value: last.value,
          hasOhlc: true,
        });
        continue;
      }
      result.push({
        date: withOhlc.at(-1).date,
        open: withOhlc[0].open,
        high: Math.max(...withOhlc.map((row) => row.high)),
        low: Math.min(...withOhlc.map((row) => row.low)),
        value: withOhlc.at(-1).value,
        hasOhlc: true,
      });
    }
    return result;
  }

  function drawComparisonAxis(
    context,
    yScale,
    margin,
    plotWidth,
    plotHeight,
    seriesList,
  ) {
    const values = seriesList.flatMap((series) => series.values);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const minLog = Math.log10(Math.max(1, min));
    const maxLog = Math.log10(Math.max(1, max));
    context.save();
    context.fillStyle = colors["text-muted"];
    context.font = "11px Segoe UI, Microsoft YaHei UI, sans-serif";
    context.textAlign = "left";
    context.textBaseline = "middle";
    for (let index = 0; index <= 4; index += 1) {
      const value = 10 ** (minLog + ((maxLog - minLog) * index) / 4);
      context.fillText(
        formatAxisValue(value),
        margin.left + plotWidth + 7,
        yScale(value),
      );
    }
    context.textBaseline = "bottom";
    context.fillText(
      "中国指数",
      margin.left + plotWidth + 7,
      margin.top - 3,
    );
    context.restore();
  }

  function drawComparisonLines(context, seriesList, xScale, yScale, plotWidth) {
    if (!yScale) {
      return;
    }
    for (const series of seriesList) {
      const points = downsample(series.rows, Math.max(400, Math.floor(plotWidth * 1.5)));
      context.save();
      context.beginPath();
      points.forEach((point, index) => {
        const x = xScale(point.date);
        const y = yScale((point.value / series.base) * 100);
        if (index === 0) {
          context.moveTo(x, y);
        } else {
          context.lineTo(x, y);
        }
      });
      context.strokeStyle = colors[series.color];
      context.globalAlpha = 0.92;
      context.lineWidth = 1.35;
      context.lineJoin = "round";
      context.lineCap = "round";
      context.stroke();
      context.restore();
    }
  }

  function drawChinaChart() {
    const config = chinaConfig;
    const canvas = config.canvas;
    const chart = canvasState.get(canvas);
    if (!chart) {
      return;
    }
    const { context, wrapper, chartTooltip } = chart;
    const rect = wrapper.getBoundingClientRect();
    const width = Math.max(320, rect.width);
    const height = Math.max(260, rect.height);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);

    const { start, end } = getChartBounds("china");
    const baseRows = [
      ...new Set(
        config.series.flatMap((series) =>
          series.rows
            .filter((row) => row.date >= start && row.date <= end)
            .map((row) => row.date),
        ),
      ),
    ]
      .sort()
      .map((date) => ({ date }));
    const viewport = getViewportRows("china", baseRows);
    const rows = viewport.rows;
    if (rows.length < 2) {
      chartTooltip.hidden = true;
      return;
    }
    document.querySelector("#china-range-label").textContent =
      `${formatDate(rows[0].date)} 至 ${formatDate(rows.at(-1).date)} · 每月刻度 · 三个独立纵轴`;

    const margin = {
      top: 18,
      right: width < 560 ? 28 : 36,
      bottom: 120,
      left: width < 560 ? 58 : 72,
    };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const laneGap = 22;
    const laneHeight = (plotHeight - laneGap * 2) / 3;
    const startTime = new Date(`${rows[0].date}T00:00:00Z`).getTime();
    const endTime = new Date(`${rows.at(-1).date}T00:00:00Z`).getTime();
    const timeSpan = Math.max(1, endTime - startTime);
    const xScale = (date) =>
      margin.left +
      ((new Date(`${date}T00:00:00Z`).getTime() - startTime) / timeSpan) *
        plotWidth;

    const tickDates = chooseDateTicks(rows, margin, plotWidth);
    context.save();
    context.strokeStyle = colors.border;
    context.fillStyle = colors["text-muted"];
    context.font = "11px Segoe UI, Microsoft YaHei UI, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "top";
    for (const date of tickDates) {
      const x = xScale(date);
      context.globalAlpha = 0.35;
      context.beginPath();
      context.moveTo(x, margin.top);
      context.lineTo(x, margin.top + plotHeight);
      context.stroke();
      context.globalAlpha = 1;
      context.fillText(
        formatMonthTick(date),
        x,
        margin.top + plotHeight + 10,
      );
    }
    context.restore();

    const laneLayouts = [];
    config.series.forEach((series, index) => {
      const laneTop = margin.top + index * (laneHeight + laneGap);
      const visible = visibleRows(series, rows[0].date, rows.at(-1).date);
      setPeriodChange(`${series.summaryKey}-period`, visible);
      if (!visible.length) {
        return;
      }
      const values = visible.flatMap((row) =>
        [row.value, row.high, row.low].filter(Number.isFinite),
      );
      let minValue = Math.min(...values);
      let maxValue = Math.max(...values);
      const padding = (maxValue - minValue || maxValue * 0.08) * 0.08;
      minValue = Math.max(0, minValue - padding);
      maxValue += padding;
      const yScale = (value) =>
        laneTop + laneHeight - ((value - minValue) / (maxValue - minValue)) * laneHeight;

      context.save();
      context.strokeStyle = colors.border;
      context.fillStyle = colors["text-muted"];
      context.font = "11px Segoe UI, Microsoft YaHei UI, sans-serif";
      context.textAlign = "right";
      context.textBaseline = "middle";
      for (let tick = 0; tick <= 3; tick += 1) {
        const value = minValue + ((maxValue - minValue) * tick) / 3;
        const y = yScale(value);
        context.beginPath();
        context.moveTo(margin.left, y);
        context.lineTo(margin.left + plotWidth, y);
        context.stroke();
        context.fillText(formatAxisValue(value), margin.left - 7, y);
      }
      context.textAlign = "left";
      context.textBaseline = "top";
      context.font = "600 12px Segoe UI, Microsoft YaHei UI, sans-serif";
      const labelWidth = context.measureText(series.label).width;
      context.fillStyle = colors.surface;
      context.globalAlpha = 0.82;
      context.fillRect(margin.left + 4, laneTop, labelWidth + 10, 18);
      context.globalAlpha = 1;
      context.fillStyle = colors[series.color];
      context.fillText(series.label, margin.left + 9, laneTop + 2);
      context.restore();

      drawPrimarySeries(
        context,
        { color: series.color },
        visible,
        xScale,
        yScale,
        (value) => value,
        plotWidth,
      );
      laneLayouts.push({ series, visible, laneTop, laneHeight, yScale });
    });

    const events = filteredEvents().filter(
      (event) => event.date >= rows[0].date && event.date <= rows.at(-1).date,
    );
    const clusters = clusterEvents(events, xScale, width < 560 ? 28 : 22);
    drawEventTimeline(
      context,
      events,
      xScale,
      margin,
      plotWidth,
      plotHeight,
      width < 560 ? 28 : 22,
    );

    const hoverX = state.hover.get("china");
    if (Number.isFinite(hoverX) && hoverX >= margin.left && hoverX <= margin.left + plotWidth) {
      const hoverDate = xToDate(
        hoverX,
        margin.left,
        plotWidth,
        rows[0].date,
        rows.at(-1).date,
      );
      context.save();
      context.strokeStyle = colors["border-strong"];
      context.globalAlpha = 0.65;
      context.beginPath();
      context.moveTo(hoverX, margin.top);
      context.lineTo(hoverX, margin.top + plotHeight);
      context.stroke();
      context.restore();
      showChinaTooltip(
        chartTooltip,
        wrapper,
        hoverDate,
        hoverX,
        margin.top + laneHeight * 0.5,
        laneLayouts,
        clusters,
        hoverX,
      );
    } else {
      chartTooltip.hidden = true;
    }

    chart.layout = {
      baseRows,
      rows,
      startIndex: viewport.startIndex,
      endIndex: viewport.endIndex,
      margin,
      plotWidth,
      plotHeight,
      xScale,
      yScale: null,
      toChartValue: (value) => value,
    };
  }

  function showChinaTooltip(
    chartTooltip,
    wrapper,
    date,
    x,
    y,
    laneLayouts,
    clusters,
    hoverX,
  ) {
    const rows = laneLayouts
      .map((lane) => {
        const point = nearestValue(lane.visible, date);
        return `
          <div class="tooltip-market-row">
            <span>${escapeHtml(lane.series.label)}</span>
            <b>${point ? formatNumber(point.value) : "--"}</b>
          </div>
        `;
      })
      .join("");
    const nearestCluster = clusters.reduce((best, cluster) => {
      const distance = Math.abs(cluster.x - hoverX);
      return !best || distance < best.distance ? { cluster, distance } : best;
    }, null);
    const nearbyEvents =
      nearestCluster && nearestCluster.distance <= 16
        ? nearestCluster.cluster.events
            .slice()
            .sort((a, b) => b.date.localeCompare(a.date))
            .slice(0, 3)
        : [];
    const eventMarkup = nearbyEvents.length
      ? `<div class="tooltip-events">${nearbyEvents
          .map(
            (event) =>
              `<div class="tooltip-event ${event.type}"><span>${escapeHtml(eventTitle(event))}</span></div>`,
          )
          .join("")}</div>`
      : "";
    chartTooltip.innerHTML = `
      <strong>${formatDate(date)}</strong>
      ${rows}
      ${eventMarkup}
    `;
    chartTooltip.hidden = false;
    positionTooltip(chartTooltip, wrapper, x, y);
  }

  function positionTooltip(chartTooltip, wrapper, x, y) {
    const tooltipWidth = chartTooltip.offsetWidth;
    const tooltipHeight = chartTooltip.offsetHeight;
    const wrapperWidth = wrapper.clientWidth;
    const wrapperHeight = wrapper.clientHeight;
    let left = x + 14;
    if (left + tooltipWidth > wrapperWidth - 4) {
      left = x - tooltipWidth - 14;
    }
    left = Math.max(4, Math.min(wrapperWidth - tooltipWidth - 4, left));
    let top = y - tooltipHeight - 12;
    if (top < 4) {
      top = y + 12;
    }
    top = Math.max(4, Math.min(wrapperHeight - tooltipHeight - 4, top));
    chartTooltip.style.left = `${left}px`;
    chartTooltip.style.top = `${top}px`;
  }

  function drawGrid(
    context,
    rows,
    xScale,
    yScale,
    margin,
    plotWidth,
    plotHeight,
    minValue,
    maxValue,
  ) {
    context.save();
    context.strokeStyle = colors.border;
    context.fillStyle = colors["text-muted"];
    context.lineWidth = 1;
    context.font = "11px Segoe UI, Microsoft YaHei UI, sans-serif";

    const tickCount = 5;
    for (let index = 0; index <= tickCount; index += 1) {
      const value = minValue + ((maxValue - minValue) * index) / tickCount;
      const y = yScale(value);
      context.beginPath();
      context.moveTo(margin.left, y);
      context.lineTo(margin.left + plotWidth, y);
      context.stroke();
      context.textAlign = "right";
      context.textBaseline = "middle";
      context.fillText(formatAxisValue(value), margin.left - 8, y);
    }

    const tickDates = chooseDateTicks(rows, margin, plotWidth);
    context.textAlign = "center";
    context.textBaseline = "top";
    for (const date of tickDates) {
      const x = xScale(date);
      context.strokeStyle = colors.border;
      context.globalAlpha = 0.35;
      context.beginPath();
      context.moveTo(x, margin.top);
      context.lineTo(x, margin.top + plotHeight);
      context.stroke();
      context.globalAlpha = 1;
      context.fillStyle = colors["text-muted"];
      context.fillText(formatMonthTick(date), x, margin.top + plotHeight + 10);
    }
    context.restore();
  }

  function formatAxisValue(value) {
    if (Math.abs(value) >= 10000) {
      return `${(value / 1000).toFixed(0)}k`;
    }
    if (Math.abs(value) >= 1000) {
      return `${(value / 1000).toFixed(1)}k`;
    }
    return value.toFixed(0);
  }

  function formatMonthTick(date) {
    const [year, month] = date.split("-");
    return `${year}-${month}`;
  }

  function chooseDateTicks(rows, margin, plotWidth) {
    const desired = plotWidth < 520 ? 4 : plotWidth < 820 ? 6 : 8;
    const values = [];
    for (let index = 0; index < desired; index += 1) {
      const rowIndex = Math.round((index / (desired - 1)) * (rows.length - 1));
      const date = rows[rowIndex].date;
      if (!values.includes(date)) {
        values.push(date);
      }
    }
    return values;
  }

  function downsample(rows, targetCount) {
    if (rows.length <= targetCount) {
      return rows;
    }
    const result = [];
    const bucketSize = rows.length / targetCount;
    for (let bucket = 0; bucket < targetCount; bucket += 1) {
      const start = Math.floor(bucket * bucketSize);
      const end = Math.max(start + 1, Math.floor((bucket + 1) * bucketSize));
      const slice = rows.slice(start, end);
      let min = slice[0];
      let max = slice[0];
      for (const row of slice) {
        if (row.value < min.value) {
          min = row;
        }
        if (row.value > max.value) {
          max = row;
        }
      }
      if (min === max) {
        result.push(min);
      } else if (min.date < max.date) {
        result.push(min, max);
      } else {
        result.push(max, min);
      }
    }
    return result;
  }

  function clusterEvents(events, xScale, threshold) {
    const clusters = [];
    for (const event of [...events].sort((a, b) => a.date.localeCompare(b.date))) {
      const x = xScale(event.date);
      const last = clusters.at(-1);
      if (last && Math.abs(x - last.x) < threshold) {
        last.events.push(event);
        last.x = (last.x * (last.events.length - 1) + x) / last.events.length;
        last.date = last.events[Math.floor(last.events.length / 2)].date;
      } else {
        clusters.push({ x, date: event.date, events: [event] });
      }
    }
    return clusters;
  }

  function eventClusterColor(cluster) {
    const hasConflict = cluster.events.some((event) => event.type === "conflict");
    const hasFinancial = cluster.events.some((event) => event.type === "financial");
    const hasHealth = cluster.events.some((event) => event.type === "health");
    const hasHike = cluster.events.some((event) => event.type === "hike");
    const hasCut = cluster.events.some((event) => event.type === "cut");
    if (hasConflict) {
      return colors.conflict;
    }
    if (hasFinancial) {
      return colors.financial;
    }
    if (hasHealth) {
      return colors.health;
    }
    if (hasHike && hasCut) {
      return colors["text-muted"];
    }
    return hasHike ? colors.hike : colors.cut;
  }

  function drawClusterMarker(context, cluster, x, y, size) {
    const hasConflict = cluster.events.some((event) => event.type === "conflict");
    const hasFinancial = cluster.events.some((event) => event.type === "financial");
    const hasHealth = cluster.events.some((event) => event.type === "health");
    const hasHike = cluster.events.some((event) => event.type === "hike");
    const hasCut = cluster.events.some((event) => event.type === "cut");
    if (hasConflict) {
      drawDiamond(context, x, y, size - 0.4, colors.conflict, colors.surface);
    } else if (hasFinancial) {
      drawSquareMarker(context, x, y, size - 0.5, colors.financial);
    } else if (hasHealth) {
      drawHealthMarker(context, x, y, size);
    } else if (hasHike && hasCut) {
      drawDiamond(context, x, y, size - 0.7, colors["text-muted"], colors.surface);
    } else if (hasHike) {
      drawTriangle(context, x, y, size, "up", colors.hike, colors.surface);
    } else {
      drawTriangle(context, x, y, size, "down", colors.cut, colors.surface);
    }
  }

  function drawHealthMarker(context, x, y, size) {
    context.save();
    context.beginPath();
    context.arc(x, y, size, 0, Math.PI * 2);
    context.fillStyle = colors.health;
    context.strokeStyle = colors.surface;
    context.lineWidth = 1.4;
    context.fill();
    context.stroke();
    context.strokeStyle = colors.surface;
    context.lineWidth = 1.3;
    context.beginPath();
    context.moveTo(x - size * 0.48, y);
    context.lineTo(x + size * 0.48, y);
    context.moveTo(x, y - size * 0.48);
    context.lineTo(x, y + size * 0.48);
    context.stroke();
    context.restore();
  }

  function drawSquareMarker(context, x, y, size, fill) {
    context.save();
    context.fillStyle = fill;
    context.strokeStyle = colors.surface;
    context.lineWidth = 1.4;
    context.fillRect(x - size, y - size, size * 2, size * 2);
    context.strokeRect(x - size, y - size, size * 2, size * 2);
    context.restore();
  }

  function drawEventTimeline(
    context,
    events,
    xScale,
    margin,
    plotWidth,
    plotHeight,
    threshold,
  ) {
    const plotBottom = margin.top + plotHeight;
    const rows = [
      { type: "hike", label: "加息", y: plotBottom + 58, color: colors.hike },
      { type: "cut", label: "降息", y: plotBottom + 70, color: colors.cut },
      {
        type: "conflict",
        label: "冲突",
        y: plotBottom + 82,
        color: colors.conflict,
      },
      {
        type: "health",
        label: "卫生",
        y: plotBottom + 94,
        color: colors.health,
      },
      {
        type: "financial",
        label: "金融",
        y: plotBottom + 106,
        color: colors.financial,
      },
    ];

    context.save();
    context.font = "600 11px Segoe UI, Microsoft YaHei UI, sans-serif";
    context.textAlign = "left";
    context.textBaseline = "middle";
    let legendX = margin.left;
    const legendY = plotBottom + 34;
    for (const row of rows) {
      const textWidth = context.measureText(row.label).width;
      const chipWidth = textWidth + 28;
      const chipTop = legendY - 9;
      context.globalAlpha = 0.08;
      context.fillStyle = row.color;
      context.beginPath();
      if (typeof context.roundRect === "function") {
        context.roundRect(legendX, chipTop, chipWidth, 18, 6);
      } else {
        context.rect(legendX, chipTop, chipWidth, 18);
      }
      context.fill();
      context.globalAlpha = 0.28;
      context.strokeStyle = row.color;
      context.lineWidth = 1;
      context.stroke();
      context.globalAlpha = 1;
      drawClusterMarker(
        context,
        { events: [{ type: row.type }] },
        legendX + 10,
        legendY,
        3.7,
      );
      context.fillStyle = row.color;
      context.fillText(row.label, legendX + 18, legendY + 0.5);
      legendX += chipWidth + 6;
    }

    for (const row of rows) {
      context.globalAlpha = 0.14;
      context.strokeStyle = row.color;
      context.beginPath();
      context.moveTo(margin.left, row.y);
      context.lineTo(margin.left + plotWidth, row.y);
      context.stroke();
      context.globalAlpha = 1;

      const typeEvents = events.filter((event) => event.type === row.type);
      const clusters = clusterEvents(typeEvents, xScale, threshold);
      for (const cluster of clusters) {
        context.globalAlpha = 0.42;
        context.strokeStyle = row.color;
        context.lineWidth = 1;
        context.setLineDash([2, 3]);
        context.beginPath();
        context.moveTo(cluster.x, plotBottom + 3);
        context.lineTo(cluster.x, row.y - 3);
        context.stroke();
        context.globalAlpha = 1;
        const size = Math.min(
          7,
          5 + Math.max(0, cluster.events.length - 1) * 0.35,
        );
        drawClusterMarker(context, cluster, cluster.x, row.y, size);
      }
    }
    context.restore();
  }

  function drawTriangle(context, x, y, size, direction, fill, stroke) {
    context.save();
    context.beginPath();
    if (direction === "up") {
      context.moveTo(x, y - size);
      context.lineTo(x - size, y + size);
      context.lineTo(x + size, y + size);
    } else {
      context.moveTo(x, y + size);
      context.lineTo(x - size, y - size);
      context.lineTo(x + size, y - size);
    }
    context.closePath();
    context.fillStyle = fill;
    context.strokeStyle = stroke;
    context.lineWidth = 1.5;
    context.fill();
    context.stroke();
    context.restore();
  }

  function drawDiamond(context, x, y, size, fill, stroke) {
    context.save();
    context.beginPath();
    context.moveTo(x, y - size);
    context.lineTo(x + size, y);
    context.lineTo(x, y + size);
    context.lineTo(x - size, y);
    context.closePath();
    context.fillStyle = fill;
    context.strokeStyle = stroke;
    context.lineWidth = 1.5;
    context.fill();
    context.stroke();
    context.restore();
  }

  function xToDate(x, left, width, startDate, endDate) {
    const startTime = new Date(`${startDate}T00:00:00Z`).getTime();
    const endTime = new Date(`${endDate}T00:00:00Z`).getTime();
    const time = startTime + ((x - left) / width) * (endTime - startTime);
    return new Date(time).toISOString().slice(0, 10);
  }

  function showTooltip(
    chartTooltip,
    wrapper,
    date,
    x,
    y,
    clusters,
    hoverX,
    marketKey,
    chartRows,
    comparisonSeries,
  ) {
    const config = marketConfig[marketKey];
    const primaryPoint = nearestValue(chartRows, date);
    let marketRows = "";

    if (config.comparisons?.length) {
      const primaryBase = chartRows[0]?.value;
      const primaryChange =
        primaryPoint && primaryBase
          ? primaryPoint.value / primaryBase - 1
          : null;
      const primaryChangePercent =
        primaryChange === null ? null : primaryChange * 100;
      marketRows += `
        <div class="tooltip-market-row">
          <span>${escapeHtml(config.label)}</span>
          <b>${primaryPoint ? formatNumber(primaryPoint.value, config.digits) : "--"}</b>
        </div>
        <div class="tooltip-market-sub">${formatPercent(primaryChangePercent)} 相对区间起点</div>
      `;
      for (const series of comparisonSeries) {
        const point = nearestValue(series.rows, date);
        const change = point ? point.value / series.base - 1 : null;
        marketRows += `
          <div class="tooltip-market-row">
            <span>${escapeHtml(series.label)}</span>
            <b>${point ? `${formatNumber(point.value)} (${formatPercent(change * 100)})` : "--"}</b>
          </div>
        `;
      }
    } else {
      for (const key of ["sp500", "nasdaq100", "brent", "gold"]) {
        const market = marketConfig[key];
        const point = nearestValue(market.rows, date);
        marketRows += `
          <div class="tooltip-market-row">
            <span>${escapeHtml(market.label)}</span>
            <b>${
              point
                ? `${formatNumber(point.value, market.digits)}${
                    market.unit ? ` ${market.unit}` : ""
                  }`
                : "--"
            }</b>
          </div>
        `;
      }
    }
    const nearestCluster = clusters.reduce((best, cluster) => {
      const distance = Math.abs(cluster.x - hoverX);
      return !best || distance < best.distance ? { cluster, distance } : best;
    }, null);
    const nearbyEvents =
      nearestCluster && nearestCluster.distance <= 16
        ? nearestCluster.cluster.events
            .slice()
            .sort((a, b) => b.date.localeCompare(a.date))
        : [];
    const visibleEvents = nearbyEvents.slice(0, 4);
    const hiddenEventCount = Math.max(0, nearbyEvents.length - visibleEvents.length);

    const eventMarkup = visibleEvents.length
      ? `<div class="tooltip-events">${visibleEvents
          .map(
            (event) =>
              `<div class="tooltip-event ${event.type}"><span>${escapeHtml(eventTitle(event))}</span></div>`,
          )
          .join("")}${
            hiddenEventCount
              ? `<div class="text-small">另有 ${hiddenEventCount} 个事件</div>`
              : ""
          }</div>`
      : "";
    chartTooltip.innerHTML = `
      <strong>${formatDate(date)}</strong>
      ${marketRows}
      ${eventMarkup}
    `;
    chartTooltip.hidden = false;
    const tooltipWidth = chartTooltip.offsetWidth;
    const tooltipHeight = chartTooltip.offsetHeight;
    const wrapperWidth = wrapper.clientWidth;
    const wrapperHeight = wrapper.clientHeight;
    let left = x + 14;
    if (left + tooltipWidth > wrapperWidth - 4) {
      left = x - tooltipWidth - 14;
    }
    left = Math.max(4, Math.min(wrapperWidth - tooltipWidth - 4, left));
    let top = y - tooltipHeight - 12;
    if (top < 4) {
      top = y + 12;
    }
    top = Math.max(4, Math.min(wrapperHeight - tooltipHeight - 4, top));
    chartTooltip.style.left = `${left}px`;
    chartTooltip.style.top = `${top}px`;
  }

  function updateRangeButtons() {
    document.querySelectorAll("[data-range]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.range === state.range));
    });
  }

  function updateChartRangeLabel(config, rows) {
    if (!rows.length) {
      return;
    }
    const modeLabel = config.rebase ? "相对区间起点 = 100" : config.unit;
    document.querySelector(`#${config.prefix}-range-label`).textContent =
      `${formatDate(rows[0].date)} 至 ${formatDate(rows.at(-1).date)}${
        modeLabel ? ` · ${modeLabel}` : ""
      }`;
  }

  function initializeChartRangePickers() {
    const initial = getRangeBounds();
    setAllChartRanges(initial.start.slice(0, 7), initial.end.slice(0, 7));
    document.querySelectorAll("[data-chart-range]").forEach((picker) => {
      const minMonth = earliestMonthForChart(picker.dataset.chartRange);
      const years = [];
      for (
        let year = Number(minMonth.slice(0, 4));
        year <= Number(DATA.meta.through.slice(0, 4));
        year += 1
      ) {
        years.push(year);
      }
      picker.dataset.minMonth = minMonth;
      picker.dataset.active = "start";
      picker.dataset.years = years.join(",");
      renderChartRangePicker(picker);
      picker.addEventListener("click", (event) => {
        const toggle = event.target.closest(".chart-range-toggle");
        const tab = event.target.closest("[data-range-endpoint]");
        const yearButton = event.target.closest("[data-range-year]");
        const monthButton = event.target.closest("[data-range-month]");
        if (toggle) {
          const isOpen = picker.dataset.open !== "true";
          closeAllRangePickers();
          picker.dataset.open = String(isOpen);
          renderChartRangePicker(picker);
          return;
        }
        if (tab) {
          picker.dataset.active = tab.dataset.rangeEndpoint;
          renderChartRangePicker(picker);
          return;
        }
        if (yearButton) {
          const range = state.chartRanges.get(picker.dataset.chartRange);
          const active = picker.dataset.active;
          const month = range[active].slice(5, 7);
          applyChartRangeMonth(
            picker,
            active,
            `${yearButton.dataset.rangeYear}-${month}`,
            false,
          );
          return;
        }
        if (monthButton) {
          const range = state.chartRanges.get(picker.dataset.chartRange);
          const active = picker.dataset.active;
          const year = range[active].slice(0, 4);
          applyChartRangeMonth(
            picker,
            active,
            `${year}-${String(monthButton.dataset.rangeMonth).padStart(2, "0")}`,
          );
        }
      });
    });
    document.addEventListener("click", (event) => {
      const clickedInsidePicker = event
        .composedPath()
        .some((node) => node?.classList?.contains("chart-range-picker"));
      if (!clickedInsidePicker) {
        closeAllRangePickers();
      }
    });
  }

  function renderChartRangePicker(picker) {
    const range = state.chartRanges.get(picker.dataset.chartRange);
    const active = picker.dataset.active || "start";
    const activeMonth = range[active];
    const activeYear = Number(activeMonth.slice(0, 4));
    const activeMonthNumber = Number(activeMonth.slice(5, 7));
    const years = (picker.dataset.years || "").split(",").filter(Boolean);
    picker.innerHTML = `
      <button class="chart-range-toggle" type="button" aria-expanded="${
        picker.dataset.open === "true"
      }">
        <span>区间</span>
        <strong>${range.start} → ${range.end}</strong>
      </button>
      <div class="chart-range-popover" ${picker.dataset.open === "true" ? "" : "hidden"}>
        <div class="chart-range-tabs">
          <button class="${active === "start" ? "active" : ""}" type="button" data-range-endpoint="start">
            <span>开始</span><strong>${range.start}</strong>
          </button>
          <button class="${active === "end" ? "active" : ""}" type="button" data-range-endpoint="end">
            <span>结束</span><strong>${range.end}</strong>
          </button>
        </div>
        <span class="chart-range-section-label">选择年份</span>
        <div class="year-grid">
          ${years
            .map(
              (year) =>
                `<button class="${Number(year) === activeYear ? "selected" : ""}" type="button" data-range-year="${year}">${year}</button>`,
            )
            .join("")}
        </div>
        <span class="chart-range-section-label">选择月份</span>
        <div class="month-grid">
          ${Array.from(
            { length: 12 },
            (_, index) =>
              `<button class="${index + 1 === activeMonthNumber ? "selected" : ""}" type="button" data-range-month="${index + 1}">${index + 1}月</button>`,
          ).join("")}
        </div>
      </div>
    `;
  }

  function applyChartRangeMonth(picker, endpoint, month, advance = true) {
    const chartKey = picker.dataset.chartRange;
    const current = state.chartRanges.get(chartKey);
    const minMonth = picker.dataset.minMonth || earliestMonthForChart(chartKey);
    const next = {
      ...current,
      [endpoint]: month < minMonth ? minMonth : month,
    };
    if (next.start > next.end) {
      if (endpoint === "start") {
        next.end = next.start;
      } else {
        next.start = next.end;
      }
    }
    state.chartRanges.set(chartKey, next);
    state.viewport.delete(chartKey);
    if (advance && endpoint === "start" && next.start < next.end) {
      picker.dataset.active = "end";
      picker.dataset.open = "true";
    } else if (advance) {
      picker.dataset.open = "false";
    } else {
      picker.dataset.open = "true";
    }
    renderChartRangePicker(picker);
    drawChart(chartKey);
  }

  function syncAllRangePickers() {
    document.querySelectorAll("[data-chart-range]").forEach((picker) => {
      renderChartRangePicker(picker);
    });
  }

  function closeAllRangePickers() {
    document.querySelectorAll(".chart-range-picker").forEach((picker) => {
      if (picker.dataset.open === "true") {
        picker.dataset.open = "false";
        renderChartRangePicker(picker);
      }
    });
  }

  function setupSidebarNavigation() {
    const links = [...document.querySelectorAll(".side-nav a[href^='#']")];
    const sections = links
      .map((link) => ({
        link,
        section: document.querySelector(link.getAttribute("href")),
      }))
      .filter((item) => item.section);

    const setActive = (activeLink) => {
      links.forEach((link) => {
        link.classList.toggle("active", link === activeLink);
      });
    };

    links.forEach((link) => {
      link.addEventListener("click", () => setActive(link));
    });

    if ("IntersectionObserver" in window) {
      const observer = new IntersectionObserver(
        (entries) => {
          const visible = entries
            .filter((entry) => entry.isIntersecting)
            .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
          if (!visible.length) {
            return;
          }
          const item = sections.find(
            (candidate) => candidate.section === visible[0].target,
          );
          if (item) {
            setActive(item.link);
          }
        },
        {
          rootMargin: "-25% 0px -60% 0px",
          threshold: [0, 0.1, 0.35, 0.6],
        },
      );
      sections.forEach((item) => observer.observe(item.section));
    }

    const initial = links.find(
      (link) => link.getAttribute("href") === window.location.hash,
    );
    if (initial) {
      setActive(initial);
    }
  }

  function setupResponsiveNewsPlacement() {
    const news = document.querySelector(".sidebar-news");
    const slot = document.querySelector("#mobile-news-slot");
    const sidebar = document.querySelector(".sidebar");
    const sidebarStatus = document.querySelector(".sidebar-status");
    const media = window.matchMedia("(max-width: 960px)");

    const placeNews = () => {
      if (media.matches) {
        slot.append(news);
      } else {
        sidebar.insertBefore(news, sidebarStatus);
      }
    };

    placeNews();
    media.addEventListener("change", placeNews);
  }

  function refresh() {
    updateRangeButtons();
    updateSummary();
    updateMarketHeadings();
    renderEventTable();
    renderSidebarNews();
    for (const key of Object.keys(allChartConfigs)) {
      drawChart(key);
    }
  }

  function setupDataAutoRefresh() {
    if (window.location.protocol === "file:") {
      return;
    }
    let lastModified = null;
    const check = async () => {
      try {
        const response = await fetch(`./data.js?check=${Date.now()}`, {
          method: "HEAD",
          cache: "no-store",
        });
        const nextModified = response.headers.get("last-modified");
        if (!lastModified) {
          lastModified = nextModified;
        } else if (nextModified && nextModified !== lastModified) {
          window.location.reload();
        }
      } catch {
        // The offline file:// mode does not support update checks.
      }
    };
    check();
    window.setInterval(check, 60_000);
  }

  function initialize() {
    if (!DATA || !DATA.markets) {
      document.querySelector("#freshness-label").textContent = "数据不可用";
      document.querySelector("#freshness-time").textContent = "请先运行更新脚本";
      return;
    }

    readThemeColors();
    for (const [key, config] of Object.entries(allChartConfigs)) {
      setupCanvas(config.canvas, key);
    }

    document.querySelector("#freshness-label").textContent = `数据截至 ${formatDate(DATA.meta.through)}`;
    const generatedAt = new Date(DATA.meta.generatedAt);
    document.querySelector("#freshness-time").textContent =
      `本地快照生成于 ${generatedAt.toLocaleString("zh-CN", { hour12: false })}`;
    document.querySelector("#source-line").textContent =
      `标普500：${DATA.meta.sources.sp500}；纳斯达克100：${DATA.meta.sources.nasdaq100}；布伦特原油：${DATA.meta.sources.brent}；黄金现货：${DATA.meta.sources.gold}；中国指数：${DATA.meta.sources.china}；利率：${DATA.meta.sources.fed}；冲突：${DATA.meta.sources.conflicts}。`;

    document.querySelector("#range-control").addEventListener("click", (event) => {
      const button = event.target.closest("[data-range]");
      if (!button) {
        return;
      }
      state.range = button.dataset.range;
      state.customRange = null;
      state.viewport.clear();
      const bounds = getRangeBounds();
      setAllChartRanges(bounds.start.slice(0, 7), bounds.end.slice(0, 7));
      refresh();
    });

    document.querySelectorAll("[data-reset-chart]").forEach((button) => {
      button.addEventListener("click", () => {
        resetChartViewport(button.dataset.resetChart);
      });
    });
    document.querySelectorAll("[data-zoom-chart]").forEach((button) => {
      button.addEventListener("click", () => {
        zoomChartBy(button.dataset.zoomChart, button.dataset.zoomDirection);
      });
    });

    document.querySelectorAll("[data-event-filter]").forEach((input) => {
      input.addEventListener("change", () => {
        if (input.checked) {
          state.types.add(input.dataset.eventFilter);
        } else {
          state.types.delete(input.dataset.eventFilter);
        }
        refresh();
      });
    });

    document.querySelector("#event-search").addEventListener("input", (event) => {
      state.query = event.target.value;
      updateSummary();
      renderEventTable();
      for (const key of Object.keys(allChartConfigs)) {
        drawChart(key);
      }
    });

    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      readThemeColors();
      for (const key of Object.keys(allChartConfigs)) {
        drawChart(key);
      }
    });

    initializeChartRangePickers();
    setupSidebarNavigation();
    setupResponsiveNewsPlacement();
    refresh();
    setupDataAutoRefresh();
  }

  initialize();
})();
