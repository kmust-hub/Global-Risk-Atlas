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

const rangeDays = { '1m': 31, '3m': 92, '6m': 183, '1y': 366, '3y': 1096, '5y': 1826, '10y': 3653, all: null };
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

function aggregateCandles(rows, mode) {
  const daily = rows.map(row => {
    const zzClose = Number(row.zzhl);
    const cyClose = Number(row.cyb);
    const zzOpen = Number.isFinite(Number(row.zzhlOpen)) ? Number(row.zzhlOpen) : zzClose;
    const cyOpen = Number.isFinite(Number(row.cybOpen)) ? Number(row.cybOpen) : cyClose;
    const zzHigh = Number.isFinite(Number(row.zzhlHigh)) ? Number(row.zzhlHigh) : Math.max(zzOpen, zzClose);
    const cyHigh = Number.isFinite(Number(row.cybHigh)) ? Number(row.cybHigh) : Math.max(cyOpen, cyClose);
    const zzLow = Number.isFinite(Number(row.zzhlLow)) ? Number(row.zzhlLow) : Math.min(zzOpen, zzClose);
    const cyLow = Number.isFinite(Number(row.cybLow)) ? Number(row.cybLow) : Math.min(cyOpen, cyClose);
    return {
      date: parseDate(row.date),
      dateText: row.date,
      zzhlOpen: zzOpen,
      zzhlHigh: zzHigh,
      zzhlLow: zzLow,
      zzhl: zzClose,
      cybOpen: cyOpen,
      cybHigh: cyHigh,
      cybLow: cyLow,
      cyb: cyClose,
      ma90: Number.isFinite(Number(row.ma90)) ? Number(row.ma90) : null,
      ma40: Number.isFinite(Number(row.ma40)) ? Number(row.ma40) : null,
      r: Number(row.r)
    };
  });
  if (mode === 'day') return daily;

  const floor = mode === 'week' ? d3.timeWeek.floor : d3.timeMonth.floor;
  const groups = d3.group(daily, row => +floor(row.date));
  return [...groups.values()]
    .map(group => {
      group.sort((a, b) => a.date - b.date);
      const first = group[0];
      const last = group[group.length - 1];
      return {
        date: last.date,
        dateText: last.dateText,
        zzhlOpen: first.zzhlOpen,
        zzhlHigh: d3.max(group, row => row.zzhlHigh),
        zzhlLow: d3.min(group, row => row.zzhlLow),
        zzhl: last.zzhl,
        cybOpen: first.cybOpen,
        cybHigh: d3.max(group, row => row.cybHigh),
        cybLow: d3.min(group, row => row.cybLow),
        cyb: last.cyb,
        ma90: last.ma90,
        ma40: last.ma40,
        r: last.r
      };
    })
    .sort((a, b) => a.date - b.date);
}

function createTooltipLine(label, value, colorVariable) {
  const row = document.createElement('div');
  row.className = 'tooltip-row';
  const dot = document.createElement('span');
  dot.className = 'tooltip-dot';
  dot.style.setProperty('--tooltip-color', `var(${colorVariable})`);
  const text = document.createElement('span');
  text.className = 'tooltip-label';
  text.textContent = label;
  const number = document.createElement('span');
  number.className = 'tooltip-value';
  number.textContent = value;
  row.append(dot, text, number);
  return row;
}

function createKlineTooltip(title, colorVariable, open, high, low, close) {
  const block = document.createElement('div');
  block.className = 'tooltip-kline';
  const head = document.createElement('div');
  head.className = 'tooltip-kline-head';
  const dot = document.createElement('span');
  dot.className = 'tooltip-dot';
  dot.style.setProperty('--tooltip-color', `var(${colorVariable})`);
  const label = document.createElement('span');
  label.textContent = title;
  head.append(dot, label);
  const values = document.createElement('div');
  values.className = 'tooltip-ohlc';
  values.textContent = `开 ${formatValue(open)}  高 ${formatValue(high)}  低 ${formatValue(low)}  收 ${formatValue(close)}`;
  block.append(head, values);
  return block;
}

function renderChart() {
  if (!state.data?.series?.length) return;
  const svg = d3.select('#chart');
  const node = el('chart');
  const width = Math.max(280, node.clientWidth || el('chartWrap').clientWidth);
  const height = Math.max(560, node.clientHeight || 760);
  svg.attr('viewBox', `0 0 ${width} ${height}`).attr('width', width).attr('height', height);
  svg.selectAll('*').remove();

  svg.append('title').text('中证红利与创业板指 K 线及 R 比价');
  svg.append('desc').text('上方为中证红利日K或聚合K线及90月线、40月线，中间为创业板指K线，下方为创业板指除以中证红利的R值。红涨绿跌。');

  const lastDate = parseDate(state.data.series.at(-1).date);
  const start = getRangeStart(lastDate);
  const rawRows = state.data.series.filter(row => !start || parseDate(row.date) >= start);
  if (rawRows.length < 2) return;

  const mode = (state.range === 'all' || state.range === '10y') ? 'month'
    : (state.range === '3y' || state.range === '5y') ? 'week'
    : (width < 560 && state.range === '1y') ? 'week'
    : 'day';
  el('candleMode').textContent = mode === 'day' ? '日 K' : mode === 'week' ? '周 K' : '月 K';
  const candles = aggregateCandles(rawRows, mode);
  if (!candles.length) return;

  const margin = {
    top: 22,
    right: width < 560 ? 54 : 66,
    bottom: 42,
    left: width < 560 ? 54 : 66
  };
  const gap = width < 560 ? 22 : 26;
  const innerW = width - margin.left - margin.right;
  const totalH = height - margin.top - margin.bottom;
  const zzH = Math.floor(totalH * 0.38);
  const cyH = Math.floor(totalH * 0.33);
  const rH = totalH - zzH - cyH - gap * 2;
  const zzTop = margin.top;
  const cyTop = zzTop + zzH + gap;
  const rTop = cyTop + cyH + gap;
  const bottomY = rTop + rH;
  const colors = getRgbColors();

  const x = d3.scaleTime()
    .domain(d3.extent(candles, row => row.date))
    .range([margin.left, margin.left + innerW]);
  const spacing = candles.length > 1 ? Math.abs(x(candles[1].date) - x(candles[0].date)) : 8;
  const bodyWidth = Math.max(1, Math.min(9, spacing * 0.62));

  const zzValues = candles.flatMap(row => [row.zzhlHigh, row.zzhlLow]);
  if (state.visible.ma90) candles.forEach(row => { if (Number.isFinite(row.ma90)) zzValues.push(row.ma90); });
  if (state.visible.ma40) candles.forEach(row => { if (Number.isFinite(row.ma40)) zzValues.push(row.ma40); });
  let [zzMin, zzMax] = d3.extent(zzValues);
  const zzPad = Math.max(1, (zzMax - zzMin) * 0.06);
  const yZz = d3.scaleLinear().domain([zzMin - zzPad, zzMax + zzPad]).nice().range([zzTop + zzH, zzTop]);

  let [cyMin, cyMax] = d3.extent(candles.flatMap(row => [row.cybHigh, row.cybLow]));
  const cyPad = Math.max(1, (cyMax - cyMin) * 0.06);
  const yCy = d3.scaleLinear().domain([cyMin - cyPad, cyMax + cyPad]).nice().range([cyTop + cyH, cyTop]);

  const rValues = candles.map(row => row.r).filter(Number.isFinite);
  const yR = d3.scaleLinear()
    .domain([Math.min(0.30, d3.min(rValues) - 0.02), Math.max(0.70, d3.max(rValues) + 0.02)])
    .nice()
    .range([rTop + rH, rTop]);

  const clipId = 'candlestick-clip';
  svg.append('defs').append('clipPath').attr('id', clipId)
    .append('rect')
    .attr('x', margin.left)
    .attr('y', margin.top)
    .attr('width', innerW)
    .attr('height', bottomY - margin.top);

  const root = svg.append('g').attr('class', 'chart');
  const plot = root.append('g').attr('clip-path', `url(#${clipId})`);

  const drawPanelAxes = (top, panelHeight, yScale, format) => {
    const axisG = root.append('g')
      .attr('class', 'axis axis-y')
      .attr('transform', `translate(${margin.left},0)`)
      .call(d3.axisLeft(yScale).ticks(4).tickSize(0).tickPadding(8).tickFormat(format));
    axisG.selectAll('.tick text').attr('x', -2);
    const grid = root.append('g').attr('class', 'grid');
    yScale.ticks(4).forEach(tick => {
      grid.append('line')
        .attr('class', 'grid-line')
        .attr('x1', margin.left)
        .attr('x2', margin.left + innerW)
        .attr('y1', yScale(tick))
        .attr('y2', yScale(tick));
    });
    return axisG;
  };

  drawPanelAxes(zzTop, zzH, yZz, d3.format('.0f'));
  drawPanelAxes(cyTop, cyH, yCy, d3.format('.0f'));

  const rAxis = root.append('g')
    .attr('class', 'axis axis-y-right')
    .attr('transform', `translate(${margin.left + innerW},0)`)
    .call(d3.axisRight(yR).ticks(4).tickSize(0).tickPadding(8).tickFormat(d3.format('.2f')));
  rAxis.selectAll('.tick text').attr('x', 2);
  const rGrid = root.append('g');
  yR.ticks(4).forEach(tick => {
    rGrid.append('line')
      .attr('class', 'grid-line')
      .attr('x1', margin.left)
      .attr('x2', margin.left + innerW)
      .attr('y1', yR(tick))
      .attr('y2', yR(tick));
  });

  const xTicks = width < 480 ? 4 : width < 720 ? 6 : 8;
  const xAxis = d3.axisBottom(x).ticks(xTicks).tickSize(0).tickPadding(10)
    .tickFormat(state.range === '1m' || state.range === '3m' ? d3.timeFormat('%m-%d') : d3.timeFormat('%y-%m'));
  root.append('g')
    .attr('class', 'axis axis-x')
    .attr('transform', `translate(0,${bottomY})`)
    .call(xAxis);

  const panelTitle = (top, title, note) => {
    root.append('text').attr('class', 'panel-title').attr('x', margin.left + 5).attr('y', top + 14).text(title);
    if (note) root.append('text').attr('class', 'panel-note').attr('x', margin.left + 5).attr('y', top + 28).text(note);
  };
  panelTitle(zzTop, '中证红利 K 线', '90 / 40 月线');
  panelTitle(cyTop, '创业板指 K 线', mode === 'day' ? '日 K' : mode === 'week' ? '周 K' : '月 K');
  panelTitle(rTop, 'R = 创业板 ÷ 红利', '0.33 买入 · 0.52 减仓 · 0.65 清仓');

  const drawCandles = (group, yScale, prefix) => {
    group.selectAll(`.candle-wick-${prefix}`)
      .data(candles)
      .enter()
      .append('line')
      .attr('class', `candle-wick-${prefix}`)
      .attr('x1', row => x(row.date))
      .attr('x2', row => x(row.date))
      .attr('y1', row => yScale(row[`${prefix}High`]))
      .attr('y2', row => yScale(row[`${prefix}Low`]))
      .attr('stroke', row => row[prefix] >= row[`${prefix}Open`] ? 'var(--up)' : 'var(--down)')
      .attr('stroke-width', Math.max(1, Math.min(2, bodyWidth * 0.35)));
    group.selectAll(`.candle-body-${prefix}`)
      .data(candles)
      .enter()
      .append('rect')
      .attr('class', row => `candle-body-${prefix} ${row[prefix] >= row[`${prefix}Open`] ? 'candle-up' : 'candle-down'}`)
      .attr('x', row => x(row.date) - bodyWidth / 2)
      .attr('y', row => Math.min(yScale(row[prefix]), yScale(row[`${prefix}Open`])))
      .attr('width', bodyWidth)
      .attr('height', row => Math.max(1, Math.abs(yScale(row[prefix]) - yScale(row[`${prefix}Open`]))))
      .attr('stroke-width', bodyWidth < 2 ? 0.8 : 1.1);
  };

  const zzGroup = plot.append('g');
  const cyGroup = plot.append('g');
  if (state.visible.zzhl) drawCandles(zzGroup, yZz, 'zzhl');
  if (state.visible.cyb) drawCandles(cyGroup, yCy, 'cyb');

  const line = (yScale, accessor) => d3.line()
    .defined(row => Number.isFinite(accessor(row)))
    .x(row => x(row.date))
    .y(row => yScale(accessor(row)));

  if (state.visible.ma90) {
    plot.append('path')
      .datum(candles)
      .attr('class', 'series-line ma90')
      .attr('d', line(yZz, row => row.ma90));
  }
  if (state.visible.ma40) {
    plot.append('path')
      .datum(candles)
      .attr('class', 'series-line ma40')
      .attr('d', line(yZz, row => row.ma40));
  }
  if (state.visible.r) {
    plot.append('path')
      .datum(candles)
      .attr('class', 'series-line r')
      .attr('d', line(yR, row => row.r));
  }

  if (state.visible.r) {
    [0.33, 0.52, 0.65].forEach((threshold, index) => {
      const yy = yR(threshold);
      plot.append('line')
        .attr('class', 'threshold-line')
        .attr('x1', margin.left)
        .attr('x2', margin.left + innerW)
        .attr('y1', yy)
        .attr('y2', yy);
      plot.append('text')
        .attr('class', 'threshold-label')
        .attr('x', margin.left + 6)
        .attr('y', yy - 4)
        .text(['R 0.33 买入', 'R 0.52 减仓', 'R 0.65 清仓'][index]);
    });
  }

  const last = candles[candles.length - 1];
  const valueLabel = (y, value, color, label) => root.append('text')
    .attr('class', 'last-value')
    .attr('x', margin.left + innerW - 5)
    .attr('y', y - 5)
    .attr('text-anchor', 'end')
    .attr('fill', color)
    .text(`${label} ${formatValue(value)}`);
  if (state.visible.zzhl) valueLabel(yZz(last.zzhl), last.zzhl, colors.zzhl, '红利');
  if (state.visible.cyb) valueLabel(yCy(last.cyb), last.cyb, colors.cyb, '创业');
  if (state.visible.ma90) valueLabel(yZz(last.ma90), last.ma90, colors.ma90, '90月');
  if (state.visible.ma40) valueLabel(yZz(last.ma40), last.ma40, colors.ma40, '40月');
  if (state.visible.r) valueLabel(yR(last.r), last.r, colors.r, 'R');

  const crossGroup = root.append('g').attr('class', 'hover-layer');
  const guide = crossGroup.append('line')
    .attr('class', 'hover-guide')
    .attr('y1', margin.top)
    .attr('y2', bottomY)
    .style('visibility', 'hidden');
  const hoverDots = {
    zzhl: crossGroup.append('circle').attr('class', 'hover-dot').attr('r', 4).attr('fill', colors.zzhl).style('visibility', 'hidden'),
    cyb: crossGroup.append('circle').attr('class', 'hover-dot').attr('r', 4).attr('fill', colors.cyb).style('visibility', 'hidden'),
    r: crossGroup.append('circle').attr('class', 'hover-dot').attr('r', 4).attr('fill', colors.r).style('visibility', 'hidden')
  };

  const bisect = d3.bisector(row => row.date).center;
  const overlay = root.append('rect')
    .attr('class', 'overlay')
    .attr('x', margin.left)
    .attr('y', margin.top)
    .attr('width', innerW)
    .attr('height', bottomY - margin.top);

  const hideTooltip = () => {
    el('chartTooltip').hidden = true;
    guide.style('visibility', 'hidden');
    Object.values(hoverDots).forEach(dot => dot.style('visibility', 'hidden'));
  };

  const showTooltip = event => {
    const [px] = d3.pointer(event, overlay.node());
    const targetDate = x.invert(px);
    const index = bisect(candles, targetDate);
    const row = candles[Math.max(0, Math.min(index, candles.length - 1))];
    if (!row) return;

    guide.attr('x1', x(row.date)).attr('x2', x(row.date)).style('visibility', 'visible');
    hoverDots.zzhl.attr('cx', x(row.date)).attr('cy', yZz(row.zzhl)).style('visibility', state.visible.zzhl ? 'visible' : 'hidden');
    hoverDots.cyb.attr('cx', x(row.date)).attr('cy', yCy(row.cyb)).style('visibility', state.visible.cyb ? 'visible' : 'hidden');
    hoverDots.r.attr('cx', x(row.date)).attr('cy', yR(row.r)).style('visibility', state.visible.r ? 'visible' : 'hidden');

    const tooltip = el('chartTooltip');
    tooltip.replaceChildren();
    const dateNode = document.createElement('div');
    dateNode.className = 'tooltip-date';
    dateNode.textContent = `${row.dateText} · ${mode === 'day' ? '日 K' : mode === 'week' ? '周 K' : '月 K'}`;
    tooltip.appendChild(dateNode);
    tooltip.appendChild(createKlineTooltip('中证红利', '--zzhl', row.zzhlOpen, row.zzhlHigh, row.zzhlLow, row.zzhl));
    tooltip.appendChild(createKlineTooltip('创业板指', '--cyb', row.cybOpen, row.cybHigh, row.cybLow, row.cyb));
    if (state.visible.r) tooltip.appendChild(createTooltipLine('R', Number(row.r).toFixed(4), '--r'));
    if (state.visible.ma90 && Number.isFinite(row.ma90)) tooltip.appendChild(createTooltipLine('红利 90 月线', `${formatValue(row.ma90)} 点`, '--ma90'));
    if (state.visible.ma40 && Number.isFinite(row.ma40)) tooltip.appendChild(createTooltipLine('红利 40 月线', `${formatValue(row.ma40)} 点`, '--ma40'));

    tooltip.hidden = false;
    const wrapRect = el('chartWrap').getBoundingClientRect();
    const pointerX = event.clientX - wrapRect.left;
    const pointerY = event.clientY - wrapRect.top;
    const tooltipWidth = tooltip.offsetWidth || 240;
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
