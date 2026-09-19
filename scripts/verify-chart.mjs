#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const port = 9333;
const profileDir = await mkdtemp(path.join(tmpdir(), "market-chart-"));
const pageUrl = pathToFileURL(path.join(root, "public", "index.html")).href;

const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    "--disable-gpu",
    "--window-size=390,844",
    "--allow-file-access-from-files",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    pageUrl,
  ],
  { stdio: "ignore", windowsHide: true },
);

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function waitForTarget() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === "page");
      if (page) {
        return page;
      }
    } catch {
      // Chrome is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("Chrome debugging target did not become ready");
}

let socket;
try {
  const target = await waitForTarget();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) {
      return;
    }
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) {
      reject(new Error(message.error.message));
    } else {
      resolve(message.result);
    }
  });

  function send(method, params = {}) {
    const id = nextId;
    nextId += 1;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async function evaluate(expression) {
    const response = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.text);
    }
    return response.result.value;
  }

  await send("Runtime.enable");
  await new Promise((resolve) => setTimeout(resolve, 800));

  const activeNavigation = await evaluate(`(() => {
    document.querySelector('.side-nav a[href="#charts"]').click();
    return document.querySelector(".side-nav a.active")?.getAttribute("href");
  })()`);
  if (activeNavigation !== "#charts") {
    throw new Error("Sidebar navigation did not update the active item");
  }

  const newsState = await evaluate(`(() => {
    const track = document.querySelector("#sidebar-news-track");
    const style = getComputedStyle(track);
    return {
      count: track.querySelectorAll(".news-item").length,
      animationName: style.animationName,
      duration: style.animationDuration,
      panelDisplay: getComputedStyle(document.querySelector(".sidebar-news")).display,
      panelHeight: document.querySelector(".sidebar-news").getBoundingClientRect().height,
      categories: [...track.querySelectorAll(".news-category")]
        .map((element) => element.textContent)
    };
  })()`);
  if (
    newsState.count < 4 ||
    newsState.animationName !== "news-scroll" ||
    newsState.panelDisplay === "none" ||
    newsState.panelHeight < 100 ||
    !newsState.categories.includes("矿产资源") ||
    !newsState.categories.includes("粮食农业")
  ) {
    throw new Error("Sidebar news ticker is not initialized");
  }

  const eventTypeCoverage = await evaluate(`(() => ({
    health: document.querySelectorAll(".event-type.health").length,
    financial: document.querySelectorAll(".event-type.financial").length,
    healthFilter: Boolean(document.querySelector('[data-event-filter="health"]')),
    financialFilter: Boolean(document.querySelector('[data-event-filter="financial"]'))
  }))()`);
  if (
    !eventTypeCoverage.health ||
    !eventTypeCoverage.financial ||
    !eventTypeCoverage.healthFilter ||
    !eventTypeCoverage.financialFilter
  ) {
    throw new Error("Public-health or financial-risk events are missing");
  }

  const zoomControlLayout = await evaluate(`(() => ({
    viewportWidth: document.documentElement.clientWidth,
    groups: [...document.querySelectorAll(".chart-controls")].slice(0, 5).map((group) => {
      const rect = group.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        width: rect.width,
        buttons: [...group.querySelectorAll("button")].map((button) => ({
          text: button.textContent,
          width: button.getBoundingClientRect().width,
          visible: button.getBoundingClientRect().width > 0
        }))
      };
    })
  }))()`);
  if (
    zoomControlLayout.groups.some(
      (group) =>
        group.right > zoomControlLayout.viewportWidth ||
        group.buttons.length !== 3 ||
        group.buttons.some((button) => !button.visible),
    )
  ) {
    console.error(JSON.stringify(zoomControlLayout));
    throw new Error("Mobile chart zoom controls are clipped");
  }

  const before = hash(
    await evaluate("document.querySelector('#sp500-chart').toDataURL()"),
  );
  await evaluate(`(() => {
    const canvas = document.querySelector("#sp500-chart");
    const rect = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new WheelEvent("wheel", {
      deltaY: -320,
      clientX: rect.left + rect.width * 0.72,
      clientY: rect.top + rect.height * 0.5,
      bubbles: true,
      cancelable: true
    }));
    return true;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const zoomed = hash(
    await evaluate("document.querySelector('#sp500-chart').toDataURL()"),
  );

  await evaluate(
    "document.querySelector('[data-reset-chart=\"sp500\"]').click(); true",
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  const resetHash = hash(
    await evaluate("document.querySelector('#sp500-chart').toDataURL()"),
  );
  const chinaBefore = hash(
    await evaluate("document.querySelector('#china-chart').toDataURL()"),
  );
  await evaluate(`(() => {
    const canvas = document.querySelector("#china-chart");
    const rect = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new WheelEvent("wheel", {
      deltaY: -320,
      clientX: rect.left + rect.width * 0.68,
      clientY: rect.top + rect.height * 0.45,
      bubbles: true,
      cancelable: true
    }));
    return true;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const chinaZoomed = hash(
    await evaluate("document.querySelector('#china-chart').toDataURL()"),
  );
  await evaluate(
    "document.querySelector('[data-reset-chart=\"china\"]').click(); true",
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  const chinaResetHash = hash(
    await evaluate("document.querySelector('#china-chart').toDataURL()"),
  );

  if (before === zoomed) {
    throw new Error("Wheel zoom did not change the rendered chart");
  }
  if (before !== resetHash) {
    throw new Error("Chart reset did not restore the original viewport");
  }
  const buttonBefore = hash(
    await evaluate("document.querySelector('#sp500-chart').toDataURL()"),
  );
  await evaluate(
    "document.querySelector('[data-zoom-chart=\"sp500\"][data-zoom-direction=\"in\"]').click(); true",
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  const buttonZoomed = hash(
    await evaluate("document.querySelector('#sp500-chart').toDataURL()"),
  );
  await evaluate(
    "document.querySelector('[data-reset-chart=\"sp500\"]').click(); true",
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  const buttonResetHash = hash(
    await evaluate("document.querySelector('#sp500-chart').toDataURL()"),
  );
  if (buttonBefore === buttonZoomed || buttonBefore !== buttonResetHash) {
    throw new Error("Mobile zoom button did not update and reset the chart");
  }
  if (chinaBefore === chinaZoomed) {
    throw new Error("China chart wheel zoom did not change the rendered chart");
  }
  if (chinaBefore !== chinaResetHash) {
    throw new Error("China chart reset did not restore the original viewport");
  }

  await evaluate(`(() => {
    const setPicker = (key) => {
      const picker = document.querySelector('[data-chart-range="' + key + '"]');
      const click = (selector) => picker.querySelector(selector).click();
      click(".chart-range-toggle");
      if (picker.querySelector(".chart-range-popover").hidden) {
        throw new Error("Range picker closed immediately after opening");
      }
      click('[data-range-endpoint="start"]');
      click('[data-range-year="2026"]');
      click('[data-range-endpoint="start"]');
      click('[data-range-month="2"]');
      click('[data-range-endpoint="end"]');
      click('[data-range-year="2026"]');
      click('[data-range-month="5"]');
    };
    for (const key of ["sp500", "nasdaq100", "brent", "gold", "china"]) {
      setPicker(key);
    }
    return true;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const periodChanges = await evaluate(`({
    sp500: document.querySelector("#sp500-change-large").textContent,
    nasdaq100: document.querySelector("#nasdaq-change-large").textContent,
    brent: document.querySelector("#brent-change-large").textContent,
    gold: document.querySelector("#gold-change-large").textContent,
    shanghai: document.querySelector("#shanghai-period").textContent,
    chinext: document.querySelector("#chinext-period").textContent,
    csi300: document.querySelector("#csi300-period").textContent,
    labels: [...document.querySelectorAll(".range-change span, .china-heading-metrics em")]
      .map((element) => element.textContent)
  })`);
  if (
    Object.entries(periodChanges)
      .filter(([key]) => key !== "labels")
      .some(([, value]) => !value || value === "--")
  ) {
    throw new Error("Custom range did not update every period change");
  }
  if (periodChanges.labels.some((label) => label !== "区间涨幅")) {
    throw new Error("Period change label is missing");
  }

  console.log(
    JSON.stringify({
      wheelZoom: "passed",
      reset: "passed",
      beforeHash: before,
      zoomedHash: zoomed,
      resetHash,
      buttonBefore,
      buttonZoomed,
      buttonResetHash,
      chinaBeforeHash: chinaBefore,
      chinaZoomedHash: chinaZoomed,
      chinaResetHash,
      periodChanges,
      sidebarNavigation: activeNavigation,
      newsState,
      eventTypeCoverage,
      zoomControlLayout,
    }),
  );
} finally {
  socket?.close();
  chrome.kill();
  await Promise.race([
    new Promise((resolve) => chrome.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 1500)),
  ]);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(profileDir, { recursive: true, force: true });
      break;
    } catch (error) {
      if (attempt === 4) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}
