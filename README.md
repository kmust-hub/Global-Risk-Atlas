# 环球风险图谱 / Global Risk Atlas

Local-first dashboard for comparing US indices, Brent crude, gold, and major
China equity indices against Federal Reserve rate changes and major
armed-conflict milestones.

## Quick start

Open `public/index.html` in a browser. The bundled snapshot works without a
network connection.

To refresh the data:

```powershell
node scripts/update-data.mjs
```

The updater writes a fresh local snapshot to `public/data.js` and
`data/snapshots/latest.json`.

To expose the dashboard to other computers on the same local network:

```powershell
node scripts/serve.mjs
```

The server listens on port `4173` and prints the local and network URLs.

## Data sources

- S&P 500 history: Tencent Finance public daily data, with FRED `SP500` as a
  recent-history fallback.
- Nasdaq-100 history: FRED `NASDAQ100`.
- Brent crude history: FRED `DCOILBRENTEU`, sourced from the US Energy
  Information Administration.
- London spot gold history: Sina Finance `XAU` daily data, starting in 2006.
- China indices: Tencent Finance daily OHLC data for the Shanghai Composite,
  ChiNext, and CSI 300. They share one panel with three independent
  candlestick subplots and independent vertical scales.
- Federal Reserve target rate: FRED `DFEDTAR`, `DFEDTARU`, and `DFEDTARL`.
- Conflict milestones: curated in `data/conflicts.json`; event dates and
  source links are maintained separately from automatically fetched prices.
- Public-health milestones: curated in `data/health-events.json`, including
  SARS, H1N1, Ebola, Zika, COVID-19, and mpox emergencies.
- Financial-risk milestones: curated in `data/financial-events.json`,
  including asset bubbles, the subprime crisis, Lehman Brothers, sovereign
  debt crises, China real-estate stress, and the 2023 US banking crisis.
- Sidebar news: Federal Reserve press releases, MarketWatch top stories, UN
  News, NOAA ENSO updates, Mining.com resource headlines, FAO agriculture
  news, and FRED-generated summaries for CPI, nonfarm payroll, unemployment,
  copper, iron ore, zinc, nickel, food prices, wheat, maize, and soybeans.

Only the most recent 10 years of S&P 500 data are available from FRED because
of index licensing. Tencent Finance is used to fill the longer history, and
overlapping observations are checked against FRED. If both long-history
sources are temporarily unavailable and no previous snapshot exists, the
updater keeps the available short history rather than inventing data.

## Daily Windows task

Run the installer once:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install-task.ps1
```

The data task runs every day at 07:00 and 19:00 local time. News has a
separate task that runs every 15 minutes:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install-news-task.ps1
```

Both tasks use the machine's normal network connection.

## Chart interaction

- All primary assets and the three China indices render as candlesticks.
  Early observations without open/high/low data remain visible as close-price
  trend lines.
- Use the mouse wheel to zoom around the pointer, drag to pan, and double-click
  or use the reset button to restore the selected range.
- Each chart has its own month-range picker above the chart title. The picker
  exposes a direct year grid, so changing years does not require a nested
  browser dropdown.
- Event windows show both pre-event returns from 5, 10, and 20 trading days
  through the event day, and post-event returns for 1, 5, and 20 days.
- When opened through `scripts/serve.mjs`, the page checks for a newer data
  snapshot every minute and reloads automatically after the news task writes
  an update.

## Interpretation

Rate markers are effective dates for changes in the Federal Reserve's target
rate or target range. Conflict markers are outbreak or major-escalation
milestones, not every day of an ongoing conflict.
