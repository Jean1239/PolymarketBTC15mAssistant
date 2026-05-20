#!/usr/bin/env node
/**
 * Audit real Polymarket cash flow vs CSV trade journal.
 *
 * Pulls the user's full /activity history from the Polymarket Data API,
 * buckets every event by type (TRADE BUY, TRADE SELL, REDEEM, SPLIT,
 * MERGE, REWARD, CONVERSION), and computes the net pUSD flow into / out
 * of the proxy wallet. Then compares with the local CSV (sum of invested
 * and exit_value) to surface the gap = real fees + slippage the CSV does
 * not see.
 *
 * Usage:
 *   node scripts/auditRealFees.js \
 *     --user 0x2E3b459a7878985810c5515C88f708a796e1e8a7 \
 *     --csv  /tmp/server-logs/real_5m_trades.csv
 *
 * --user defaults to POLYMARKET_FUNDER env var if set.
 * --csv  defaults to ./logs/real_5m_trades.csv.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const API_BASE = "https://data-api.polymarket.com";
const PAGE_SIZE = 500;

function parseArgs(argv) {
  const out = { user: process.env.POLYMARKET_FUNDER || null, csv: "./logs/real_5m_trades.csv" };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--user") out.user = argv[++i];
    else if (a === "--csv") out.csv = argv[++i];
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
    if (!res.ok) throw new Error(`activity fetch ${res.status} ${await res.text()}`);
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

async function fetchPositionsAll(user) {
  const all = [];
  let offset = 0;
  while (true) {
    const url = `${API_BASE}/positions?user=${user}&limit=${PAGE_SIZE}&offset=${offset}&sizeThreshold=0`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`positions fetch ${res.status} ${await res.text()}`);
    const page = await res.json();
    if (!Array.isArray(page) || page.length === 0) break;
    all.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return all;
}

function readCsv(file) {
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  const header = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const cols = line.split(",");
    const row = {};
    header.forEach((h, i) => { row[h] = cols[i]; });
    return row;
  });
}

function fmt(n) { return (n >= 0 ? "+" : "") + n.toFixed(4); }
function fmtMoney(n) { return (n >= 0 ? "+$" : "-$") + Math.abs(n).toFixed(2); }

async function main() {
  const { user, csv } = parseArgs(process.argv);
  console.log(`# Audit user=${user}`);
  console.log(`# CSV=${path.resolve(csv)}`);
  console.log("");

  console.log("Fetching /activity (paginated)...");
  const activity = await fetchActivityAll(user);
  console.log(`  total events: ${activity.length}`);

  console.log("Fetching /positions (open)...");
  const positions = await fetchPositionsAll(user);
  console.log(`  open positions: ${positions.length}`);
  console.log("");

  // ---- bucket activity ----
  const buckets = {};
  function add(key, ev) {
    if (!buckets[key]) buckets[key] = { count: 0, usdcSize: 0, size: 0 };
    buckets[key].count++;
    buckets[key].usdcSize += Number(ev.usdcSize || 0);
    buckets[key].size += Number(ev.size || 0);
  }
  for (const ev of activity) {
    const t = ev.type || "UNKNOWN";
    const side = ev.side ? `_${ev.side}` : "";
    add(`${t}${side}`, ev);
  }
  console.log("## Activity buckets");
  const keys = Object.keys(buckets).sort();
  for (const k of keys) {
    const b = buckets[k];
    console.log(`  ${k.padEnd(20)} n=${String(b.count).padStart(5)}  Σusdc=${b.usdcSize.toFixed(4).padStart(12)}  Σsize=${b.size.toFixed(4).padStart(12)}`);
  }
  console.log("");

  // ---- compute net flow ----
  const buy = buckets["TRADE_BUY"]?.usdcSize || 0;
  const sell = buckets["TRADE_SELL"]?.usdcSize || 0;
  const redeem = buckets["REDEEM"]?.usdcSize || 0;
  const reward = buckets["REWARD"]?.usdcSize || 0;
  const split = buckets["SPLIT"]?.usdcSize || 0;
  const merge = buckets["MERGE"]?.usdcSize || 0;
  const conversion = buckets["CONVERSION"]?.usdcSize || 0;

  // SPLIT/MERGE are intra-token, don't change pUSD balance directly.
  // pUSD flow: -BUY (paid) + SELL (received) + REDEEM (claimed) + REWARD (received)
  const netFlow = -buy + sell + redeem + reward;

  console.log("## On-chain pUSD net flow (proxy wallet perspective)");
  console.log(`  - TRADE BUY (paid to maker):     ${fmtMoney(-buy)}`);
  console.log(`  + TRADE SELL (received):         ${fmtMoney(+sell)}`);
  console.log(`  + REDEEM (claimed from CTF):     ${fmtMoney(+redeem)}`);
  console.log(`  + REWARD (liquidity rewards):    ${fmtMoney(+reward)}`);
  console.log(`  ─ SPLIT (collateral → tokens):   ${fmtMoney(-split)} (intra-CTF, not real outflow)`);
  console.log(`  ─ MERGE (tokens → collateral):   ${fmtMoney(+merge)} (intra-CTF)`);
  console.log(`  ─ CONVERSION:                    ${fmtMoney(conversion)}`);
  console.log(`  --------------------------------`);
  console.log(`  NET (excluding deposits/withdrawals): ${fmtMoney(netFlow)}`);
  console.log("");

  // ---- compare with CSV ----
  const rows = readCsv(csv);
  if (rows) {
    let csvInvested = 0, csvExitValue = 0, csvPnl = 0, csvCount = 0;
    let wins = 0, losses = 0;
    for (const r of rows) {
      csvInvested += Number(r.invested || 0);
      csvExitValue += Number(r.exit_value || 0);
      csvPnl += Number(r.pnl || 0);
      csvCount++;
      if (r.exit_reason === "SETTLED_WIN") wins++;
      if (r.exit_reason === "SETTLED_LOSS") losses++;
    }
    console.log("## CSV journal");
    console.log(`  rows=${csvCount}  wins=${wins}  losses=${losses}`);
    console.log(`  Σinvested = ${fmtMoney(csvInvested)}`);
    console.log(`  Σexit_value = ${fmtMoney(csvExitValue)}`);
    console.log(`  Σpnl = ${fmtMoney(csvPnl)}`);
    console.log("");

    // CSV says: paid `invested`, got `exit_value` back.
    // On-chain says: paid `buy`, got `sell + redeem`.
    const onChainInflow = sell + redeem + reward;
    const buyGap = buy - csvInvested;
    const exitGap = onChainInflow - csvExitValue;

    console.log("## CSV vs on-chain gap");
    console.log(`  BUY side:   on-chain paid ${fmtMoney(-buy)}   CSV invested ${fmtMoney(-csvInvested)}   diff = ${fmtMoney(-buyGap)}`);
    console.log(`               (negative diff = on-chain spent MORE than CSV — slippage/fee on entry)`);
    console.log(`  EXIT side:  on-chain got  ${fmtMoney(+onChainInflow)}   CSV exit_value ${fmtMoney(+csvExitValue)}   diff = ${fmtMoney(+exitGap)}`);
    console.log(`               (negative diff = on-chain received LESS than CSV — fee on redemption or losing tokens not redeemed)`);
    console.log("");

    const realPnl = netFlow;
    const csvNetPnl = csvPnl;
    const totalGap = realPnl - csvNetPnl;
    console.log("## Bottom line");
    console.log(`  CSV net pnl (sum of pnl column):  ${fmtMoney(csvNetPnl)}`);
    console.log(`  Real on-chain net flow:           ${fmtMoney(realPnl)}`);
    console.log(`  Hidden cost (CSV - real):         ${fmtMoney(totalGap)}`);
    console.log(`  Per-trade hidden cost:            ${fmtMoney(totalGap / Math.max(1, csvCount))}`);
  } else {
    console.log(`(CSV not found at ${csv} — skipped CSV comparison)`);
  }

  // ---- open redeemable positions ----
  const redeemable = positions.filter((p) => p.redeemable);
  const stuckWinValue = redeemable.reduce((s, p) => s + Math.max(0, Number(p.currentValue) || 0), 0);
  const stuckTokenCount = redeemable.length;
  console.log("");
  console.log("## Open / redeemable positions");
  console.log(`  total redeemable: ${stuckTokenCount}`);
  console.log(`  Σ currentValue (winners stuck): ${fmtMoney(stuckWinValue)}`);
  if (stuckTokenCount > 0) {
    console.log("  first 5:");
    for (const p of redeemable.slice(0, 5)) {
      console.log(`    ${p.slug.padEnd(38)} ${p.outcome.padEnd(5)} size=${Number(p.size).toFixed(2)} curVal=${Number(p.currentValue).toFixed(4)} pnl=${Number(p.cashPnl).toFixed(4)}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
