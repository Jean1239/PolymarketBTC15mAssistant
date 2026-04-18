#!/usr/bin/env node
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const ROOT = resolve(import.meta.dirname, "..");

function parseCsv(path) {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").trim().split("\n");
  if (lines.length < 2) return [];
  const headers = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const vals = line.split(",");
    return Object.fromEntries(headers.map((h, i) => [h, vals[i]]));
  });
}

function pct(n, d) {
  return d === 0 ? "—" : ((n / d) * 100).toFixed(1) + "%";
}

function fmt(n) {
  const sign = n >= 0 ? "+" : "";
  return sign + n.toFixed(4);
}

function fmtUsd(n) {
  const sign = n >= 0 ? "+" : "";
  return sign + "$" + n.toFixed(2);
}

function analyze(trades, label) {
  if (trades.length === 0) {
    console.log(`\n── ${label} ──────────────────────────────`);
    console.log("  No trades found.");
    return;
  }

  const total = trades.length;
  const wins = trades.filter((t) => parseFloat(t.pnl) > 0).length;
  const losses = total - wins;
  const winRate = wins / total;

  const totalPnl = trades.reduce((s, t) => s + parseFloat(t.pnl), 0);
  const avgPnl = totalPnl / total;

  const winTrades = trades.filter((t) => parseFloat(t.pnl) > 0);
  const lossTrades = trades.filter((t) => parseFloat(t.pnl) <= 0);
  const avgWin = winTrades.length
    ? winTrades.reduce((s, t) => s + parseFloat(t.pnl), 0) / winTrades.length
    : 0;
  const avgLoss = lossTrades.length
    ? lossTrades.reduce((s, t) => s + parseFloat(t.pnl), 0) / lossTrades.length
    : 0;
  const profitFactor =
    avgLoss !== 0 ? Math.abs(avgWin * winTrades.length) / Math.abs(avgLoss * lossTrades.length) : Infinity;

  const byReason = {};
  for (const t of trades) {
    const r = t.exit_reason || "UNKNOWN";
    if (!byReason[r]) byReason[r] = { count: 0, pnl: 0 };
    byReason[r].count++;
    byReason[r].pnl += parseFloat(t.pnl);
  }

  const bySide = {};
  for (const t of trades) {
    const s = t.side || "UNKNOWN";
    if (!bySide[s]) bySide[s] = { count: 0, wins: 0, pnl: 0 };
    bySide[s].count++;
    bySide[s].pnl += parseFloat(t.pnl);
    if (parseFloat(t.pnl) > 0) bySide[s].wins++;
  }

  const avgDuration = trades.reduce((s, t) => s + parseInt(t.duration_s || 0), 0) / total;

  const rois = trades.map((t) => parseFloat(t.roi_pct));
  const maxWin = Math.max(...rois);
  const maxLoss = Math.min(...rois);

  // Streak
  let maxWinStreak = 0, maxLossStreak = 0, curWin = 0, curLoss = 0;
  for (const t of trades) {
    if (parseFloat(t.pnl) > 0) { curWin++; curLoss = 0; maxWinStreak = Math.max(maxWinStreak, curWin); }
    else { curLoss++; curWin = 0; maxLossStreak = Math.max(maxLossStreak, curLoss); }
  }

  // Date range
  const firstEntry = trades[0]?.entry_time?.replace("T", " ").slice(0, 16) + "Z";
  const lastExit = trades[trades.length - 1]?.exit_time?.replace("T", " ").slice(0, 16) + "Z";

  console.log(`\n${"─".repeat(50)}`);
  console.log(`  ${label}`);
  console.log(`${"─".repeat(50)}`);
  console.log(`  Period     : ${firstEntry} → ${lastExit}`);
  console.log(`  Trades     : ${total}  (wins: ${wins}, losses: ${losses})`);
  console.log(`  Win rate   : ${pct(wins, total)}`);
  console.log(`  Total PnL  : ${fmtUsd(totalPnl)}`);
  console.log(`  Avg PnL    : ${fmtUsd(avgPnl)}`);
  console.log(`  Avg win    : ${fmtUsd(avgWin)}   Avg loss: ${fmtUsd(avgLoss)}`);
  console.log(`  Profit fac : ${profitFactor === Infinity ? "∞" : profitFactor.toFixed(2)}`);
  console.log(`  Best ROI   : +${maxWin.toFixed(1)}%   Worst: ${maxLoss.toFixed(1)}%`);
  console.log(`  Avg dur    : ${Math.round(avgDuration)}s  (max win streak: ${maxWinStreak}, max loss streak: ${maxLossStreak})`);

  console.log(`\n  By exit reason:`);
  for (const [r, d] of Object.entries(byReason).sort((a, b) => b[1].count - a[1].count)) {
    console.log(`    ${r.padEnd(18)} ${String(d.count).padStart(3)} trades   PnL ${fmtUsd(d.pnl)}`);
  }

  console.log(`\n  By side:`);
  for (const [s, d] of Object.entries(bySide)) {
    console.log(`    ${s.padEnd(6)} ${d.count} trades   win rate ${pct(d.wins, d.count).padStart(6)}   PnL ${fmtUsd(d.pnl)}`);
  }
}

const trades15m = parseCsv(resolve(ROOT, "logs/dryrun_15m_trades.csv"));
const trades5m  = parseCsv(resolve(ROOT, "logs/dryrun_5m_trades.csv"));

console.log("\n╔══════════════════════════════════════════════════╗");
console.log("║     Polymarket BTC — Dry-Run Performance Report  ║");
console.log("╚══════════════════════════════════════════════════╝");

analyze(trades15m, "15-minute bot");
analyze(trades5m,  "5-minute bot");

console.log(`\n${"─".repeat(50)}\n`);
