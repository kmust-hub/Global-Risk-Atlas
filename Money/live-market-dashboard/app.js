const state = {
  data: null,
  range: localStorage.getItem('marketRange') || '1y',
  visible: {
    zzhl: localStorage.getItem('showZzhl') !== 'false',
    cyb: localStorage.getItem('showCyb') !== 'false',
    r: localStorage.getItem('showR') !== 'false',
    ma90: localStorage.getItem('showMa90') !== 'false',
    ma40: localStorage.getItem('showMa40') !== 'false'
  },
  pollTimer: null,
  busy: false,
  error: false
};

const rangeDays = { '1m': 31, '3m': 92, '6m': 183, '1y': 366, '3y': 1096, '5y': 1826, all: null };
const seriesMeta = {
  zzhl: { label: '中证红利', color: '--zzhl', raw: value => `${Number(value).toFixed(2)} 点` },
  cyb: { label: '创业板指', color: '--cyb', raw: value => `${Number(value).toFixed(2)} 点` },
  r: { label: 'R', color: '--r', raw: value => Number(value).toFixed(4) },
  ma90: { label: '红利 90 月线', color: '--ma90', raw: value => `${Number(value).toFixed(2)} 点` },
  ma40: { label: '红利 40 月线', color: '--ma40', raw: value => `${Number(value).toFixed(2)} 点` }
};

const el = id => document.getElementById(id);
const parseDate = d3.timeParse('%Y-%m-%d');
const formatValue = (value, digits = 2) => Number.isFinite(Number(value))
  ? Number(value).toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits })
  : '—';

function setStatus(text, mode = '') {
  el('marketStatus').textContent = text;
  el('marketDot').classList.toggle('is-live', mode === 'live');
  el('marketDot').classList.toggle('is-error', mode === 'error');
}

function setDelta(node, pct) {
  if (!Number.isFinite(Number(pct))) {
    node.textContent = '最后交易日';
    node.className = 'metric-delta';
    return;
  }
  const numeric = Number(pct);
  const arrow = numeric > 0 ? '▲' : numeric < 0 ? '▼' : '•';
  node.textContent = `${arrow} ${Math.abs(numeric).toFixed(2)}%`;
  node.className = `metric-delta tabular ${numeric > 0 ? 'positive' : numeric < 0 ? 'negative' : ''}`;
}

function updateMetrics(data) {
  const { quote, strategy, meta } = data;
  el('zzhlPrice').textContent = formatValue(quote.zzhl.price, 2);
  el('cybPrice').textContent = formatValue(quote.cyb.price, 2);
  el('rValue').textContent = formatValue(strategy.R, 4);

  setDelta(el('zzhlDelta'), quote.zzhl.changePct);
  setDelta(el('cybDelta'), quote.cyb.changePct);
  el('rZone').textContent = strategy.zone;

  const r = Number(strategy.R);
  const zoneText = r <= 0.33 ? '低于 0.33：创业板买入区'
    : r >= 0.65 ? '高于 0.65：创业板清仓区'
    : r >= 0.52 ? '0.52—0.65：创业板减仓区'
    : '0.33—0.52：规则未触发';
  el('rPosition').textContent = zoneText;

  el('ma90Value').textContent = strategy.ma90 ? formatValue(strategy.ma90, 2) : '—';
  el('ma40Value').textContent = strategy.ma40 ? formatValue(strategy.ma40, 2) : '—';
  el('dist90Value').textContent = Number.isFinite(strategy.dist90Pct)
    ? `当前距离 ${strategy.dist90Pct >= 0 ? '+' : ''}${strategy.dist90Pct.toFixed(2)}%`
    : '样本不足';
  el('dist40Value').textContent = Number.isFinite(strategy.dist40Pct)
    ? `当前距离 ${strategy.dist40Pct >= 0 ? '+' : ''}${strategy.dist40Pct.toFixed(2)}%`
    : '样本不足';

  const near90 = Number.isFinite(strategy.dist90Pct) && strategy.dist90Pct <= 12;
  const reduce40 = Number.isFinite(strategy.dist40Pct) && strategy.dist40Pct >= 8;
  const trigger = r <= 0.33 ? 'R 进入创业板建仓区'
    : r >= 0.65 ? 'R 进入创业板清仓区'
    : r >= 0.52 ? 'R 进入创业板减仓区'
    : reduce40 ? '红利进入 40 月线减仓区'
    : near90 ? '红利仍在 90 月线买入带' : '当前无主要动作';
  el('signalText').textContent = trigger;

  const stamp = meta.generatedAt ? new Date(meta.generatedAt) : new Date();
  const stampText = stamp.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  el('lastUpdated').textContent = `${meta.marketStatus || '数据已载入'} · ${stampText}`;
  setStatus(meta.marketStatus || '数据已载入', meta.isLive ? 'live' : '');
  const interval = meta.pollMs ? Math.round(meta.pollMs / 1000) : 300;
  el('sourceStatus').textContent = meta.isLive
    ? `交易中，每 ${interval} 秒自动更新`
    : `已收盘，每 ${Math.max(1, Math.round(interval / 60))} 分钟检查一次`;
  if (meta.historyStart && meta.historyCount) {
    el('historyCoverage').textContent = `${meta.historyStart} 起 · ${Number(meta.historyCount).toLocaleString('zh-CN')} 个交易日`;
  }
}

function getRangeStart(lastDate) {
  const days = rangeDays[state.range];
  return days == null ? null : d3.timeDay.offset(lastDate, -days);
}

function getRgbColors() {
  const styles = getComputedStyle(document.documentElement);
  return Object.fromEntries(Object.entries(seriesMeta).map(([key, meta]) => [
    key,
    styles.getPropertyValue(meta.color).trim()
  ]));
}

function buildLevel(rows, key) {
  return rows.map(row => ({
    date: parseDate(row.date),
    y: Number.isFinite(row[key]) ? Number(row[key]) : null,
    raw: row[key],
    row
  }));
}

function createTooltipRow(key, point) {
  const meta = seriesMeta[key];
  if (!point) return null;
  const row = document.createElement('div');
  row.className = 'tooltip-row';
  const dot = document.createElement('span');
  dot.className = 'tooltip-dot';
  dot.style.setProperty('--tooltip-color', `var(${meta.color})`);
  const label = document.createElement('span');
  label.className = 'tooltip-label';
  label.textContent = meta.label;
  const value = document.createElement('span');
  value.className = 'tooltip-value';
  if (key === 'r') {
    value.textContent = Number(point.raw).toFixed(4);
  } else {
    value.textContent = meta.raw(point.raw);
  }
  row.append(dot, label, value);
  return row;
}

function renderChart() {
  if (!state.data?.series?.length) return;
  const svg = d3.select('#chart');
  const node = el('chart');
  const width = Math.max(280, node.clientWidth || el('chartWrap').clientWidth);
  const height = Math.max(360, node.clientHeight || 480);
  svg.attr('viewBox', `0 0 ${width} ${height}`).attr('width', width).attr('height', height);
  svg.selectAll('*').remove();

  svg.append('title').text('中证红利、创业板指、长期均线与R的每日走势');
  svg.append('desc').text('左轴显示中证红利、创业板指、红利90月线和40月线的真实点位，右轴显示创业板指除以中证红利的R值。');

  const lastDate = parseDate(state.data.series.at(-1).date);
  const start = getRangeStart(lastDate);
  const rawRows = state.data.series.filter(row => !start || parseDate(row.date) >= start);
  if (rawRows.length < 2) return;

  const margin = {
    top: 28,
    right: width < 560 ? 48 : 57,
    bottom: 42,
    left: width < 560 ? 48 : 59
  };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;
  const colors = getRgbColors();
  const x = d3.scaleTime()
    .domain(d3.extent(rawRows, row => parseDate(row.date)))
    .range([margin.left, margin.left + innerW]);

  const levels = {
    zzhl: buildLevel(rawRows, 'zzhl'),
    cyb: buildLevel(rawRows, 'cyb'),
    ma90: buildLevel(rawRows, 'ma90'),
    ma40: buildLevel(rawRows, 'ma40')
  };
  const rRows = rawRows.map(row => ({ date: parseDate(row.date), raw: row.r, row }));

  const leftValues = [];
  Object.keys(levels).forEach(key => {
    if (state.visible[key]) levels[key].forEach(row => { if (Number.isFinite(row.y)) leftValues.push(row.y); });
  });
  if (!leftValues.length) leftValues.push(0, 100);
  let [leftMin, leftMax] = d3.extent(leftValues);
  const leftPad = Math.max(1.5, (leftMax - leftMin) * 0.08);
  leftMin -= leftPad;
  leftMax += leftPad;
  const yLeft = d3.scaleLinear().domain([leftMin, leftMax]).nice().range([margin.top + innerH, margin.top]);

  const rValues = rRows.map(row => row.raw);
  const rMin = Math.min(0.30, d3.min(rValues) - 0.02);
  const rMax = Math.max(0.70, d3.max(rValues) + 0.02);
  const yRight = d3.scaleLinear().domain([rMin, rMax]).nice().range([margin.top + innerH, margin.top]);

  const clipId = 'chart-clip';
  svg.append('defs').append('clipPath').attr('id', clipId)
    .append('rect')
    .attr('x', margin.left)
    .attr('y', margin.top)
    .attr('width', innerW)
    .attr('height', innerH);

  const plot = svg.append('g').attr('class', 'chart');
  const xTicks = width < 480 ? 4 : width < 720 ? 6 : 8;
  const xAxis = d3.axisBottom(x).ticks(xTicks).tickSize(0).tickPadding(10)
    .tickFormat(state.range === '1m' || state.range === '3m' ? d3.timeFormat('%m-%d') : d3.timeFormat('%y-%m'));
  const yAxisLeft = d3.axisLeft(yLeft).ticks(5).tickSize(0).tickPadding(9).tickFormat(d3.format('.0f'));
  const yAxisRight = d3.axisRight(yRight).ticks(5).tickSize(0).tickPadding(9).tickFormat(d3.format('.2f'));

  plot.append('g')
    .attr('class', 'axis axis-y')
    .attr('transform', `translate(${margin.left},0)`)
    .call(yAxisLeft);

  plot.append('g')
    .attr('class', 'axis axis-y-right')
    .attr('transform', `translate(${margin.left + innerW},0)`)
    .call(yAxisRight);

  plot.append('g')
    .attr('class', 'axis axis-x')
    .attr('transform', `translate(0,${margin.top + innerH})`)
    .call(xAxis);

  plot.selectAll('.axis-y .tick').select('text').attr('x', -2);
  plot.selectAll('.axis-y-right .tick').select('text').attr('x', 2);

  const gridGroup = plot.append('g').attr('class', 'grid');
  yLeft.ticks(5).forEach(tick => {
    gridGroup.append('line')
      .attr('class', 'grid-line')
      .attr('x1', margin.left)
      .attr('x2', margin.left + innerW)
      .attr('y1', yLeft(tick))
      .attr('y2', yLeft(tick));
  });

  plot.append('text')
    .attr('class', 'axis-title')
    .attr('data-axis', 'y')
    .attr('x', margin.left)
    .attr('y', margin.top - 10)
    .text('指数点位');
  plot.append('text')
    .attr('class', 'axis-title')
    .attr('data-axis', 'y')
    .attr('x', margin.left + innerW)
    .attr('y', margin.top - 10)
    .attr('text-anchor', 'end')
    .text('R');

  if (state.visible.r) {
    [0.33, 0.52, 0.65].forEach((threshold, index) => {
      const yy = yRight(threshold);
      plot.append('line')
        .attr('class', 'threshold-line')
        .attr('x1', margin.left)
        .attr('x2', margin.left + innerW)
        .attr('y1', yy)
        .attr('y2', yy);
      const labels = ['R 0.33 买入', 'R 0.52 减仓', 'R 0.65 清仓'];
      plot.append('text')
        .attr('class', 'threshold-label')
        .attr('x', margin.left + 6)
        .attr('y', yy - 4)
        .text(labels[index]);
    });
  }

  const line = d3.line()
    .defined(row => Number.isFinite(row.y))
    .x(row => x(row.date))
    .y(row => yLeft(row.y));

  const rLine = d3.line()
    .defined(row => Number.isFinite(row.raw))
    .x(row => x(row.date))
    .y(row => yRight(row.raw));

  const clip = plot.append('g').attr('clip-path', `url(#${clipId})`);

  const lineInfo = [
    ['zzhl', levels.zzhl, line],
    ['cyb', levels.cyb, line],
    ['ma90', levels.ma90, line],
    ['ma40', levels.ma40, line]
  ];
  lineInfo.forEach(([key, rows, generator]) => {
    if (!state.visible[key] || !rows.length) return;
    clip.append('path')
      .datum(rows)
      .attr('class', `series-line ${key}`)
      .attr('d', generator);
  });

  if (state.visible.r) {
    clip.append('path')
      .datum(rRows)
      .attr('class', 'series-line r')
      .attr('d', rLine);
  }

  const lastMarkers = [];
  lineInfo.forEach(([key, rows]) => {
    if (!state.visible[key]) return;
    const last = [...rows].reverse().find(row => Number.isFinite(row.y));
    if (last) lastMarkers.push({ key, ...last, yPos: yLeft(last.y) });
  });
  if (state.visible.r) {
    const last = [...rRows].reverse().find(row => Number.isFinite(row.raw));
    if (last) lastMarkers.push({ key: 'r', ...last, yPos: yRight(last.raw) });
  }
  lastMarkers.forEach(mark => {
    plot.append('circle')
      .attr('class', 'last-dot')
      .attr('cx', x(mark.date))
      .attr('cy', mark.yPos)
      .attr('r', 4)
      .attr('fill', colors[mark.key]);
    if (mark.key === 'ma90' || mark.key === 'ma40') {
      plot.append('text')
        .attr('class', 'series-end-label')
        .attr('x', x(mark.date) - 7)
        .attr('y', mark.yPos - 7)
        .attr('text-anchor', 'end')
        .attr('fill', colors[mark.key])
        .text(`${mark.key === 'ma90' ? '90月线' : '40月线'} ${Number(mark.y).toFixed(0)}`);
    }
  });

  const crossGroup = plot.append('g').attr('class', 'hover-layer');
  const guide = crossGroup.append('line').attr('class', 'hover-guide').attr('y1', margin.top).attr('y2', margin.top + innerH).style('visibility', 'hidden');
  const hoverDots = Object.fromEntries(Object.keys(seriesMeta).map(key => [
    key,
    crossGroup.append('circle').attr('class', 'hover-dot').attr('r', 4).attr('fill', colors[key]).style('visibility', 'hidden')
  ]));

  const bisect = d3.bisector(row => row.date).center;
  const overlay = plot.append('rect')
    .attr('class', 'overlay')
    .attr('x', margin.left)
    .attr('y', margin.top)
    .attr('width', innerW)
    .attr('height', innerH);

  const hideTooltip = () => {
    el('chartTooltip').hidden = true;
    guide.style('visibility', 'hidden');
    Object.values(hoverDots).forEach(dot => dot.style('visibility', 'hidden'));
  };

  const showTooltip = event => {
    const [px] = d3.pointer(event, overlay.node());
    const targetDate = x.invert(px);
    const index = bisect(rRows, targetDate);
    const row = rRows[Math.max(0, Math.min(index, rRows.length - 1))];
    if (!row) return;

    guide.attr('x1', x(row.date)).attr('x2', x(row.date)).style('visibility', 'visible');
    const tooltip = el('chartTooltip');
    tooltip.replaceChildren();
    const dateNode = document.createElement('div');
    dateNode.className = 'tooltip-date';
    dateNode.textContent = row.row.date;
    tooltip.appendChild(dateNode);

    const points = {
      zzhl: levels.zzhl.find(item => item.date.getTime() === row.date.getTime()),
      cyb: levels.cyb.find(item => item.date.getTime() === row.date.getTime()),
      ma90: levels.ma90.find(item => item.date.getTime() === row.date.getTime()),
      ma40: levels.ma40.find(item => item.date.getTime() === row.date.getTime()),
      r: row
    };
    Object.keys(seriesMeta).forEach(key => {
      const point = points[key];
      if (!state.visible[key] || !point) {
        hoverDots[key].style('visibility', 'hidden');
        return;
      }
      const tooltipRow = createTooltipRow(key, point);
      if (tooltipRow) tooltip.appendChild(tooltipRow);
      const yScale = key === 'r' ? yRight : yLeft;
      const value = key === 'r' ? point.raw : point.y;
      hoverDots[key]
        .attr('cx', x(row.date))
        .attr('cy', yScale(value))
        .style('visibility', 'visible');
    });

    tooltip.hidden = false;
    const wrapRect = el('chartWrap').getBoundingClientRect();
    const pointerX = event.clientX - wrapRect.left;
    const pointerY = event.clientY - wrapRect.top;
    const tooltipWidth = tooltip.offsetWidth || 220;
    const left = pointerX + 14 + tooltipWidth > wrapRect.width ? pointerX - tooltipWidth - 14 : pointerX + 14;
    const top = Math.max(8, Math.min(pointerY - 20, wrapRect.height - tooltip.offsetHeight - 8));
    tooltip.style.left = `${Math.max(8, left)}px`;
    tooltip.style.top = `${top}px`;
  };

  overlay
    .on('pointermove', showTooltip)
    .on('pointerenter', showTooltip)
    .on('pointerleave', hideTooltip);
}

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function applyData(data) {
  state.data = data;
  updateMetrics(data);
  try {
    renderChart();
    delete document.body.dataset.chartError;
  } catch (error) {
    document.body.dataset.chartError = String(error?.stack || error);
    console.error('Chart render failed', error);
  }
}

function upsertLatest(point) {
  if (!point || !state.data?.series) return;
  const series = state.data.series;
  const index = series.findIndex(row => row.date === point.date);
  if (index >= 0) series[index] = point;
  else series.push(point);
  series.sort((a, b) => a.date.localeCompare(b.date));
}

async function loadBootstrap(force = false) {
  state.busy = true;
  el('refreshButton').disabled = true;
  el('refreshButton').classList.add('is-spinning');
  state.error = false;
  try {
    const data = await fetchJson(`/api/bootstrap${force ? '?force=1' : ''}`);
    applyData(data);
    el('sourceStatus').textContent = '实时数据已连接';
  } catch (error) {
    state.error = true;
    document.body.dataset.bootstrapError = String(error?.stack || error);
    try {
      const fallback = await fetchJson('data/initial-data.json');
      applyData(fallback);
      setStatus('静态快照', 'error');
      el('sourceStatus').textContent = '实时接口暂不可用，当前显示本地快照';
    } catch (fallbackError) {
      document.body.dataset.fallbackError = String(fallbackError?.stack || fallbackError);
      setStatus('连接失败', 'error');
      el('sourceStatus').textContent = '无法读取数据，请确认本地服务已启动';
    }
  } finally {
    state.busy = false;
    el('refreshButton').disabled = false;
    el('refreshButton').classList.remove('is-spinning');
    schedulePoll();
  }
}

async function pollQuote() {
  if (!state.data || state.busy || document.hidden) {
    schedulePoll();
    return;
  }
  try {
    const payload = await fetchJson(`/api/quote?t=${Date.now()}`);
    state.data.quote = payload.quote;
    state.data.strategy = payload.strategy;
    state.data.meta = payload.meta;
    upsertLatest(payload.latestPoint);
    updateMetrics(state.data);
    renderChart();
  } catch {
    el('sourceStatus').textContent = '本轮更新失败，保留上一笔数据';
  } finally {
    schedulePoll();
  }
}

function schedulePoll() {
  clearTimeout(state.pollTimer);
  const pollMs = state.data?.meta?.pollMs || (state.data?.meta?.isLive ? 10000 : 300000);
  state.pollTimer = setTimeout(pollQuote, pollMs);
}

function bindControls() {
  document.querySelectorAll('#rangeControls button').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.range === state.range));
    button.addEventListener('click', () => {
      state.range = button.dataset.range;
      localStorage.setItem('marketRange', state.range);
      document.querySelectorAll('#rangeControls button').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
      renderChart();
    });
  });

  document.querySelectorAll('#legend button').forEach(button => {
    const key = button.dataset.series;
    button.setAttribute('aria-pressed', String(state.visible[key]));
    button.addEventListener('click', () => {
      state.visible[key] = !state.visible[key];
      button.setAttribute('aria-pressed', String(state.visible[key]));
      localStorage.setItem(`show${key[0].toUpperCase()}${key.slice(1)}`, String(state.visible[key]));
      renderChart();
    });
  });

  el('refreshButton').addEventListener('click', () => loadBootstrap(true));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) pollQuote();
  });
}

let resizeFrame = null;
function bindResize() {
  const observer = new ResizeObserver(() => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(renderChart);
  });
  observer.observe(el('chartWrap'));
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', renderChart);
}

bindControls();
bindResize();
loadBootstrap();
