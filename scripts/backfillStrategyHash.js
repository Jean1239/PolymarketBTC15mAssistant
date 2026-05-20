#!/usr/bin/env node
// Backfill src/strategy/registry.js entries from STRATEGY_LOG.md and tag
// existing dryrun_{15m,5m}_trades.csv rows with config_hash.
//
// Idempotent. Use `--dry` to preview without writing.
//
// Usage:
//   node scripts/backfillStrategyHash.js
//   node scripts/backfillStrategyHash.js --bot=5m
//   node scripts/backfillStrategyHash.js --dry
//   node scripts/backfillStrategyHash.js --csv=/path/to/fake.csv --bot=15m

import fs from "node:fs";
import path from "node:path";
import { computeStrategyHash, extractStrategySubset, STRATEGY_FIELDS, STRATEGY_FIELDS_VERSION } from "../src/strategy/hash.js";
import { CONFIG as CONFIG_15M } from "../src/config.js";
import { CONFIG as CONFIG_5M } from "../src/config5m.js";

const LOG_PATH = "./STRATEGY_LOG.md";
const LOGS_DIR = "./logs";

function fail(msg) {
  process.stderr.write(`backfill: ${msg}\n`);
  process.exitCode = 1;
  throw new Error(msg);
}

function parseArgs(argv) {
  const out = { dry: false, bot: null, csv: null };
  for (const a of argv.slice(2)) {
    if (a === "--dry") out.dry = true;
    else if (a.startsWith("--bot=")) out.bot = a.slice(6);
    else if (a.startsWith("--csv=")) out.csv = a.slice(6);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Markdown parsing — extracts version anchors and the parameter values
// each block explicitly mentions. Anything not explicitly mentioned falls
// back to the current CONFIG default; the resulting registry entry is
// marked `partial: true` so the dashboard can show a badge.
// ---------------------------------------------------------------------------

function parseStrategyLog(markdown) {
  // Match headings like "## v13 — 2026-05-17" (em-dash U+2014) or ASCII dash.
  const blockHeaderRe = /^## (v\d+) [—\-] (\d{4}-\d{2}-\d{2})$/gm;
  const matches = [];
  for (const m of markdown.matchAll(blockHeaderRe)) {
    matches.push({ label: m[1], date: m[2], index: m.index });
  }
  const blocks = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : markdown.length;
    blocks.push({ label: matches[i].label, date: matches[i].date, body: markdown.slice(start, end) });
  }
  return blocks;
}

// Pulls out param values mentioned in a block body. Supports:
//   `field = value`
//   `field: value`
//   `field: from → to`     -> takes `to`
//   `field=value`
function extractParamsFromBlock(body) {
  const out = {};
  for (const field of STRATEGY_FIELDS) {
    const re = new RegExp(`\\b${field}\\b[\\s:=]+(?:[^\\n→]+→\\s*)?([^\\s,\\n]+)`);
    const found = body.match(re);
    if (!found) continue;
    const rawValue = found[1].replace(/[`*]/g, "").replace(/[.,;]+$/, "");
    out[field] = coerce(rawValue);
  }
  return out;
}

function coerce(raw) {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null" || raw === "—" || raw === "-") return null;
  if (raw.startsWith("[") && raw.endsWith("]")) {
    return raw.slice(1, -1).split(",").map(s => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  }
  const n = Number(raw);
  if (!Number.isNaN(n) && /^-?\d+(\.\d+)?$/.test(raw)) return n;
  return raw.replace(/^["']|["']$/g, "");
}

function buildEntry(block, botConfig) {
  const explicit = extractParamsFromBlock(block.body);
  const subset = extractStrategySubset(botConfig);
  for (const [k, v] of Object.entries(explicit)) subset[k] = Array.isArray(v) ? [...v].sort() : v;
  return {
    hash: computeStrategyHash(subset),
    label: block.label,
    detectedAt: `${block.date}T00:00:00.000Z`,
    fieldsVersion: STRATEGY_FIELDS_VERSION,
    config: subset,
    source: "backfill",
    partial: Object.keys(explicit).length < STRATEGY_FIELDS.length,
  };
}

// ---------------------------------------------------------------------------
// CSV tagging
// ---------------------------------------------------------------------------

function readCsv(csvPath) {
  const raw = fs.readFileSync(csvPath, "utf8");
  const lines = raw.split(/\r?\n/);
  const header = lines[0].split(",");
  const rows = lines.slice(1).filter(l => l.length > 0).map(l => parseRow(l, header));
  return { header, rows };
}

function parseRow(line, header) {
  const cells = line.split(",");
  const obj = {};
  header.forEach((h, i) => { obj[h] = cells[i] ?? ""; });
  return obj;
}

function writeCsv(csvPath, header, rows) {
  const out = [header.join(",")];
  for (const r of rows) {
    out.push(header.map(h => r[h] ?? "").join(","));
  }
  fs.writeFileSync(csvPath, out.join("\n") + "\n", "utf8");
}

function pickHashForRow(row, sortedEntries) {
  const t = row.entry_time;
  if (!t) return "unknown";
  for (let i = sortedEntries.length - 1; i >= 0; i--) {
    if (t >= sortedEntries[i].detectedAt) return sortedEntries[i].hash;
  }
  return "unknown";
}

function backupCsv(csvPath) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(LOGS_DIR, "archive", `backfill_${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, path.basename(csvPath));
  fs.copyFileSync(csvPath, dest);
  return dest;
}

function mergeRegistry(backfilled, existing) {
  const byHash = new Map();
  for (const e of backfilled) byHash.set(e.hash, e);
  for (const e of existing) {
    if (!byHash.has(e.hash)) byHash.set(e.hash, e);
  }
  return [...byHash.values()].sort((a, b) => a.detectedAt.localeCompare(b.detectedAt));
}

// ---------------------------------------------------------------------------
// Main orchestration per bot
// ---------------------------------------------------------------------------

function processBot(bot, botConfig, args) {
  console.log(`\n=== ${bot} ===`);
  if (!fs.existsSync(LOG_PATH)) fail(`STRATEGY_LOG.md not found at ${LOG_PATH}`);
  const md = fs.readFileSync(LOG_PATH, "utf8");
  const blocks = parseStrategyLog(md);
  if (blocks.length === 0) fail("no version blocks parsed from STRATEGY_LOG.md");

  const entries = blocks.map(b => buildEntry(b, botConfig));
  entries.sort((a, b) => a.detectedAt.localeCompare(b.detectedAt));

  const unknown = {
    hash: "unknown",
    label: "unknown",
    detectedAt: "0000-01-01T00:00:00.000Z",
    fieldsVersion: STRATEGY_FIELDS_VERSION,
    config: null,
    source: "backfill",
    partial: true,
  };
  const finalEntries = [unknown, ...entries];

  const registryPath = path.join(LOGS_DIR, `strategy_versions_${bot}.json`);
  console.log(`registry -> ${registryPath}`);
  for (const e of finalEntries) console.log(`  ${e.label.padEnd(8)} ${e.hash}  ${e.detectedAt}${e.partial ? "  (partial)" : ""}`);

  if (!args.dry) {
    let existing = [];
    if (fs.existsSync(registryPath)) {
      try { existing = JSON.parse(fs.readFileSync(registryPath, "utf8")); } catch { existing = []; }
    }
    const merged = mergeRegistry(finalEntries, existing);
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(registryPath, JSON.stringify(merged, null, 2) + "\n", "utf8");
  }

  const csvPath = args.csv ?? path.join(LOGS_DIR, `dryrun_${bot}_trades.csv`);
  if (!fs.existsSync(csvPath)) {
    console.log(`csv ${csvPath} not found; skipping CSV tagging`);
    return;
  }
  const { header, rows } = readCsv(csvPath);
  if (!header.includes("config_hash")) header.push("config_hash");
  let tagged = 0;
  const counts = {};
  for (const r of rows) {
    if (!r.config_hash) {
      r.config_hash = pickHashForRow(r, finalEntries.filter(e => e.hash !== "unknown"));
      tagged++;
    }
    counts[r.config_hash] = (counts[r.config_hash] ?? 0) + 1;
  }
  console.log(`csv ${csvPath}: ${rows.length} rows, ${tagged} newly tagged`);
  for (const [h, c] of Object.entries(counts)) console.log(`  ${h.padEnd(10)} ${c}`);

  if (!args.dry && tagged > 0) {
    try {
      const bak = backupCsv(csvPath);
      console.log(`  backup -> ${bak}`);
      writeCsv(csvPath, header, rows);
    } catch (err) {
      // Permission errors (e.g. CSV owned by another user) should not abort
      // the whole run — the registry is already written and the dashboard
      // can render with config_hash falling back to "unknown" via the
      // frontend default. Surface the error and continue with other bots.
      console.warn(`  WARN: CSV write skipped (${err.code ?? err.message})`);
    }
  }
}

const args = parseArgs(process.argv);
if (!args.bot || args.bot === "15m") processBot("15m", CONFIG_15M.trading, args);
if (!args.bot || args.bot === "5m") processBot("5m", CONFIG_5M.trading, args);
console.log(args.dry ? "\n(dry-run — no files written)" : "\nDone.");
