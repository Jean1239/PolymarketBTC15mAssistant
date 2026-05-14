/**
 * Structured CSV journal for REAL trades. Mirrors the schema of the dry-run
 * trades CSV (src/dryRun.js TRADE_JOURNAL_HEADER) so the dashboard can read
 * either file with the same parser.
 *
 * One row per completed real trade (entry + exit). Entries are buffered
 * in-memory between buy and sell; the row is written when the sell executes.
 */
import fs from "node:fs";
import path from "node:path";
import { ensureDir } from "../utils.js";

const TRADE_JOURNAL_HEADER = [
  "entry_time", "exit_time", "market_slug", "side",
  "entry_price", "exit_price", "shares", "invested",
  "exit_value", "pnl", "roi_pct", "exit_reason", "duration_s",
  "ptb_at_entry", "btc_at_entry", "btc_vs_ptb_at_entry",
  "market_up_at_entry", "market_down_at_entry",
];

function csvEscape(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replaceAll('"', '""')}"`;
  }
  return s;
}

function fmt(v, decimals = 4) {
  if (v === null || v === undefined || (typeof v === "number" && Number.isNaN(v))) return "";
  return Number(v).toFixed(decimals);
}

function ensureHeader(filePath) {
  ensureDir(path.dirname(filePath));
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, TRADE_JOURNAL_HEADER.join(",") + "\n", "utf8");
  }
}

/**
 * Factory: returns { recordEntry(ctx), recordExit(ctx) }.
 *
 * @param {string} csvPath - e.g. "./logs/real_5m_trades.csv"
 */
export function createRealTradeLogger(csvPath) {
  // Pending entry, awaiting a matching exit. One position at a time.
  let pending = null;

  function recordEntry({
    side, marketSlug, entryPrice, invested, shares,
    timestamp = Date.now(),
    ptbAtEntry = null, btcAtEntry = null,
    marketUpAtEntry = null, marketDownAtEntry = null,
  }) {
    pending = {
      side, marketSlug, entryPrice, invested, shares,
      entryTime: timestamp,
      ptbAtEntry, btcAtEntry,
      marketUpAtEntry, marketDownAtEntry,
    };
  }

  function recordExit({
    exitPrice, pnl, roi, exitReason,
    timestamp = Date.now(),
  }) {
    if (!pending) return; // exit without matching entry — ignore

    ensureHeader(csvPath);
    const e = pending;
    const exitValue = (e.shares ?? 0) * (exitPrice ?? 0);
    const durationS = e.entryTime ? Math.round((timestamp - e.entryTime) / 1000) : "";
    const btcVsPtbAtEntry = (e.btcAtEntry != null && e.ptbAtEntry != null)
      ? e.btcAtEntry - e.ptbAtEntry
      : null;

    const row = [
      new Date(e.entryTime).toISOString(),
      new Date(timestamp).toISOString(),
      e.marketSlug ?? "",
      e.side ?? "",
      fmt(e.entryPrice, 4),
      fmt(exitPrice, 4),
      fmt(e.shares, 4),
      fmt(e.invested, 2),
      fmt(exitValue, 4),
      fmt(pnl, 4),
      fmt(roi, 2),
      exitReason ?? "",
      durationS,
      fmt(e.ptbAtEntry, 2),
      fmt(e.btcAtEntry, 2),
      fmt(btcVsPtbAtEntry, 2),
      fmt(e.marketUpAtEntry, 4),
      fmt(e.marketDownAtEntry, 4),
    ].map(csvEscape).join(",");

    fs.appendFileSync(csvPath, row + "\n", "utf8");
    pending = null;
  }

  /** Drop any pending entry without writing (e.g. when the market settles before sell). */
  function clearPending() { pending = null; }

  /** Inspect the in-memory pending entry (or null if none). */
  function getPending() { return pending ? { ...pending } : null; }

  return { recordEntry, recordExit, clearPending, getPending };
}
