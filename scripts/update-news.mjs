#!/usr/bin/env node

import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  addBilingualNewsFields,
  fetchNewsItems,
  rankNewsItems,
} from "./update-data.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const snapshotPath = path.join(root, "data", "snapshots", "latest.json");
const outputPath = path.join(root, "public", "data.js");

async function writeAtomic(filePath, content) {
  const temporaryPath = `${filePath}.tmp`;
  await writeFile(temporaryPath, content, "utf8");
  await rename(temporaryPath, filePath);
}

async function main() {
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  const realtimeNews = await fetchNewsItems({ includeData: false });
  const generatedNews = (snapshot.news ?? []).filter((item) =>
    ["FRED", "FRED Commodities", "FAO / FRED"].includes(item.source),
  );
  const news = await addBilingualNewsFields(
    rankNewsItems([realtimeNews, generatedNews]),
  );
  const updatedAt = new Date().toISOString();

  snapshot.news = news;
  snapshot.meta.newsUpdatedAt = updatedAt;
  snapshot.meta.newsRefreshMinutes = 15;

  await writeAtomic(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  await writeAtomic(
    outputPath,
    `window.MARKET_EVENT_DATA = ${JSON.stringify(snapshot)};\n`,
  );

  console.log(
    `Updated ${news.length} news items at ${new Date(updatedAt).toLocaleString("zh-CN", {
      hour12: false,
    })}.`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
