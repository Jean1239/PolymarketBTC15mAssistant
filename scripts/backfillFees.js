#!/usr/bin/env node
/**
 * Backfill real fees + tx hashes + real pUSD outflow/inflow into the
 * real-trade CSV by joining each row with the Polymarket Data API /activity
 * stream.
 *
 * Why:
 *   The CLOB BUY_RES / SELL_RES response only includes the matched amounts
 *   (makingAmount + takingAmount), not the real pUSD outflow. Polymarket
 *   charges a separate taker fee that does not appear in the match payload,
 *   so the CSV `invested` value is the *gross collateral* and undercounts
 *   the real cost by `shares × feeRate × p × (1−p)` per fill. The
 *   /activity endpoint reports `usdcSize` = the real on-chain pUSD movement,
 *   which captures fee + slippage + everything else.
 *
 * What this script does:
 *   1. Paginates /activity for the proxy wallet → builds an index keyed by
 *      transactionHash and a secondary index keyed by (timestamp, slug, side,
 *      size) for rows that don't yet have a tx hash recorded.
 *   2. Reads the target CSV, finds each row's matching activity event,
 *      and patches the new fee-tracking columns
 *      (entry_fee_model, exit_fee_model, gross_pnl, entry_tx_hash,
 *       exit_tx_hash, entry_usdc_real, exit_usdc_real).
 *   3. Migrates old CSVs that lack the new columns: appends a header with
 *      the extra columns and pads each row with the missing fields.
 *   4. Writes the result back, backing up the original to
 *      logs/archive/backfill_fees_<ts>/.
 *
 * Usage:
 *   node scripts/backfillFees.js \
 *     --user 0x2E3b459a7878985810c5515C88f708a796e1e8a7 \
 *     --csv  ./logs/real_5m_trades.csv
 *   # optional: --dry  (preview, do not write)
 *
 * --user defaults to POLYMARKET_FUNDER env var.
 * --csv  defaults to ./logs/real_5m_trades.csv.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import * as paths from "../src/paths.js";
import { takerFee, DEFAULT_FEE_RATE } from "../src/fees.js";

const API_BASE = "https://data-api.polymarket.com";
const PAGE_SIZE = 500;
// Match tolerance for the fallback (timestamp, slug, side, size) join.
const TIMESTAMP_TOLERANCE_S = 90;
const SIZE_TOLERANCE = 0.01;

const NEW_COLUMNS = [
  "entry_fee_model", "exit_fee_model", "gross_pnl",
  "entry_tx_hash", "exit_tx_hash",
  "entry_usdc_real", "exit_usdc_real",
];

function parseArgs(argv) {
  const out = {
    user: process.env.POLYMARKET_FUNDER || null,
    csv: paths.real5mTrades,
    dry: false,
    feeRate: Number(process.env.TRADE_FEE_RATE ?? DEFAULT_FEE_RATE),
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--user") out.user = argv[++i];
    else if (a === "--csv") out.csv = argv[++i];
    else if (a === "--dry") out.dry = true;
    else if (a === "--fee-rate") out.feeRate = Number(argv[++i]);
  }
  if (!out.user) {
    console.error("missing --user <address> (or set POLYMARKET_FUNDER)");
    process.exit(1);
  }
  return out;
}

async function fetchActivityAll(user) {
  const all = [];
  let offset = 0;
  while (true) {
    const url = `${API_BASE}/activity?user=${user}&limit=${PAGE_SIZE}&offset=${offset}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`activity ${res.status} ${await res.text()}`);
    const page = await res.json();
    if (!Array.isArray(page) || page.length === 0) break;
    all.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    process.stderr.write(`  fetched ${all.length} events...\r`);
  }
  process.stderr.write("\n");
  return all;
}

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

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuote) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') { inQuote = false; }
      else { cur += c; }
    } else {
      if (c === ",") { out.push(cur); cur = ""; }
      else if (c === '"') { inQuote = true; }
      else { cur += c; }
    }
  }
  out.push(cur);
  return out;
}

function readCsv(file) {
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  const header = parseCsvLine(lines[0]);
  const rows = lines.slice(1).map((line) => {
    const cols = parseCsvLine(line);
    const row = {};
    header.forEach((h, i) => { row[h] = cols[i] ?? ""; });
    return row;
  });
  return { header, rows };
}

function ensureNewColumns(header) {
  const out = [...header];
  for (const col of NEW_COLUMNS) {
    if (!out.includes(col)) out.push(col);
  }
  return out;
}

function indexActivity(events) {
  // Two indices:
  //   byTx[txHash.toLowerCase()] = event
  //   byKey[`${slug}|${side}`] = [event, event, ...]  (sorted by timestamp)
  const byTx = new Map();
  const byKey = new Map();
  for (const ev of events) {
    if (ev.transactionHash) byTx.set(String(ev.transactionHash).toLowerCase(), ev);
    const side = ev.side || ev.type; // TRADE has BUY/SELL; REDEEM has type="REDEEM"
    const key = `${ev.slug}|${side}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(ev);
  }
  for (const arr of byKey.values()) arr.sort((a, b) => a.timestamp - b.timestamp);
  return { byTx, byKey };
}

function findActivityForEntry({ row, idx }) {
  // Try tx hash first (forward-tagged rows).
  const tx = (row.entry_tx_hash || "").toLowerCase();
  if (tx && idx.byTx.has(tx)) return idx.byTx.get(tx);

  // Fallback: search by (slug, side="BUY") around entry_time.
  const tsTarget = Math.floor(new Date(row.entry_time).getTime() / 1000);
  const candidates = idx.byKey.get(`${row.market_slug}|BUY`) || [];
  const shares = Number(row.shares);
  let best = null;
  let bestDelta = Infinity;
  for (const ev of candidates) {
    if (ev.type !== "TRADE") continue;
    if (Math.abs(ev.size - shares) > SIZE_TOLERANCE) continue;
    const delta = Math.abs(ev.timestamp - tsTarget);
    if (delta < bestDelta && delta <= TIMESTAMP_TOLERANCE_S) {
      best = ev;
      bestDelta = delta;
    }
  }
  return best;
}

function findActivityForExit({ row, idx }) {
  const tx = (row.exit_tx_hash || "").toLowerCase();
  if (tx && idx.byTx.has(tx)) return idx.byTx.get(tx);

  const tsTarget = Math.floor(new Date(row.exit_time).getTime() / 1000);
  const shares = Number(row.shares);
  // SETTLED_WIN: look for type=REDEEM on the same slug.
  // SETTLED_LOSS: redemption of a $0 token sometimes still emits REDEEM with
  //   usdcSize=0; otherwise nothing — leave blank.
  // TAKE_PROFIT / SIGNAL_FLIP / STOP_LOSS / TIME_DECAY: a TRADE SELL exists.
  const reason = row.exit_reason || "";
  if (reason === "SETTLED_WIN" || reason === "SETTLED_LOSS") {
    const candidates = idx.byKey.get(`${row.market_slug}|REDEEM`) || [];
    let best = null;
    let bestDelta = Infinity;
    for (const ev of candidates) {
      if (Math.abs(ev.size - shares) > 0.1) continue; // REDEEM size is full shares
      const delta = Math.abs(ev.timestamp - tsTarget);
      if (delta < bestDelta && delta <= TIMESTAMP_TOLERANCE_S * 4) {
        best = ev;
        bestDelta = delta;
      }
    }
    return best;
  }
  const candidates = idx.byKey.get(`${row.market_slug}|SELL`) || [];
  let best = null;
  let bestDelta = Infinity;
  for (const ev of candidates) {
    if (ev.type !== "TRADE") continue;
    const delta = Math.abs(ev.timestamp - tsTarget);
    if (delta < bestDelta && delta <= TIMESTAMP_TOLERANCE_S) {
      best = ev;
      bestDelta = delta;
    }
  }
  return best;
}

function backupCsv(csvPath) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archiveDir = path.join(paths.ARCHIVE_DIR, `backfill_fees_${stamp}`);
  fs.mkdirSync(archiveDir, { recursive: true });
  const dest = path.join(archiveDir, path.basename(csvPath));
  fs.copyFileSync(csvPath, dest);
  return dest;
}

async function main() {
  const args = parseArgs(process.argv);
  console.log(`# Backfill fees user=${args.user}`);
  console.log(`# CSV=${path.resolve(args.csv)}`);
  console.log(`# feeRate=${args.feeRate}`);
  console.log(`# dry=${args.dry}`);
  console.log("");

  if (!fs.existsSync(args.csv)) {
    console.error(`CSV not found: ${args.csv}`);
    process.exit(1);
  }

  console.log("Fetching /activity...");
  const events = await fetchActivityAll(args.user);
  console.log(`  events: ${events.length}`);
  const idx = indexActivity(events);

  const { header, rows } = readCsv(args.csv);
  const outHeader = ensureNewColumns(header);
  console.log(`CSV rows: ${rows.length} (header had ${header.length} cols → ${outHeader.length} cols)`);

  let entryMatched = 0, exitMatched = 0;
  let entryUsdcSum = 0, exitUsdcSum = 0;
  let entryFeeSum = 0, exitFeeSum = 0, grossPnlSum = 0;
  let feeRateEmpiricalSum = 0, feeRateEmpiricalCount = 0;

  for (const row of rows) {
    const shares = Number(row.shares) || 0;
    const entryPrice = Number(row.entry_price) || 0;
    const exitPrice = Number(row.exit_price) || 0;
    const invested = Number(row.invested) || 0;
    const exitValue = Number(row.exit_value) || 0;

    // Entry-side join.
    const entryEv = findActivityForEntry({ row, idx });
    if (entryEv) {
      entryMatched++;
      row.entry_tx_hash = entryEv.transactionHash || row.entry_tx_hash || "";
      row.entry_usdc_real = fmt(entryEv.usdcSize, 6);
      entryUsdcSum += Number(entryEv.usdcSize) || 0;
      // Empirical fee rate: feeReal / (shares × p × (1-p))
      const feeReal = Number(entryEv.usdcSize) - invested;
      const denom = shares * entryPrice * (1 - entryPrice);
      if (denom > 0 && feeReal > 0) {
        feeRateEmpiricalSum += feeReal / denom;
        feeRateEmpiricalCount++;
      }
    }

    // Exit-side join.
    const exitEv = findActivityForExit({ row, idx });
    if (exitEv) {
      exitMatched++;
      row.exit_tx_hash = exitEv.transactionHash || row.exit_tx_hash || "";
      row.exit_usdc_real = fmt(exitEv.usdcSize, 6);
      exitUsdcSum += Number(exitEv.usdcSize) || 0;
    }

    // Model fee from current feeRate (forward-compatible default).
    const entryFee = takerFee(shares, entryPrice, args.feeRate);
    const settledExit = row.exit_reason === "SETTLED_WIN" || row.exit_reason === "SETTLED_LOSS";
    const exitFee = settledExit ? 0 : takerFee(shares, exitPrice, args.feeRate);
    const grossPnl = exitValue - invested;

    if (!row.entry_fee_model) row.entry_fee_model = fmt(entryFee, 6);
    if (!row.exit_fee_model) row.exit_fee_model = fmt(exitFee, 6);
    if (!row.gross_pnl) row.gross_pnl = fmt(grossPnl, 4);

    entryFeeSum += entryFee;
    exitFeeSum += exitFee;
    grossPnlSum += grossPnl;
  }

  // Summary.
  console.log("");
  console.log(`## Match stats`);
  console.log(`  entry matched: ${entryMatched}/${rows.length}`);
  console.log(`  exit matched:  ${exitMatched}/${rows.length}`);
  console.log("");
  console.log(`## Aggregates (this CSV)`);
  console.log(`  Σ entry_fee_model (rate=${args.feeRate}): $${entryFeeSum.toFixed(4)}`);
  console.log(`  Σ exit_fee_model:                          $${exitFeeSum.toFixed(4)}`);
  console.log(`  Σ gross_pnl:                               ${grossPnlSum >= 0 ? "+" : ""}$${grossPnlSum.toFixed(4)}`);
  console.log(`  Σ entry_usdc_real (on-chain pUSD out):     $${entryUsdcSum.toFixed(4)}`);
  console.log(`  Σ exit_usdc_real  (on-chain pUSD in):      $${exitUsdcSum.toFixed(4)}`);
  console.log(`  Net on-chain flow:                         ${exitUsdcSum - entryUsdcSum >= 0 ? "+" : ""}$${(exitUsdcSum - entryUsdcSum).toFixed(4)}`);
  console.log("");
  if (feeRateEmpiricalCount > 0) {
    const avg = feeRateEmpiricalSum / feeRateEmpiricalCount;
    console.log(`## Empirical feeRate (from real /activity)`);
    console.log(`  samples: ${feeRateEmpiricalCount}`);
    console.log(`  mean feeRate: ${avg.toFixed(4)}  (current config: ${args.feeRate})`);
    if (Math.abs(avg - args.feeRate) > 0.005) {
      console.log(`  → suggest setting TRADE_FEE_RATE=${avg.toFixed(3)} (diff ${(avg - args.feeRate).toFixed(4)})`);
    } else {
      console.log(`  → current config matches reality within tolerance`);
    }
  }

  if (args.dry) {
    console.log("");
    console.log("(dry run — no files written)");
    return;
  }

  const backup = backupCsv(args.csv);
  console.log(`backup → ${backup}`);

  const out = [outHeader.join(",")];
  for (const row of rows) {
    out.push(outHeader.map((h) => csvEscape(row[h] ?? "")).join(","));
  }
  fs.writeFileSync(args.csv, out.join("\n") + "\n", "utf8");
  console.log(`wrote ${args.csv} (${rows.length} rows, ${outHeader.length} cols)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
