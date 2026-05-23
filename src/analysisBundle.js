import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import * as paths from "./paths.js";

export const ANALYSIS_BUNDLE_FILES = {
  "15m": [
    { name: "dryrun_15m.csv",              kind: "csv",  absPath: paths.dryrun15m },
    { name: "dryrun_15m_trades.csv",        kind: "csv",  absPath: paths.dryrun15mTrades },
    { name: "real_15m_trades.csv",          kind: "csv",  absPath: paths.real15mTrades },
    { name: "strategy_versions_15m.json",   kind: "json", absPath: paths.strategyVersions15m },
  ],
  "5m": [
    { name: "dryrun_5m.csv",               kind: "csv",  absPath: paths.dryrun5m },
    { name: "dryrun_5m_trades.csv",         kind: "csv",  absPath: paths.dryrun5mTrades },
    { name: "real_5m_trades.csv",           kind: "csv",  absPath: paths.real5mTrades },
    { name: "strategy_versions_5m.json",    kind: "json", absPath: paths.strategyVersions5m },
  ],
};

export function summariseCsv(filePath) {
  if (!existsSync(filePath)) return null;
  const text = readFileSync(filePath, "utf8");
  const lines = text.split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) return { rows: 0, firstTs: null, lastTs: null };
  const header = lines[0].split(",");
  const tsIdx = header.findIndex((h) => /^(timestamp|entry_time|exit_time)$/.test(h.trim()));
  const dataLines = lines.slice(1);
  if (dataLines.length === 0) return { rows: 0, firstTs: null, lastTs: null };
  let firstTs = null;
  let lastTs = null;
  if (tsIdx >= 0) {
    firstTs = dataLines[0].split(",")[tsIdx] ?? null;
    lastTs = dataLines[dataLines.length - 1].split(",")[tsIdx] ?? null;
  }
  return { rows: dataLines.length, firstTs, lastTs };
}

export function summariseJson(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    const text = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return { rows: parsed.length, firstTs: null, lastTs: null };
    return { rows: null, firstTs: null, lastTs: null };
  } catch {
    return { rows: null, firstTs: null, lastTs: null };
  }
}

/**
 * @param {string} logsDir - kept for signature compatibility; no longer used internally
 * @param {string} bot - "15m" or "5m"
 * @param {string} tradeSource - "sim" or "real"
 * @returns {{ manifest: object, items: {name:string,data:Buffer,mtime:Date}[] } | { error: string, status: number }}
 */
export function buildAnalysisBundle(logsDir, bot, tradeSource = "sim") {
  if (!ANALYSIS_BUNDLE_FILES[bot]) {
    return { error: "invalid bot (expected 15m or 5m)", status: 400 };
  }
  const items = [];
  const fileEntries = [];
  const missing = [];
  for (const { name, kind, absPath } of ANALYSIS_BUNDLE_FILES[bot]) {
    // Use the canonical path from paths.js (handles sim/real/meta subdirs).
    const fp = absPath;
    if (!existsSync(fp)) {
      missing.push(name);
      continue;
    }
    const st = statSync(fp);
    const summary = kind === "csv" ? summariseCsv(fp) : summariseJson(fp);
    fileEntries.push({
      name,
      bytes: st.size,
      rows: summary?.rows ?? null,
      firstTs: summary?.firstTs ?? null,
      lastTs: summary?.lastTs ?? null,
    });
    items.push({ name, data: readFileSync(fp), mtime: st.mtime });
  }
  const manifest = {
    bot,
    generatedAt: new Date().toISOString(),
    tradeSource,
    files: fileEntries,
    missing,
  };
  items.push({
    name: "manifest.json",
    data: Buffer.from(JSON.stringify(manifest, null, 2), "utf8"),
    mtime: new Date(),
  });
  return { manifest, items };
}
