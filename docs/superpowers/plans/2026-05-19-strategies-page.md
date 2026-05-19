# Strategies Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a `/strategies` dashboard page that groups paper-trade results by an auto-detected config-hash version, with a 1D/1W/1M/All time filter, per-version metrics (P&L net, WR, PF, exit-reason and odd-band breakdowns), and a 2-version drill-down compare drawer.

**Architecture:** Bot startup computes a hash of the gates subset of `CONFIG.trading`, appends a new entry to `logs/strategy_versions_{15m,5m}.json` when the hash changes, and writes that hash into each row of `dryrun_{15m,5m}_trades.csv`. A one-shot backfill script parses `STRATEGY_LOG.md` to retro-apply v12/v13 windows and groups pre-v12 trades as `unknown`. The dashboard fetches the registry and existing trades CSV, then aggregates fully client-side (instant filter changes). Server exposes one new thin endpoint `/api/strategies/:bot`.

**Tech Stack:** Node.js ESM (Node 20+), Vite + React 19 + TanStack Router + TanStack Query, shadcn/ui (new-york), Recharts, Tailwind v4, better-auth (existing). No new runtime dependencies — uses `node:crypto`.

---

## File Structure

**Backend / bot (create):**
- `src/strategy/hash.js` — pure: STRATEGY_FIELDS list + `computeStrategyHash()` + `extractStrategySubset()`.
- `src/strategy/registry.js` — `ensureStrategyVersion()` (read/append registry JSON file), `loadRegistry()`.
- `scripts/backfillStrategyHash.js` — one-shot CLI: parse STRATEGY_LOG.md → write registry + tag CSV rows. Accepts `--dry`, `--bot=`, `--csv=` flags.
- `scripts/smokeTestStrategy.js` — `node:assert` sanity for hash module.

**Backend / bot (modify):**
- `src/dryRun.js` — add `config_hash` column to `TRADE_JOURNAL_HEADER`; accept `configHash` via factory options arg; propagate into `_logTrade`.
- `src/index.js`, `src/index5m.js` — call `ensureStrategyVersion()` once at startup, pass resulting hash into simulator factory.
- `src/logServer.js` — add `GET /api/strategies/15m|5m` handler with `buildStrategiesResponse()` + `computeConfigDiff()`.

**Dashboard (create):**
- `dashboard/src/routes/strategies.tsx` — page shell, tabs 15m/5m.
- `dashboard/src/lib/strategy-aggregate.ts` — `aggregateByVersion()`, `binByEntryPrice()`, time-window helpers.
- `dashboard/src/components/strategies/time-window-filter.tsx` — 4-chip filter.
- `dashboard/src/components/strategies/strategy-table.tsx` — N-way table with checkboxes.
- `dashboard/src/components/strategies/config-diff-popover.tsx` — popover listing `from → to`.
- `dashboard/src/components/strategies/odd-band-chart.tsx` — recharts bar chart by entry-price bin.
- `dashboard/src/components/strategies/exit-reason-chart.tsx` — recharts bar chart by exit reason.
- `dashboard/src/components/strategies/compare-drawer.tsx` — shadcn `<Sheet>` with side-by-side metrics + diff + charts.

**Dashboard (modify):**
- `dashboard/src/lib/api.ts` — extend `Trade` with `config_hash?: string`; add `StrategyVersion`, `StrategiesResponse` types; add `strategies15m()`, `strategies5m()`.
- `dashboard/src/routes/__root.tsx` — add "Strategies" sidebar nav item between Trades and Files.
- `CLAUDE.md` — document `config_hash` CSV column + `logs/strategy_versions_*.json` + `npm run backfill:strategy` + new API endpoint.
- `package.json` — add `"backfill:strategy"` npm script and (optionally) `"smoke:strategy"`.

---

## Task 1: Strategy hash module + smoke test

**Files:**
- Create: `src/strategy/hash.js`
- Create: `scripts/smokeTestStrategy.js`

- [ ] **Step 1: Write failing smoke test**

Create `scripts/smokeTestStrategy.js`:

```js
import assert from "node:assert/strict";
import {
  computeStrategyHash,
  extractStrategySubset,
  STRATEGY_FIELDS,
  STRATEGY_FIELDS_VERSION,
} from "../src/strategy/hash.js";

// 1. Hash deterministic — key order does not matter
const a = computeStrategyHash({ takeProfitPct: 20, entryMaxMarketPrice: 0.58 });
const b = computeStrategyHash({ entryMaxMarketPrice: 0.58, takeProfitPct: 20 });
assert.equal(a, b, "hash insensitive to key order");

// 2. Array values are sorted before hashing
const c = computeStrategyHash({ blockedRegimes: ["CHOP", "RANGE"] });
const d = computeStrategyHash({ blockedRegimes: ["RANGE", "CHOP"] });
assert.equal(c, d, "hash insensitive to array order");

// 3. A real change in a tracked field changes the hash
const e = computeStrategyHash({ takeProfitPct: 20 });
const f = computeStrategyHash({ takeProfitPct: 25 });
assert.notEqual(e, f, "hash changes when a tracked field changes");

// 4. extractStrategySubset filters to STRATEGY_FIELDS only — secrets never enter
const sub = extractStrategySubset({ takeProfitPct: 20, privateKey: "0xSECRET" });
assert.equal(sub.privateKey, undefined, "privateKey never enters the hash");
assert.equal(sub.takeProfitPct, 20, "tracked field survives");

// 5. STRATEGY_FIELDS_VERSION exists and is a positive integer
assert.equal(typeof STRATEGY_FIELDS_VERSION, "number");
assert.ok(STRATEGY_FIELDS_VERSION >= 1, "STRATEGY_FIELDS_VERSION >= 1");

// 6. STRATEGY_FIELDS is an array of strings
assert.ok(Array.isArray(STRATEGY_FIELDS) && STRATEGY_FIELDS.every(s => typeof s === "string"));

console.log("OK strategy hash smoke");
```

- [ ] **Step 2: Run smoke test to verify it fails**

Run: `node scripts/smokeTestStrategy.js`
Expected: import error — `Cannot find module '.../src/strategy/hash.js'`.

- [ ] **Step 3: Implement hash module**

Create `src/strategy/hash.js`:

```js
import crypto from "node:crypto";

// Canonical list of entry/exit gate fields. Changing this list breaks all
// existing hashes — bump STRATEGY_FIELDS_VERSION at the same time and treat
// the change as a migration (backfill script must be re-run).
export const STRATEGY_FIELDS_VERSION = 1;

export const STRATEGY_FIELDS = [
  "takeProfitPct", "stopLossPct", "signalFlipMinProb",
  "stopLossMinProb", "stopLossMinDurationS",
  "entryMinMarketPrice", "entryMaxMarketPrice",
  "flipCooldownS", "flipConfirmTicks",
  "disableTakeProfit", "disableStopLoss", "disableSignalFlip", "disableTimeDecay",
  "timeDecayMinLeftMin", "timeDecayMinLossPct",
  "btcVsPtbMinAbsUsd", "ptbSafeMarginUsd",
  "highConvictionMultiplier", "highConvictionMinProb",
  "highConvictionEntryMin", "highConvictionEntryMax",
  "blockedRegimes", "blockedHoursUtc",
  "feeRate",
];

// Returns an object containing ONLY the STRATEGY_FIELDS keys, in canonical
// form (arrays sorted, primitives untouched). Unknown / missing fields are
// preserved as `undefined` so that adding a new optional field does not
// silently coalesce to a default value.
export function extractStrategySubset(trading = {}) {
  const out = {};
  for (const k of STRATEGY_FIELDS) {
    const v = trading[k];
    out[k] = Array.isArray(v) ? [...v].sort() : v;
  }
  return out;
}

// Stable 8-hex-char hash of the canonical subset. Deterministic across
// processes and runs: 8 chars = 32 bits, fine for human-readable labels.
export function computeStrategyHash(trading = {}) {
  const subset = extractStrategySubset(trading);
  const keys = Object.keys(subset).sort();
  const serialized = JSON.stringify(subset, keys);
  return crypto.createHash("sha256").update(serialized).digest("hex").slice(0, 8);
}
```

- [ ] **Step 4: Run smoke test to verify it passes**

Run: `node scripts/smokeTestStrategy.js`
Expected: `OK strategy hash smoke` and exit code 0.

- [ ] **Step 5: Commit**

```bash
git add src/strategy/hash.js scripts/smokeTestStrategy.js
git commit -m "feat(strategy): hash module + smoke test for gates subset"
```

---

## Task 2: Strategy registry module

**Files:**
- Create: `src/strategy/registry.js`
- Modify: `scripts/smokeTestStrategy.js` (extend with registry tests)

- [ ] **Step 1: Extend smoke test with registry assertions**

Append to `scripts/smokeTestStrategy.js`:

```js
// --- Registry round-trip ---------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ensureStrategyVersion,
  loadRegistry,
  REGISTRY_LATEST_VERSION,
} from "../src/strategy/registry.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "strategy-smoke-"));
const regPath = path.join(tmpDir, "strategy_versions_15m.json");

const tradingA = { takeProfitPct: 20, entryMaxMarketPrice: 0.58, blockedRegimes: ["CHOP"] };
const tradingB = { takeProfitPct: 20, entryMaxMarketPrice: 0.52, blockedRegimes: ["CHOP"] };

// First call -> registry created, entry appended, returns hash + label "v1".
const r1 = ensureStrategyVersion(tradingA, { registryPath: regPath });
assert.equal(typeof r1.hash, "string", "ensureStrategyVersion returns hash");
assert.equal(r1.label, "v1", "first label is v1");
assert.equal(r1.created, true, "first call reports created=true");
assert.ok(fs.existsSync(regPath), "registry file written");

// Re-running with the same config is a no-op (no duplicate row).
const r2 = ensureStrategyVersion(tradingA, { registryPath: regPath });
assert.equal(r2.hash, r1.hash, "same config returns same hash");
assert.equal(r2.label, "v1", "label unchanged on no-op");
assert.equal(r2.created, false, "second call reports created=false");
const after2 = loadRegistry(regPath);
assert.equal(after2.length, 1, "no duplicate row appended");

// Different config -> new entry "v2".
const r3 = ensureStrategyVersion(tradingB, { registryPath: regPath });
assert.notEqual(r3.hash, r1.hash, "different config -> different hash");
assert.equal(r3.label, "v2", "next label is v2");
assert.equal(r3.created, true);
const after3 = loadRegistry(regPath);
assert.equal(after3.length, 2, "two entries now");

// REGISTRY_LATEST_VERSION exists
assert.equal(typeof REGISTRY_LATEST_VERSION, "number");

// Cleanup
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log("OK strategy registry smoke");
```

- [ ] **Step 2: Run smoke test to verify it fails**

Run: `node scripts/smokeTestStrategy.js`
Expected: import error — `Cannot find module '.../src/strategy/registry.js'`.

- [ ] **Step 3: Implement registry module**

Create `src/strategy/registry.js`:

```js
import fs from "node:fs";
import path from "node:path";
import { computeStrategyHash, extractStrategySubset, STRATEGY_FIELDS_VERSION } from "./hash.js";

export const REGISTRY_LATEST_VERSION = 1;

// Loads a registry file. Returns [] if the file does not exist.
// If the file exists but is unparseable, renames it to `.corrupt-<ts>.bak`
// and returns []. Never throws — callers can keep trading even when the
// registry is broken.
export function loadRegistry(registryPath) {
  if (!fs.existsSync(registryPath)) return [];
  try {
    const raw = fs.readFileSync(registryPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("registry root must be an array");
    return parsed;
  } catch (err) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const bak = `${registryPath}.corrupt-${stamp}.bak`;
    try { fs.renameSync(registryPath, bak); } catch { /* ignore */ }
    process.stderr.write(`[strategy] registry parse error (${err.message}); renamed to ${bak}\n`);
    return [];
  }
}

function saveRegistry(registryPath, entries) {
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(registryPath, JSON.stringify(entries, null, 2) + "\n", "utf8");
}

function nextAutoLabel(entries) {
  // "v1", "v2", ... ignoring any non-auto labels (e.g. backfilled "v12") and
  // the synthetic "unknown" bucket. Auto labels are simply the largest
  // existing "v<N>" + 1 to avoid colliding with backfilled labels.
  const nums = entries
    .map(e => /^v(\d+)$/.exec(e.label ?? ""))
    .filter(Boolean)
    .map(m => Number(m[1]));
  const max = nums.length ? Math.max(...nums) : 0;
  return `v${max + 1}`;
}

// Idempotent: if the current trading config hashes to an existing entry,
// returns that entry's hash/label without modifying the file. Otherwise
// appends a new entry and returns the new hash/label.
//
// Failures (disk full, permission denied) are logged to stderr and the
// function returns { hash, label: null, created: false, error } so callers
// can keep trading with `config_hash="unknown"` written to CSV rows.
export function ensureStrategyVersion(trading, { registryPath, source = "auto" } = {}) {
  if (!registryPath) throw new Error("registryPath is required");

  const hash = computeStrategyHash(trading);
  const subset = extractStrategySubset(trading);
  const entries = loadRegistry(registryPath);

  const existing = entries.find(e => e.hash === hash);
  if (existing) {
    return { hash, label: existing.label, created: false };
  }

  const entry = {
    hash,
    label: nextAutoLabel(entries),
    detectedAt: new Date().toISOString(),
    fieldsVersion: STRATEGY_FIELDS_VERSION,
    config: subset,
    source,
  };
  entries.push(entry);

  try {
    saveRegistry(registryPath, entries);
    return { hash, label: entry.label, created: true };
  } catch (err) {
    process.stderr.write(`[strategy] registry write failed: ${err.message}\n`);
    return { hash, label: null, created: false, error: err.message };
  }
}
```

- [ ] **Step 4: Run smoke test to verify it passes**

Run: `node scripts/smokeTestStrategy.js`
Expected: `OK strategy hash smoke` then `OK strategy registry smoke`, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add src/strategy/registry.js scripts/smokeTestStrategy.js
git commit -m "feat(strategy): version registry with idempotent append + corruption recovery"
```

---

## Task 3: Plumb config_hash through dryRun.js

**Files:**
- Modify: `src/dryRun.js`

- [ ] **Step 1: Add config_hash to TRADE_JOURNAL_HEADER**

In `src/dryRun.js`, locate `TRADE_JOURNAL_HEADER` and append `"config_hash"` as the last element. The header currently ends with `"entry_fee", "exit_fee", "gross_pnl"`. Change to:

```js
const TRADE_JOURNAL_HEADER = [
  "entry_time", "exit_time", "market_slug", "side",
  "entry_price", "exit_price", "shares", "invested",
  "exit_value", "pnl", "roi_pct", "exit_reason", "duration_s",
  "ptb_at_entry", "btc_at_entry", "btc_vs_ptb_at_entry",
  "market_up_at_entry", "market_down_at_entry",
  "entry_fee", "exit_fee", "gross_pnl",
  // Strategy versioning. Append-only — written by the simulator factory
  // from the value returned by ensureStrategyVersion() at bot startup.
  "config_hash",
];
```

- [ ] **Step 2: Accept configHash via factory options**

In `src/dryRun.js`, modify both factory functions. Replace:

```js
export function createDryRunSimulator15m(csvPath, tradingConfig = {}) {
  const config = {
    feeRate: tradingConfig.feeRate ?? DEFAULT_FEE_RATE,
    tradeAmount: tradingConfig.tradeAmount ?? 5,
    /* ... rest unchanged ... */
  };
  return createSimulator(csvPath, HEADER_15M, config, "15m");
}
```

with:

```js
export function createDryRunSimulator15m(csvPath, tradingConfig = {}, opts = {}) {
  const config = {
    feeRate: tradingConfig.feeRate ?? DEFAULT_FEE_RATE,
    tradeAmount: tradingConfig.tradeAmount ?? 5,
    /* ... rest unchanged ... */
  };
  const configHash = opts.configHash ?? "unknown";
  return createSimulator(csvPath, HEADER_15M, config, "15m", configHash);
}
```

Apply the same change to `createDryRunSimulator5m`. Pass `"5m"` as label and the same `configHash` arg.

- [ ] **Step 3: Plumb through createSimulator + _logTrade**

In `src/dryRun.js`, change the `createSimulator` signature and `_logTrade`:

```js
function createSimulator(csvPath, header, config, label = "bot", configHash = "unknown") {
  /* ... existing body unchanged ... */
```

In `_logTrade`, append `configHash` to the row array. Find the array passed to `toCsvLine([...])` inside `_logTrade` and add `configHash` as the final element:

```js
const row = toCsvLine([
  pos.entryTime ? new Date(pos.entryTime).toISOString() : "",
  /* ... existing fields ... */
  fmt(entryFee, 5),
  fmt(exitFee, 5),
  fmt(grossPnl ?? (exitValue - pos.invested), 4),
  configHash,
]);
```

- [ ] **Step 4: Syntax check**

Run: `node --check src/dryRun.js`
Expected: no output (exit code 0).

- [ ] **Step 5: Manual smoke — header round-trip**

Run:

```bash
node -e 'import("./src/dryRun.js").then(m => { console.log(typeof m.createDryRunSimulator15m === "function" ? "ok factory" : "missing factory"); });'
```

Expected: `ok factory`.

- [ ] **Step 6: Commit**

```bash
git add src/dryRun.js
git commit -m "feat(dryRun): write config_hash column for every trade journal row"
```

---

## Task 4: Wire registry into 15m and 5m bot startup

**Files:**
- Modify: `src/index.js`
- Modify: `src/index5m.js`

- [ ] **Step 1: Add ensureStrategyVersion call to 15m bot**

In `src/index.js`, find the existing import of `createDryRunSimulator15m` and add a sibling import:

```js
import { ensureStrategyVersion } from "./strategy/registry.js";
```

Find where `createDryRunSimulator15m` is invoked (search `createDryRunSimulator15m(`). Just before that call, add:

```js
const strategyVersion = ensureStrategyVersion(CONFIG.trading, {
  registryPath: "./logs/strategy_versions_15m.json",
  source: "auto",
});
if (strategyVersion.created) {
  console.error(`[strategy] new version detected: ${strategyVersion.label} (${strategyVersion.hash})`);
}
```

Change the simulator construction to pass the hash:

```js
const dryRun = createDryRunSimulator15m(
  "./logs/dryrun_15m.csv",
  CONFIG.trading,
  { configHash: strategyVersion.hash },
);
```

- [ ] **Step 2: Apply identical pattern to 5m bot**

In `src/index5m.js`, add the registry import:

```js
import { ensureStrategyVersion } from "./strategy/registry.js";
```

Before the `createDryRunSimulator5m(` call, add:

```js
const strategyVersion = ensureStrategyVersion(CONFIG.trading, {
  registryPath: "./logs/strategy_versions_5m.json",
  source: "auto",
});
if (strategyVersion.created) {
  console.error(`[strategy] new version detected: ${strategyVersion.label} (${strategyVersion.hash})`);
}
```

Change the simulator construction:

```js
const dryRun = createDryRunSimulator5m(
  "./logs/dryrun_5m.csv",
  CONFIG.trading,
  { configHash: strategyVersion.hash },
);
```

- [ ] **Step 3: Syntax check both entry points**

Run: `node --check src/index.js && node --check src/index5m.js`
Expected: no output.

- [ ] **Step 4: Smoke — write actual registry**

Run:

```bash
rm -f /tmp/test_registry_15m.json
node -e 'import("./src/strategy/registry.js").then(({ ensureStrategyVersion }) => { const r = ensureStrategyVersion({ takeProfitPct: 20, entryMaxMarketPrice: 0.58 }, { registryPath: "/tmp/test_registry_15m.json", source: "auto" }); console.log(r); });'
cat /tmp/test_registry_15m.json
```

Expected: `{ hash: "<8 hex chars>", label: "v1", created: true }` then a JSON array with one entry containing `hash`, `label: "v1"`, `detectedAt`, `fieldsVersion: 1`, `config`, `source: "auto"`.

- [ ] **Step 5: Commit**

```bash
git add src/index.js src/index5m.js
git commit -m "feat(bot): detect and persist strategy version at startup"
```

---

## Task 5: Backfill script

**Files:**
- Create: `scripts/backfillStrategyHash.js`
- Modify: `package.json` (add `backfill:strategy` script)

- [ ] **Step 1: Implement parser + writer**

Create `scripts/backfillStrategyHash.js`:

```js
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
  let m;
  while ((m = blockHeaderRe.exec(markdown)) !== null) {
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
    const re = new RegExp(`\\b${field}\\b[\\s:=]+(?:[^\\n→]+→\\s*)?([^\\s,\\n]+)`, "g");
    const m = re.exec(body);
    if (!m) continue;
    const rawValue = m[1].replace(/[\`*]/g, "").replace(/[.,;]+$/, "");
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
    const bak = backupCsv(csvPath);
    console.log(`  backup -> ${bak}`);
    writeCsv(csvPath, header, rows);
  }
}

const args = parseArgs(process.argv);
if (!args.bot || args.bot === "15m") processBot("15m", CONFIG_15M.trading, args);
if (!args.bot || args.bot === "5m") processBot("5m", CONFIG_5M.trading, args);
console.log(args.dry ? "\n(dry-run — no files written)" : "\nDone.");
```

- [ ] **Step 2: Make the script executable & verify syntax**

Run: `chmod +x scripts/backfillStrategyHash.js && node --check scripts/backfillStrategyHash.js`
Expected: no output, exit 0.

- [ ] **Step 3: Dry-run smoke**

Run: `node scripts/backfillStrategyHash.js --dry`
Expected: per-bot block listing `unknown`, `v12 <hash> 2026-05-04T...`, `v13 <hash> 2026-05-17T...` and a per-hash CSV count table. Final line: `(dry-run — no files written)`. Exit 0.

- [ ] **Step 4: Add npm script**

In `package.json`, inside `"scripts"`, add:

```json
"backfill:strategy": "node scripts/backfillStrategyHash.js",
"smoke:strategy": "node scripts/smokeTestStrategy.js"
```

Verify the file still parses:

Run: `node -e "JSON.parse(require('fs').readFileSync('package.json', 'utf8'))" && echo ok`
Expected: `ok`.

- [ ] **Step 5: Commit**

```bash
git add scripts/backfillStrategyHash.js package.json
git commit -m "feat(strategy): backfill registry + CSV from STRATEGY_LOG.md"
```

---

## Task 6: Server endpoint /api/strategies/:bot

**Files:**
- Modify: `src/logServer.js`

- [ ] **Step 1: Add registry loader + diff helper**

Open `src/logServer.js`. Find where other helpers live near the top (between the existing imports and the route handlers). Add:

```js
import path from "node:path";

function loadStrategyRegistry(bot) {
  const p = path.join(LOGS_DIR, `strategy_versions_${bot}.json`);
  if (!fs.existsSync(p)) return [];
  try {
    const arr = JSON.parse(fs.readFileSync(p, "utf8"));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return null; // sentinel for "exists but unparseable"
  }
}

function computeConfigDiff(prev, curr) {
  if (!prev || !curr) return null;
  const diff = {};
  const keys = new Set([...Object.keys(prev), ...Object.keys(curr)]);
  for (const k of keys) {
    const a = prev[k], b = curr[k];
    if (JSON.stringify(a) !== JSON.stringify(b)) diff[k] = { from: a, to: b };
  }
  return Object.keys(diff).length ? diff : null;
}

function buildStrategiesResponse(bot) {
  const raw = loadStrategyRegistry(bot);
  if (raw === null) return { error: "registry_parse_error", status: 500 };
  raw.sort((a, b) => (a.detectedAt ?? "").localeCompare(b.detectedAt ?? ""));

  let prevConfig = null;
  const versions = raw.map((v, i) => {
    const next = raw[i + 1];
    const out = {
      hash: v.hash,
      label: v.label,
      startedAt: v.detectedAt,
      endedAt: next ? next.detectedAt : null,
      source: v.source ?? "auto",
      partial: v.partial ?? false,
      fieldsVersion: v.fieldsVersion ?? 1,
      config: v.config ?? null,
      configDiff: computeConfigDiff(prevConfig, v.config),
    };
    prevConfig = v.config ?? prevConfig;
    return out;
  });

  const unknown = versions.find(v => v.hash === "unknown") ?? null;
  return {
    versions, // includes unknown if present
    unknownPeriod: unknown ? { startedAt: null, endedAt: unknown.endedAt } : null,
    backfillSource: raw.some(v => v.source === "backfill") ? "STRATEGY_LOG.md" : null,
  };
}
```

`LOGS_DIR` already exists in `logServer.js`. If `path` is already imported, do not re-import — verify with `grep "from \"node:path\"" src/logServer.js`.

- [ ] **Step 2: Register the route**

Find the existing `if (p === "/api/stats")` handler. Just above or below it (consistent with the file's pattern), add:

```js
if (p === "/api/strategies/15m" || p === "/api/strategies/5m") {
  const bot = p.endsWith("/15m") ? "15m" : "5m";
  const body = buildStrategiesResponse(bot);
  if (body.error) {
    res.writeHead(body.status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: body.error }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
  return;
}
```

- [ ] **Step 3: Syntax check**

Run: `node --check src/logServer.js`
Expected: no output.

- [ ] **Step 4: Live smoke**

If the dashboard server is running locally:

```bash
curl -s -b cookies.txt http://localhost:3000/api/strategies/15m | jq '.versions[] | {hash, label, source, partial}'
```

Expected: array of objects with the parsed labels. If the server is not running, do the static smoke instead:

```bash
node -e 'import("./src/logServer.js").then(() => console.log("ok")).catch(e => { console.error(e); process.exitCode = 1; });'
```

Expected: `ok`.

- [ ] **Step 5: Commit**

```bash
git add src/logServer.js
git commit -m "feat(server): GET /api/strategies/:bot with config diff vs previous"
```

---

## Task 7: Dashboard API types + endpoints

**Files:**
- Modify: `dashboard/src/lib/api.ts`

- [ ] **Step 1: Extend Trade with config_hash**

Open `dashboard/src/lib/api.ts`. Find the `Trade` interface. Add the new optional field:

```ts
export interface Trade {
  /* ... existing fields ... */
  config_hash?: string;
}
```

- [ ] **Step 2: Add strategy types**

After the `Trade` interface, add:

```ts
export interface StrategyVersion {
  hash: string;
  label: string;
  startedAt: string;
  endedAt: string | null;
  source: "auto" | "backfill";
  partial: boolean;
  fieldsVersion: number;
  config: Record<string, unknown> | null;
  configDiff: Record<string, { from: unknown; to: unknown }> | null;
}

export interface StrategiesResponse {
  versions: StrategyVersion[];
  unknownPeriod: { startedAt: null; endedAt: string } | null;
  backfillSource: "STRATEGY_LOG.md" | null;
}
```

- [ ] **Step 3: Add endpoints to the api object**

Find the `api` object literal. Add inside it (matching the existing arrow-function style):

```ts
strategies15m: () => get<StrategiesResponse>("/api/strategies/15m"),
strategies5m: () => get<StrategiesResponse>("/api/strategies/5m"),
```

- [ ] **Step 4: Type-check**

Run: `cd dashboard && npx tsc --noEmit && cd ..`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/lib/api.ts
git commit -m "feat(dashboard): typed API for /api/strategies + config_hash on Trade"
```

---

## Task 8: Aggregation module

**Files:**
- Create: `dashboard/src/lib/strategy-aggregate.ts`

- [ ] **Step 1: Implement aggregation**

Create `dashboard/src/lib/strategy-aggregate.ts`:

```ts
import type { Trade, StrategyVersion } from "./api";

export type TimeWindow = "1d" | "1w" | "1m" | "all";

export interface OddBand {
  label: string;
  lo: number;
  hi: number;
  count: number;
  pnl: number;
  winRate: number;
}

export interface AggregateRow {
  version: StrategyVersion;
  trades: number;
  pnlGross: number;
  pnlNet: number;
  winRate: number;
  profitFactor: number;
  avgWin: number;
  avgLoss: number;
  maxDrawdown: number;
  byExitReason: Record<string, { count: number; pnl: number }>;
  byOddBand: OddBand[];
}

// Trades earlier than the cutoff are dropped. "all" -> no cutoff.
export function computeSince(window: TimeWindow, now: Date = new Date()): Date | null {
  if (window === "all") return null;
  const d = new Date(now);
  if (window === "1d") d.setUTCDate(d.getUTCDate() - 1);
  if (window === "1w") d.setUTCDate(d.getUTCDate() - 7);
  if (window === "1m") d.setUTCMonth(d.getUTCMonth() - 1);
  return d;
}

function sumKey(rows: Trade[], key: keyof Trade): number {
  let s = 0;
  for (const r of rows) {
    const v = r[key];
    if (typeof v === "number") s += v;
  }
  return s;
}

function profitFactor(rows: Trade[]): number {
  let win = 0, loss = 0;
  for (const r of rows) {
    const v = r.pnl_net ?? r.pnl;
    if (v > 0) win += v;
    else if (v < 0) loss += -v;
  }
  if (loss === 0) return win > 0 ? Infinity : 0;
  return win / loss;
}

function avgOf(rows: Trade[], pred: (n: number) => boolean): number {
  const vals = rows.map(r => r.pnl_net ?? r.pnl).filter(pred);
  return vals.length ? vals.reduce((s, n) => s + n, 0) / vals.length : 0;
}

function maxDrawdown(rows: Trade[]): number {
  // Walk by entry_time ascending; track running cumulative and peak.
  const sorted = [...rows].sort((a, b) => a.entry_time.localeCompare(b.entry_time));
  let cum = 0, peak = 0, worst = 0;
  for (const r of sorted) {
    cum += r.pnl_net ?? r.pnl;
    peak = Math.max(peak, cum);
    worst = Math.min(worst, cum - peak);
  }
  return worst;
}

function groupExitReasons(rows: Trade[]): Record<string, { count: number; pnl: number }> {
  const out: Record<string, { count: number; pnl: number }> = {};
  for (const r of rows) {
    const key = r.exit_reason || "UNKNOWN";
    if (!out[key]) out[key] = { count: 0, pnl: 0 };
    out[key].count += 1;
    out[key].pnl += r.pnl_net ?? r.pnl;
  }
  return out;
}

// Fallback bins used when version.config is null (unknown bucket).
const FALLBACK_BINS: Array<[number, number, string]> = [
  [0,    0.40, "< 0.40"],
  [0.40, 0.42, "0.40-0.42"],
  [0.42, 0.44, "0.42-0.44"],
  [0.44, 0.46, "0.44-0.46"],
  [0.46, 0.48, "0.46-0.48"],
  [0.48, 0.50, "0.48-0.50"],
  [0.50, 0.52, "0.50-0.52"],
  [0.52, 0.54, "0.52-0.54"],
  [0.54, 0.56, "0.54-0.56"],
  [0.56, 0.58, "0.56-0.58"],
  [0.58, 0.60, "0.58-0.60"],
  [0.60, 0.62, "0.60-0.62"],
  [0.62, 1.00, "> 0.62"],
];

function bandsForVersion(version: StrategyVersion): Array<[number, number, string]> {
  const cfg = version.config;
  if (!cfg || typeof cfg.entryMinMarketPrice !== "number" || typeof cfg.entryMaxMarketPrice !== "number") {
    return FALLBACK_BINS;
  }
  const min = cfg.entryMinMarketPrice as number;
  const max = cfg.entryMaxMarketPrice as number;
  const bins: Array<[number, number, string]> = [[0, min, `< ${min.toFixed(2)}`]];
  let lo = min;
  while (lo < max) {
    const hi = Math.min(max, +(lo + 0.02).toFixed(2));
    bins.push([lo, hi, `${lo.toFixed(2)}-${hi.toFixed(2)}`]);
    lo = hi;
  }
  bins.push([max, 1, `> ${max.toFixed(2)}`]);
  return bins;
}

function binByEntryPrice(rows: Trade[], version: StrategyVersion): OddBand[] {
  const bins = bandsForVersion(version);
  return bins.map(([lo, hi, label]) => {
    const inBin = rows.filter(r => {
      const p = +r.entry_price;
      return p >= lo && p < hi;
    });
    const wins = inBin.filter(r => (r.pnl_net ?? r.pnl) > 0).length;
    const pnl = inBin.reduce((s, r) => s + (r.pnl_net ?? r.pnl), 0);
    return {
      label,
      lo,
      hi,
      count: inBin.length,
      pnl,
      winRate: inBin.length ? wins / inBin.length : 0,
    };
  });
}

export function aggregateByVersion({
  trades,
  versions,
  window,
  now,
}: {
  trades: Trade[];
  versions: StrategyVersion[];
  window: TimeWindow;
  now?: Date;
}): AggregateRow[] {
  const since = computeSince(window, now);
  const filtered = trades.filter(t => {
    if (since && new Date(t.entry_time) < since) return false;
    return true;
  });

  return versions.map(v => {
    const rows = filtered.filter(t => (t.config_hash ?? "unknown") === v.hash);
    return {
      version: v,
      trades: rows.length,
      pnlGross: sumKey(rows, "pnl"),
      pnlNet: rows.reduce((s, r) => s + (r.pnl_net ?? r.pnl), 0),
      winRate: rows.length ? rows.filter(r => (r.pnl_net ?? r.pnl) > 0).length / rows.length : 0,
      profitFactor: profitFactor(rows),
      avgWin: avgOf(rows, n => n > 0),
      avgLoss: avgOf(rows, n => n < 0),
      maxDrawdown: maxDrawdown(rows),
      byExitReason: groupExitReasons(rows),
      byOddBand: binByEntryPrice(rows, v),
    };
  });
}
```

- [ ] **Step 2: Type-check**

Run: `cd dashboard && npx tsc --noEmit && cd ..`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/lib/strategy-aggregate.ts
git commit -m "feat(dashboard): client-side aggregation by strategy version + odd bands"
```

---

## Task 9: TimeWindowFilter component

**Files:**
- Create: `dashboard/src/components/strategies/time-window-filter.tsx`

- [ ] **Step 1: Implement filter**

Create `dashboard/src/components/strategies/time-window-filter.tsx`:

```tsx
import { Button } from "@/components/ui/button"
import type { TimeWindow } from "@/lib/strategy-aggregate"

const OPTIONS: { value: TimeWindow; label: string }[] = [
  { value: "1d", label: "1D" },
  { value: "1w", label: "1W" },
  { value: "1m", label: "1M" },
  { value: "all", label: "All" },
]

export function TimeWindowFilter({
  value,
  onChange,
}: {
  value: TimeWindow
  onChange: (v: TimeWindow) => void
}) {
  return (
    <div data-slot="time-window-filter" className="inline-flex gap-1 rounded-md border border-border p-1 bg-background">
      {OPTIONS.map(opt => (
        <Button
          key={opt.value}
          size="sm"
          variant={value === opt.value ? "default" : "ghost"}
          className="h-7 px-2 text-xs"
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </Button>
      ))}
    </div>
  )
}
```

- [ ] **Step 2: Type-check**

Run: `cd dashboard && npx tsc --noEmit && cd ..`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/components/strategies/time-window-filter.tsx
git commit -m "feat(dashboard): TimeWindowFilter chips (1D/1W/1M/All)"
```

---

## Task 10: ConfigDiffPopover component

**Files:**
- Create: `dashboard/src/components/strategies/config-diff-popover.tsx`
- Create (if missing): `dashboard/src/components/ui/popover.tsx`

- [ ] **Step 1: Check if popover primitive exists**

Run: `test -f dashboard/src/components/ui/popover.tsx && echo "exists" || echo "missing"`
Expected: `exists` or `missing`.

If `missing`, create `dashboard/src/components/ui/popover.tsx` following the same Radix-import + `data-slot` pattern as `dashboard/src/components/ui/tooltip.tsx` (reference: `https://github.com/shadcn-ui/ui/tree/main/apps/www/registry/new-york-v4/ui/popover.tsx`). Verify with `npx tsc --noEmit` from the dashboard dir before continuing.

- [ ] **Step 2: Implement diff popover**

Create `dashboard/src/components/strategies/config-diff-popover.tsx`:

```tsx
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import { Diff } from "lucide-react"

type DiffMap = Record<string, { from: unknown; to: unknown }>

function renderValue(v: unknown): string {
  if (v === null) return "—"
  if (v === undefined) return "·"
  if (Array.isArray(v)) return `[${v.join(", ")}]`
  if (typeof v === "boolean") return v ? "true" : "false"
  return String(v)
}

export function ConfigDiffPopover({ diff, label }: { diff: DiffMap | null; label: string }) {
  if (!diff || Object.keys(diff).length === 0) {
    return <span className="text-muted-foreground text-xs">—</span>
  }
  const entries = Object.entries(diff)
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="icon" variant="ghost" className="h-6 w-6">
          <Diff className="h-3.5 w-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="left" className="w-80">
        <p className="text-xs text-muted-foreground mb-2">
          {label} vs previous · {entries.length} field{entries.length === 1 ? "" : "s"} changed
        </p>
        <div className="space-y-1 text-xs font-mono">
          {entries.map(([k, v]) => (
            <div key={k} className="flex items-baseline gap-2">
              <span className="text-foreground">{k}:</span>
              <span className="text-red-400 line-through decoration-red-400/40">{renderValue(v.from)}</span>
              <span className="text-muted-foreground">→</span>
              <span className="text-green-400">{renderValue(v.to)}</span>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
```

- [ ] **Step 3: Type-check**

Run: `cd dashboard && npx tsc --noEmit && cd ..`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/components/strategies/config-diff-popover.tsx dashboard/src/components/ui/popover.tsx 2>/dev/null
git commit -m "feat(dashboard): ConfigDiffPopover with from->to inline diff"
```

---

## Task 11: OddBandChart component

**Files:**
- Create: `dashboard/src/components/strategies/odd-band-chart.tsx`

- [ ] **Step 1: Implement chart**

Create `dashboard/src/components/strategies/odd-band-chart.tsx`:

```tsx
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Cell, LabelList } from "recharts"
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"
import type { OddBand } from "@/lib/strategy-aggregate"

export function OddBandChart({ bins, title }: { bins: OddBand[]; title?: string }) {
  const data = bins.map(b => ({
    label: b.label,
    pnl: +b.pnl.toFixed(2),
    count: b.count,
    wr: (b.winRate * 100).toFixed(0),
  }))

  const config = {
    pnl: { label: "P&L net", color: "hsl(142 76% 36%)" },
  }

  return (
    <div data-slot="odd-band-chart" className="space-y-1">
      {title && <p className="text-xs text-muted-foreground">{title}</p>}
      <ChartContainer config={config} className="h-44 w-full">
        <BarChart data={data} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(240 3.7% 15.9%)" />
          <XAxis dataKey="label" tick={{ fontSize: 9 }} tickLine={false} axisLine={false} interval={0} angle={-30} textAnchor="end" height={48} />
          <YAxis tick={{ fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={(v) => `$${v}`} />
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelKey="label"
                formatter={(value, _name, item) => {
                  const row = item.payload as { count: number; wr: string; pnl: number }
                  return [`$${value}  (n=${row.count}, WR=${row.wr}%)`, "P&L"]
                }}
              />
            }
          />
          <Bar dataKey="pnl" radius={3}>
            {data.map((d, i) => (
              <Cell key={i} fill={d.pnl >= 0 ? "hsl(142 76% 36%)" : "hsl(0 72% 51%)"} />
            ))}
            <LabelList dataKey="count" position="top" className="fill-muted-foreground text-[9px]" />
          </Bar>
        </BarChart>
      </ChartContainer>
    </div>
  )
}
```

- [ ] **Step 2: Type-check**

Run: `cd dashboard && npx tsc --noEmit && cd ..`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/components/strategies/odd-band-chart.tsx
git commit -m "feat(dashboard): OddBandChart by entry price"
```

---

## Task 12: ExitReasonChart component

**Files:**
- Create: `dashboard/src/components/strategies/exit-reason-chart.tsx`

- [ ] **Step 1: Implement chart**

Create `dashboard/src/components/strategies/exit-reason-chart.tsx`:

```tsx
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Cell } from "recharts"
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"

const COLORS: Record<string, string> = {
  SETTLED_WIN: "hsl(142 76% 36%)",
  SETTLED_LOSS: "hsl(0 72% 51%)",
  TAKE_PROFIT: "hsl(210 98% 48%)",
  STOP_LOSS: "hsl(38 92% 50%)",
  TIME_DECAY: "hsl(262 83% 58%)",
  SIGNAL_FLIP: "hsl(200 98% 39%)",
}

export function ExitReasonChart({
  data,
  title,
}: {
  data: Record<string, { count: number; pnl: number }>
  title?: string
}) {
  const rows = Object.entries(data)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([reason, d]) => ({ reason, count: d.count, pnl: +d.pnl.toFixed(2) }))

  const config = { count: { label: "Count" } }

  return (
    <div data-slot="exit-reason-chart" className="space-y-1">
      {title && <p className="text-xs text-muted-foreground">{title}</p>}
      <ChartContainer config={config} className="h-44 w-full">
        <BarChart data={rows} layout="vertical">
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(240 3.7% 15.9%)" horizontal={false} />
          <XAxis type="number" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
          <YAxis dataKey="reason" type="category" tick={{ fontSize: 8 }} tickLine={false} axisLine={false} width={84} />
          <ChartTooltip
            content={
              <ChartTooltipContent
                formatter={(value, _name, item) => {
                  const row = item.payload as { pnl: number }
                  return [`${value}  ($${row.pnl})`, "trades"]
                }}
              />
            }
          />
          <Bar dataKey="count" radius={3}>
            {rows.map(r => (
              <Cell key={r.reason} fill={COLORS[r.reason] ?? "hsl(240 5% 64%)"} />
            ))}
          </Bar>
        </BarChart>
      </ChartContainer>
    </div>
  )
}
```

- [ ] **Step 2: Type-check**

Run: `cd dashboard && npx tsc --noEmit && cd ..`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/components/strategies/exit-reason-chart.tsx
git commit -m "feat(dashboard): ExitReasonChart reusable across pages"
```

---

## Task 13: StrategyTable component

**Files:**
- Create: `dashboard/src/components/strategies/strategy-table.tsx`

- [ ] **Step 1: Implement table**

Create `dashboard/src/components/strategies/strategy-table.tsx`:

```tsx
import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ConfigDiffPopover } from "./config-diff-popover"
import type { AggregateRow } from "@/lib/strategy-aggregate"

function fmtPeriod(start: string, end: string | null): string {
  if (start === "0000-01-01T00:00:00.000Z") {
    return end ? `pré-${end.slice(0, 10)}` : "pré-history"
  }
  const a = start.slice(0, 10)
  const b = end ? end.slice(0, 10) : "now"
  return `${a} → ${b}`
}

function fmtNum(n: number, prefix = "", digits = 2): string {
  if (!Number.isFinite(n)) return "—"
  const sign = n > 0 ? "+" : ""
  return `${sign}${prefix}${n.toFixed(digits)}`
}

function pctNum(n: number): string {
  if (!Number.isFinite(n)) return "—"
  return `${(n * 100).toFixed(1)}%`
}

export function StrategyTable({
  rows,
  selectedHashes,
  onToggle,
}: {
  rows: AggregateRow[]
  selectedHashes: string[]
  onToggle: (hash: string) => void
}) {
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <Table className="min-w-[860px]">
        <TableHeader>
          <TableRow>
            <TableHead className="w-8"></TableHead>
            <TableHead>Version</TableHead>
            <TableHead>Period</TableHead>
            <TableHead className="text-right">Trades</TableHead>
            <TableHead className="text-right">P&L net</TableHead>
            <TableHead className="text-right">WR</TableHead>
            <TableHead className="text-right">PF</TableHead>
            <TableHead className="text-right">Max DD</TableHead>
            <TableHead>Diff</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(row => {
            const isSelected = selectedHashes.includes(row.version.hash)
            return (
              <TableRow key={row.version.hash} data-state={isSelected ? "selected" : undefined}>
                <TableCell>
                  <Checkbox
                    checked={isSelected}
                    onCheckedChange={() => onToggle(row.version.hash)}
                    aria-label={`select ${row.version.label}`}
                  />
                </TableCell>
                <TableCell className="font-mono">
                  <span>{row.version.label}</span>
                  {row.version.partial && (
                    <Badge variant="outline" className="ml-2 text-[10px] border-amber-500/40 text-amber-400">
                      partial
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                  {fmtPeriod(row.version.startedAt, row.version.endedAt)}
                </TableCell>
                <TableCell className="text-right tabular-nums">{row.trades}</TableCell>
                <TableCell className={`text-right tabular-nums font-medium ${row.pnlNet >= 0 ? "text-green-500" : "text-red-500"}`}>
                  {fmtNum(row.pnlNet, "$")}
                </TableCell>
                <TableCell className="text-right tabular-nums">{pctNum(row.winRate)}</TableCell>
                <TableCell className="text-right tabular-nums">{Number.isFinite(row.profitFactor) ? row.profitFactor.toFixed(2) : "∞"}</TableCell>
                <TableCell className="text-right tabular-nums text-red-400">{fmtNum(row.maxDrawdown, "$")}</TableCell>
                <TableCell>
                  <ConfigDiffPopover diff={row.version.configDiff} label={row.version.label} />
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}
```

- [ ] **Step 2: Type-check**

Run: `cd dashboard && npx tsc --noEmit && cd ..`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/components/strategies/strategy-table.tsx
git commit -m "feat(dashboard): StrategyTable with checkbox select + diff popover"
```

---

## Task 14: CompareDrawer component

**Files:**
- Create: `dashboard/src/components/strategies/compare-drawer.tsx`

- [ ] **Step 1: Implement drawer**

Create `dashboard/src/components/strategies/compare-drawer.tsx`:

```tsx
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { OddBandChart } from "./odd-band-chart"
import { ExitReasonChart } from "./exit-reason-chart"
import type { AggregateRow } from "@/lib/strategy-aggregate"

function fmt(n: number, prefix = ""): string {
  if (!Number.isFinite(n)) return "—"
  const sign = n > 0 ? "+" : ""
  return `${sign}${prefix}${n.toFixed(2)}`
}

function pct(n: number): string {
  if (!Number.isFinite(n)) return "—"
  return `${(n * 100).toFixed(1)}%`
}

function Metrics({ row, label }: { row: AggregateRow; label: string }) {
  return (
    <div className="space-y-1 text-sm">
      <p className="text-xs text-muted-foreground uppercase">{label}</p>
      <p>Trades: <span className="tabular-nums">{row.trades}</span></p>
      <p>P&L net: <span className={`tabular-nums font-medium ${row.pnlNet >= 0 ? "text-green-500" : "text-red-500"}`}>{fmt(row.pnlNet, "$")}</span></p>
      <p>WR: <span className="tabular-nums">{pct(row.winRate)}</span></p>
      <p>PF: <span className="tabular-nums">{Number.isFinite(row.profitFactor) ? row.profitFactor.toFixed(2) : "∞"}</span></p>
      <p>Max DD: <span className="tabular-nums text-red-400">{fmt(row.maxDrawdown, "$")}</span></p>
    </div>
  )
}

export function CompareDrawer({
  open,
  onOpenChange,
  rowA,
  rowB,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  rowA: AggregateRow | null
  rowB: AggregateRow | null
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-3xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle>
            Compare {rowA?.version.label ?? "?"} vs {rowB?.version.label ?? "?"}
          </SheetTitle>
        </SheetHeader>

        {rowA && rowB ? (
          <div className="mt-6 space-y-6">
            <div className="grid grid-cols-2 gap-6">
              <Metrics row={rowA} label={rowA.version.label} />
              <Metrics row={rowB} label={rowB.version.label} />
            </div>

            <div className="grid grid-cols-2 gap-6">
              <OddBandChart bins={rowA.byOddBand} title={`Odd band P&L — ${rowA.version.label}`} />
              <OddBandChart bins={rowB.byOddBand} title={`Odd band P&L — ${rowB.version.label}`} />
            </div>

            <div className="grid grid-cols-2 gap-6">
              <ExitReasonChart data={rowA.byExitReason} title={`Exit reasons — ${rowA.version.label}`} />
              <ExitReasonChart data={rowB.byExitReason} title={`Exit reasons — ${rowB.version.label}`} />
            </div>
          </div>
        ) : (
          <p className="text-muted-foreground mt-6 text-sm">Select exactly two versions to compare.</p>
        )}
      </SheetContent>
    </Sheet>
  )
}
```

- [ ] **Step 2: Type-check**

Run: `cd dashboard && npx tsc --noEmit && cd ..`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/components/strategies/compare-drawer.tsx
git commit -m "feat(dashboard): CompareDrawer with side-by-side metrics + charts"
```

---

## Task 15: /strategies route + sidebar nav

**Files:**
- Create: `dashboard/src/routes/strategies.tsx`
- Modify: `dashboard/src/routes/__root.tsx`
- Auto-regenerated: `dashboard/src/routeTree.gen.ts` (by Vite/TanStack Router on build)

- [ ] **Step 1: Implement page**

Create `dashboard/src/routes/strategies.tsx`:

```tsx
import { useMemo, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { GitBranch } from "lucide-react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { api, type Trade } from "@/lib/api"
import { useSelectedBot } from "@/lib/selected-bot"
import { TimeWindowFilter } from "@/components/strategies/time-window-filter"
import { StrategyTable } from "@/components/strategies/strategy-table"
import { CompareDrawer } from "@/components/strategies/compare-drawer"
import { aggregateByVersion, type TimeWindow } from "@/lib/strategy-aggregate"

export const Route = createFileRoute("/strategies")({
  component: StrategiesPage,
})

type Bot = "15m" | "5m"

function BotView({ bot }: { bot: Bot }) {
  const stratsQ = useQuery({
    queryKey: ["strategies", bot],
    queryFn: () => (bot === "15m" ? api.strategies15m() : api.strategies5m()),
    refetchInterval: 60_000,
  })
  const tradesQ = useQuery({
    queryKey: ["trades", bot],
    queryFn: () => (bot === "15m" ? api.trades15m() : api.trades5m()),
    refetchInterval: 60_000,
  })

  const [window, setWindow] = useState<TimeWindow>("all")
  const [selected, setSelected] = useState<string[]>([])
  const [drawerOpen, setDrawerOpen] = useState(false)

  const versions = stratsQ.data?.versions ?? []
  const trades: Trade[] = tradesQ.data ?? []

  const aggregated = useMemo(() => {
    if (versions.length === 0) return []
    return aggregateByVersion({ trades, versions, window })
  }, [versions, trades, window])

  function toggle(hash: string) {
    setSelected(prev => {
      if (prev.includes(hash)) return prev.filter(h => h !== hash)
      if (prev.length >= 2) return [prev[1], hash] // FIFO drop oldest
      return [...prev, hash]
    })
  }

  const rowA = aggregated.find(r => r.version.hash === selected[0]) ?? null
  const rowB = aggregated.find(r => r.version.hash === selected[1]) ?? null

  if (stratsQ.isLoading || tradesQ.isLoading) {
    return <p className="text-muted-foreground text-sm p-4">Loading…</p>
  }
  if (stratsQ.error || tradesQ.error) {
    return (
      <Card>
        <CardContent className="p-6 text-red-500 text-sm">
          Failed to load strategies.
          <Button variant="outline" size="sm" className="ml-2" onClick={() => { stratsQ.refetch(); tradesQ.refetch(); }}>
            Retry
          </Button>
        </CardContent>
      </Card>
    )
  }
  if (versions.length === 0) {
    return (
      <Card>
        <CardContent className="p-6 text-muted-foreground text-sm">
          Nenhuma estratégia detectada. Rode <code>npm start</code> ou <code>npm run backfill:strategy</code>.
        </CardContent>
      </Card>
    )
  }

  const unknownTrades = aggregated.find(r => r.version.hash === "unknown")?.trades ?? 0

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <TimeWindowFilter value={window} onChange={setWindow} />
        <Button
          variant="outline"
          size="sm"
          disabled={selected.length !== 2}
          onClick={() => setDrawerOpen(true)}
        >
          Compare {selected.length}/2
        </Button>
      </div>

      {unknownTrades > 0 && (
        <div className="text-xs text-amber-400 border border-amber-500/30 rounded-md p-2 bg-amber-500/5">
          ⚠️ {unknownTrades} trade{unknownTrades === 1 ? "" : "s"} sem versão conhecida estão agrupados em <code>unknown</code> (backfill).
        </div>
      )}

      <StrategyTable rows={aggregated} selectedHashes={selected} onToggle={toggle} />

      <CompareDrawer open={drawerOpen} onOpenChange={setDrawerOpen} rowA={rowA} rowB={rowB} />
    </div>
  )
}

function StrategiesPage() {
  const { selected, setSelected, visibleBots } = useSelectedBot()
  const show15 = visibleBots.includes("15m")
  const show5 = visibleBots.includes("5m")

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex items-center gap-2">
        <GitBranch className="h-5 w-5 shrink-0" />
        <h1 className="text-lg font-semibold">Strategies</h1>
        <span className="text-xs text-muted-foreground">refreshes every 60s</span>
      </div>

      {visibleBots.length === 0 ? (
        <p className="text-muted-foreground text-sm">Nenhum bot ativo no momento.</p>
      ) : (
        <Tabs value={selected} onValueChange={(v) => setSelected(v as Bot)}>
          <TabsList>
            {show15 && <TabsTrigger value="15m">15-minute bot</TabsTrigger>}
            {show5 && <TabsTrigger value="5m">5-minute bot</TabsTrigger>}
          </TabsList>
          {show15 && (
            <TabsContent value="15m" className="mt-4">
              <BotView bot="15m" />
            </TabsContent>
          )}
          {show5 && (
            <TabsContent value="5m" className="mt-4">
              <BotView bot="5m" />
            </TabsContent>
          )}
        </Tabs>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Add sidebar nav link**

Open `dashboard/src/routes/__root.tsx`. Find the existing sidebar nav items (Trade History / Signals / Files). Add an entry between Trades and Files, matching the existing pattern. For example:

```tsx
<Link to="/strategies" className={navLinkClass()}>
  <GitBranch className="h-4 w-4" />
  <span>Strategies</span>
</Link>
```

Add `GitBranch` to the lucide imports at the top of the file. The exact class names and structure depend on the existing implementation — preserve the surrounding pattern.

To find the exact insertion point:

```bash
grep -n "to=\"/trades\"\|to=\"/files\"" dashboard/src/routes/__root.tsx
```

Insert the new link between those two.

- [ ] **Step 3: Type-check + build**

Run: `cd dashboard && npm run build && cd ..`
Expected: build succeeds; `routeTree.gen.ts` regenerated with `/strategies`. No type errors.

- [ ] **Step 4: Manual smoke**

Start the dashboard server, log in, and navigate to `/strategies`. With no registry present yet, expect the empty-state card. After running `npm run backfill:strategy` (Task 16) and reloading, the table should populate.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/routes/strategies.tsx dashboard/src/routes/__root.tsx dashboard/src/routeTree.gen.ts
git commit -m "feat(dashboard): /strategies route with table + compare drawer"
```

---

## Task 16: Run backfill + verify end-to-end

**Files:** none modified (operations + verification).

- [ ] **Step 1: Run smoke tests**

Run: `node scripts/smokeTestStrategy.js`
Expected: both lines `OK strategy hash smoke` + `OK strategy registry smoke`, exit 0.

- [ ] **Step 2: Dry-run the backfill**

Run: `npm run backfill:strategy -- --dry`
Expected: per-bot lines listing unknown / v12 / v13 entries plus per-hash CSV count. Final line `(dry-run — no files written)`. Exit 0.

- [ ] **Step 3: Real backfill**

Run: `npm run backfill:strategy`
Expected: writes `logs/strategy_versions_15m.json`, `logs/strategy_versions_5m.json`, updates both `logs/dryrun_*_trades.csv` with the new column, backs up originals to `logs/archive/backfill_<ts>/`.

Verify:

```bash
ls logs/strategy_versions_*.json
head -1 logs/dryrun_15m_trades.csv | tr ',' '\n' | tail -5
head -1 logs/dryrun_5m_trades.csv  | tr ',' '\n' | tail -5
```

Expected: both files exist; both CSV headers end with `…,entry_fee,exit_fee,gross_pnl,config_hash`.

- [ ] **Step 4: Inspect registry**

Run: `jq '.[] | {hash, label, source, partial}' logs/strategy_versions_15m.json`
Expected: at minimum the `unknown`, `v12`, `v13` entries with `source: "backfill"` and `partial: true`.

- [ ] **Step 5: Build dashboard**

Run: `cd dashboard && npm run build && cd ..`
Expected: build succeeds, no type errors.

- [ ] **Step 6: Smoke server endpoint**

Start the bot/dashboard server (per project workflow) and:

```bash
curl -s -b cookies.txt http://localhost:3000/api/strategies/15m | jq '{versions: (.versions | length), unknownPeriod, backfillSource}'
```

Expected: `versions >= 3`, `backfillSource: "STRATEGY_LOG.md"`.

- [ ] **Step 7: Visual smoke**

Open the dashboard in a browser, log in, click "Strategies". Verify:
- Tab 15m loads with rows (v12, v13, unknown, possibly auto v14).
- Toggling 1D / 1W / 1M / All changes counts instantly (no network).
- Selecting two rows enables the "Compare" button.
- Compare drawer shows two-column metrics, two odd-band charts, two exit-reason charts.
- Diff popover lists changed fields with `from → to`.
- Repeat for 5m tab.

- [ ] **Step 8: Commit registry + CSVs (if tracked)**

```bash
git add logs/strategy_versions_15m.json logs/strategy_versions_5m.json
git status
# If logs/dryrun_*_trades.csv ARE tracked in this repo, also add them.
git commit -m "chore(strategy): initial backfilled registry for 15m + 5m"
```

---

## Task 17: Document new artifacts in CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Append documentation section**

Open `CLAUDE.md`. Find the "Output" section (lists CSV files etc.). Inside the bullet list of `./logs/...` files, after the trades CSV bullets, add:

```markdown
- `./logs/strategy_versions_15m.json` / `strategy_versions_5m.json` — append-only registry of detected strategy versions. Written by `ensureStrategyVersion()` at bot startup and by `scripts/backfillStrategyHash.js`. Schema: `[{ hash, label, detectedAt, fieldsVersion, config, source, partial? }]`.
```

In the same file find the API endpoint table (under "Dashboard server (`src/logServer.js`)"). Add a row:

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/strategies/{15m,5m}` | Returns `{ versions[], unknownPeriod, backfillSource }`. Versions include the synthetic `unknown` bucket. Auth required. |

In a separate "Strategy versioning" subsection (insert just before "Output"), add:

```markdown
### Strategy versioning (`src/strategy/`)

The bot identifies the active strategy by hashing a canonical subset of
`CONFIG.trading` (entry/exit gates only — secrets like `privateKey` are never
included). On startup `ensureStrategyVersion(CONFIG.trading, { registryPath })`
appends a new entry to `logs/strategy_versions_{15m,5m}.json` when the hash is
unseen. Each row written to `dryrun_{15m,5m}_trades.csv` carries the current
`config_hash` so the dashboard can group trades by era.

To retroactively tag old trades and populate the registry from `STRATEGY_LOG.md`:

```bash
npm run backfill:strategy            # both bots
npm run backfill:strategy -- --dry   # preview
npm run backfill:strategy -- --bot=5m
```

Trades earlier than the oldest version block parsed from `STRATEGY_LOG.md` are
grouped under the synthetic `unknown` hash. `STRATEGY_FIELDS_VERSION` in
`src/strategy/hash.js` must be bumped whenever the tracked field list changes
(re-run the backfill afterwards).
```

- [ ] **Step 2: Verify markdown still parses (no broken tables)**

Run: `head -120 CLAUDE.md`
Expected: visible new content; no malformed tables (each `|` row has a matching header divider).

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: strategy versioning + /api/strategies endpoint"
```

---

## Self-Review

**Spec coverage (each spec requirement → task):**

- Architecture (§1 spec) — Tasks 1–6 implement bot + server boundary.
- Bot-side hashing (§2) — Task 1 (hash module), Task 2 (registry), Task 3 (CSV column), Task 4 (startup wiring).
- Backfill (§3) — Task 5 + Task 16 (run + verify).
- Server endpoint (§4) — Task 6.
- Dashboard structure (§5) — Tasks 7 (api), 8 (aggregate), 9 (filter), 10 (popover), 11 (odd chart), 12 (exit chart), 13 (table), 14 (drawer), 15 (page + nav).
- Error handling (§6) — Implementations in Task 2 (registry parse-error recovery), Task 5 (backfill abort on missing log, backup before write, idempotent re-run), Task 6 (500 on parse error, empty response on missing registry), Task 15 (empty/error/zero-state UI), Task 8 (Infinity profit factor + NaN guard).
- Testing (§7) — Tasks 1–2 add smoke tests; Task 16 covers manual checklist + curl + dashboard build.
- Acceptance criteria 1–10 — covered by Tasks 15 (#1), 4 (#2), 5/16 (#3), 13/15 (#4), 9/15 (#5), 13/14/15 (#6), 10 (#7), 5 (#8), 15 (#9), 1/2 (#10).
- Out-of-scope items (real-trade CSV, /index time filter, write API, websocket, statistical CIs) — intentionally not in tasks.

**Placeholder scan:** no TBD / TODO / "similar to" markers. All code blocks contain literal code.

**Type consistency check:**
- `computeStrategyHash` / `extractStrategySubset` / `STRATEGY_FIELDS` / `STRATEGY_FIELDS_VERSION` — defined in Task 1, imported in Tasks 2, 5; names match.
- `ensureStrategyVersion({ registryPath, source })` — defined in Task 2, called in Tasks 4, 5; signature consistent.
- `aggregateByVersion({ trades, versions, window })` — defined in Task 8, called in Task 15; signature consistent.
- `AggregateRow`, `OddBand`, `TimeWindow` — defined in Task 8; consumed by Tasks 9, 13, 14.
- `StrategiesResponse`, `StrategyVersion`, `Trade.config_hash` — defined in Task 7; consumed in Task 8, 15.
- `OddBandChart bins=` / `ExitReasonChart data=` props — defined in Tasks 11, 12; consumed in Task 14 with matching prop names.
- `StrategyTable rows / selectedHashes / onToggle` — defined in Task 13; consumed in Task 15 with matching props.
- `CompareDrawer open / onOpenChange / rowA / rowB` — defined in Task 14; consumed in Task 15.
- `npm run backfill:strategy` script — registered in Task 5, used in Task 16.

All consistent.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-19-strategies-page.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
