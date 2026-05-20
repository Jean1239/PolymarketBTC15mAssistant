# Analysis Bundle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a per-bot "analysis bundle" download (ZIP with the four data files needed for deep offline analysis) plus a Python starter script with worked examples for backtesting, indicator hit-rate, strategy comparison, and real-vs-sim fee/delay impact.

**Architecture:** New auth-gated endpoint `GET /api/analysis-bundle?bot=15m|5m` on `src/logServer.js` streams a ZIP (using the same hand-rolled ZIP code as `/api/files/zip-selected`) containing per-bot tick CSV, sim-trade CSV, real-trade CSV (when present), strategy-versions JSON, and a generated `manifest.json`. The dashboard `/files` page gains a primary button driven by the existing `useSelectedBot` hook plus a "filter to selected bot" toggle on the listing. The Python starter ships as `analysis/starter.py` in jupytext percent format (`# %%` cell markers) — opens natively in VS Code's Jupyter and converts to `.ipynb` with one command. Deviates from the spec's `.ipynb` filename for plan-time maintainability; behaviour is identical.

**Tech Stack:** Node 22, native `http` server, hand-rolled ZIP writer (CRC32 + local headers + central directory). Dashboard: React 19, TanStack Router, Tailwind v4, shadcn/ui. Notebook: Python 3.11, `pandas`, `numpy`, `matplotlib`, `seaborn`.

---

## File Structure

**Server:**
- Modify `src/logServer.js` — extract a shared `writeZipFiles(res, items)` helper from the three existing ZIP code paths; add the new `/api/analysis-bundle` route and a `buildBundleManifest(bot)` helper.

**Dashboard:**
- Modify `dashboard/src/routes/files.tsx` — add bundle download button + bot filter toggle in the page header.

**Smoke tests:**
- Create `scripts/smokeTestAnalysisBundle.js` — node:assert checks for the manifest builder and bot validation.
- Modify `package.json` — add `"smoke:bundle": "node scripts/smokeTestAnalysisBundle.js"`.

**Python analysis:**
- Create `analysis/requirements.txt`
- Create `analysis/README.md`
- Create `analysis/starter.py` (jupytext percent format)

---

## Task 1: Extract `writeZipFiles` helper

**Files:**
- Modify: `src/logServer.js`

The same ZIP-construction logic appears three times (lines ~681-745 for `/api/files/zip-selected`, ~747-796 for `/api/files/zip`). Before adding a fourth caller, factor it.

- [ ] **Step 1: Read the current `crc32buf` definition + the two duplicated ZIP blocks** to confirm signatures match.

```bash
grep -n "crc32buf\|0x04034b50\|0x02014b50\|0x06054b50" src/logServer.js
```

Expected: definition once + three appearances of each magic number.

- [ ] **Step 2: Add `writeZipFiles(res, items)` helper near `crc32buf`** (after the function definition, around line ~115).

```javascript
// items: [{ name: string, data: Buffer, modified: Date }]
// Writes local headers + payloads, central directory and EOCD to res.
// Caller is responsible for res.writeHead before calling.
function writeZipFiles(res, items) {
  const cds = [];
  let globalOffset = 0;
  for (const { name, data, modified } of items) {
    const nb = Buffer.from(name, "utf8");
    const d = new Date(modified);
    const dt = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const tm = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const crc = crc32buf(data);
    const sz = data.length;
    const localOff = globalOffset;
    const lh = Buffer.alloc(30 + nb.length);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(0, 8); lh.writeUInt16LE(tm, 10); lh.writeUInt16LE(dt, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(sz, 18); lh.writeUInt32LE(sz, 22);
    lh.writeUInt16LE(nb.length, 26); lh.writeUInt16LE(0, 28); nb.copy(lh, 30);
    res.write(lh);
    res.write(data);
    globalOffset += lh.length + sz;
    const cd = Buffer.alloc(46 + nb.length);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8); cd.writeUInt16LE(0, 10); cd.writeUInt16LE(tm, 12);
    cd.writeUInt16LE(dt, 14); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(sz, 20);
    cd.writeUInt32LE(sz, 24); cd.writeUInt16LE(nb.length, 28); cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32); cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38); cd.writeUInt32LE(localOff, 42); nb.copy(cd, 46);
    cds.push(cd);
  }
  const cdStart = globalOffset;
  for (const cd of cds) { res.write(cd); globalOffset += cd.length; }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(cds.length, 8); eocd.writeUInt16LE(cds.length, 10);
  eocd.writeUInt32LE(globalOffset - cdStart, 12); eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);
  res.end(eocd);
}
```

- [ ] **Step 3: Replace `/api/files/zip-selected` body inside the existing loop** with a call to the helper. Locate the block from `const cds = [];` through `res.end(eocd);` inside the `req.on("end", ...)` callback and replace with:

```javascript
const items = [];
for (const name of names) {
  const fp = path.join(LOGS_DIR, name);
  if (!existsSync(fp) || statSync(fp).isDirectory()) continue;
  const st = statSync(fp);
  if (st.size > ZIP_MAX_FILE_BYTES) continue;
  items.push({ name, data: readFileSync(fp), modified: st.mtime });
}
writeZipFiles(res, items);
```

- [ ] **Step 4: Replace `/api/files/zip` body** the same way. Locate the block starting at `const cds = [];` through `res.end(eocd);` and replace with:

```javascript
const items = [];
for (const { name, modified } of files) {
  const fp = path.join(LOGS_DIR, name);
  if (!existsSync(fp)) continue;
  items.push({ name, data: readFileSync(fp), modified });
}
writeZipFiles(res, items);
```

- [ ] **Step 5: Manual smoke** — run the server and download both existing ZIPs to confirm they still open.

```bash
node src/logServer.js &
sleep 2
# Use a session cookie or set AUTH_DISABLED=true in env for the test
curl -s -o /tmp/zip-all.zip http://localhost:3001/api/files/zip
unzip -l /tmp/zip-all.zip | head -5
kill %1
```

Expected: `unzip -l` lists files with non-zero sizes.

- [ ] **Step 6: Commit**

```bash
git add src/logServer.js
git commit -m "refactor(logServer): extract writeZipFiles helper from /api/files/zip{,-selected}"
```

---

## Task 2: Add `buildBundleManifest` + smoke test

**Files:**
- Modify: `src/logServer.js`
- Create: `scripts/smokeTestAnalysisBundle.js`
- Modify: `package.json`

The manifest summarises the bundle for the notebook. It needs row count + first/last timestamp per file (streaming so big CSVs don't blow up memory).

- [ ] **Step 1: Add `summariseCsv(filePath)` helper** near `parseCsv` in `src/logServer.js`. Streams the file once: counts data rows (excluding header), captures the first and last non-header row's timestamp column.

```javascript
function summariseCsv(filePath) {
  if (!existsSync(filePath)) return null;
  const text = readFileSync(filePath, "utf8");
  const lines = text.split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) return { rows: 0, firstTs: null, lastTs: null };
  const header = lines[0].split(",");
  const tsIdx = header.findIndex((h) => /^(timestamp|entry_time|exit_time)$/.test(h.trim()));
  const dataLines = lines.slice(1);
  if (dataLines.length === 0) return { rows: 0, firstTs: null, lastTs: null };
  let firstTs = null, lastTs = null;
  if (tsIdx >= 0) {
    firstTs = dataLines[0].split(",")[tsIdx] ?? null;
    lastTs = dataLines[dataLines.length - 1].split(",")[tsIdx] ?? null;
  }
  return { rows: dataLines.length, firstTs, lastTs };
}
```

- [ ] **Step 2: Add `summariseJson(filePath)` helper** below `summariseCsv`. Counts top-level array length when applicable.

```javascript
function summariseJson(filePath) {
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
```

- [ ] **Step 3: Add `buildBundleManifest(bot)` near the existing helpers** in `src/logServer.js`. Returns the manifest object plus the resolved file list ready for ZIP.

```javascript
const ANALYSIS_BUNDLE_FILES = {
  "15m": [
    { name: "dryrun_15m.csv", kind: "csv" },
    { name: "dryrun_15m_trades.csv", kind: "csv" },
    { name: "real_15m_trades.csv", kind: "csv" },
    { name: "strategy_versions_15m.json", kind: "json" },
  ],
  "5m": [
    { name: "dryrun_5m.csv", kind: "csv" },
    { name: "dryrun_5m_trades.csv", kind: "csv" },
    { name: "real_5m_trades.csv", kind: "csv" },
    { name: "strategy_versions_5m.json", kind: "json" },
  ],
};

function buildAnalysisBundle(bot) {
  if (!ANALYSIS_BUNDLE_FILES[bot]) {
    return { error: "invalid bot (expected 15m or 5m)", status: 400 };
  }
  const items = [];
  const fileEntries = [];
  const missing = [];
  for (const { name, kind } of ANALYSIS_BUNDLE_FILES[bot]) {
    const fp = path.join(LOGS_DIR, name);
    if (!existsSync(fp)) { missing.push(name); continue; }
    const st = statSync(fp);
    const summary = kind === "csv" ? summariseCsv(fp) : summariseJson(fp);
    fileEntries.push({
      name,
      bytes: st.size,
      rows: summary?.rows ?? null,
      firstTs: summary?.firstTs ?? null,
      lastTs: summary?.lastTs ?? null,
    });
    items.push({ name, data: readFileSync(fp), modified: st.mtime });
  }
  const manifest = {
    bot,
    generatedAt: new Date().toISOString(),
    tradeSource: TRADE_SOURCE,
    files: fileEntries,
    missing,
  };
  items.push({
    name: "manifest.json",
    data: Buffer.from(JSON.stringify(manifest, null, 2), "utf8"),
    modified: new Date(),
  });
  return { manifest, items };
}
```

- [ ] **Step 4: Create the smoke test** at `scripts/smokeTestAnalysisBundle.js`.

```javascript
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Smoke test for the analysis bundle helpers. The helpers read from LOGS_DIR
// which is resolved at module load, so we set it via env before importing.
const tmp = mkdtempSync(path.join(tmpdir(), "bundle-smoke-"));
process.env.LOGS_DIR = tmp;

writeFileSync(path.join(tmp, "dryrun_15m.csv"),
  "timestamp,btc_price\n2026-05-01T00:00:00Z,60000\n2026-05-01T00:00:01Z,60010\n");
writeFileSync(path.join(tmp, "dryrun_15m_trades.csv"),
  "entry_time,exit_time,pnl\n2026-05-01T00:00:00Z,2026-05-01T00:15:00Z,1.5\n");
writeFileSync(path.join(tmp, "strategy_versions_15m.json"),
  JSON.stringify([{ hash: "abc", label: "v1" }]));
// real_15m_trades.csv intentionally absent — should land in `missing`.

const { buildAnalysisBundle } = await import("../src/logServer.js");

// 1. Invalid bot returns error
const bad = buildAnalysisBundle("99m");
assert.equal(bad.status, 400, "invalid bot rejected");

// 2. Valid bot produces a manifest + file items
const out = buildAnalysisBundle("15m");
assert.ok(out.manifest, "manifest returned");
assert.equal(out.manifest.bot, "15m");
assert.deepEqual(out.manifest.missing, ["real_15m_trades.csv"]);
assert.equal(out.manifest.files.length, 3);

// 3. CSV summary captures row count + first/last timestamps
const tick = out.manifest.files.find((f) => f.name === "dryrun_15m.csv");
assert.equal(tick.rows, 2);
assert.equal(tick.firstTs, "2026-05-01T00:00:00Z");
assert.equal(tick.lastTs, "2026-05-01T00:00:01Z");

// 4. JSON summary counts top-level array entries
const reg = out.manifest.files.find((f) => f.name === "strategy_versions_15m.json");
assert.equal(reg.rows, 1);

// 5. items includes a manifest.json entry at the end
assert.equal(out.items[out.items.length - 1].name, "manifest.json");

rmSync(tmp, { recursive: true, force: true });
console.log("ok analysis-bundle smoke (5 assertions)");
```

- [ ] **Step 5: Export `buildAnalysisBundle` from `src/logServer.js`** so the smoke test can import it. Add at the end of the file:

```javascript
export { buildAnalysisBundle };
```

- [ ] **Step 6: Verify `LOGS_DIR` is overridable by env.** In `src/logServer.js`, find the line that currently defines `LOGS_DIR` (search for `const LOGS_DIR`). If it is not already reading `process.env.LOGS_DIR`, update it to:

```javascript
const LOGS_DIR = process.env.LOGS_DIR ?? path.join(process.cwd(), "logs");
```

If it already reads the env var, leave it alone.

- [ ] **Step 7: Add the npm script** to `package.json` under `"scripts"`:

```json
"smoke:bundle": "node scripts/smokeTestAnalysisBundle.js"
```

- [ ] **Step 8: Run the smoke test**

```bash
npm run smoke:bundle
```

Expected output:
```
ok analysis-bundle smoke (5 assertions)
```

- [ ] **Step 9: Commit**

```bash
git add src/logServer.js scripts/smokeTestAnalysisBundle.js package.json
git commit -m "feat(logServer): buildAnalysisBundle helper + smoke test"
```

---

## Task 3: Wire `/api/analysis-bundle` route

**Files:**
- Modify: `src/logServer.js`

- [ ] **Step 1: Add the route** in `src/logServer.js`, right after the `/api/files/zip` block (around line ~795, before `if (p === "/api/logs/clear" ...)`).

```javascript
if (p === "/api/analysis-bundle") {
  const bot = url.searchParams.get("bot");
  const result = buildAnalysisBundle(bot);
  if (result.error) {
    res.writeHead(result.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: result.error }));
    return;
  }
  const ts = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
  res.writeHead(200, {
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="polymarket-analysis-${bot}-${ts}.zip"`,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  writeZipFiles(res, result.items);
  return;
}
```

- [ ] **Step 2: Manual end-to-end test** — start the dashboard, sign in, hit the endpoint.

```bash
npm install --workspaces=false 2>/dev/null || true
node src/logServer.js &
sleep 2
# Replace BETTER_AUTH_SESSION_COOKIE with a real session cookie from your browser
curl -s -o /tmp/bundle.zip \
  -H "Cookie: better-auth.session_token=$BETTER_AUTH_SESSION_COOKIE" \
  "http://localhost:3001/api/analysis-bundle?bot=15m"
unzip -l /tmp/bundle.zip
kill %1
```

Expected: ZIP listing shows up to 4 data files + `manifest.json`. Missing files do not appear in the ZIP but are listed in `manifest.json` under `missing`.

- [ ] **Step 3: Verify the 400 response** for an invalid bot.

```bash
node src/logServer.js &
sleep 2
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Cookie: better-auth.session_token=$BETTER_AUTH_SESSION_COOKIE" \
  "http://localhost:3001/api/analysis-bundle?bot=99m"
kill %1
```

Expected: `400`.

- [ ] **Step 4: Verify the 401 response** when unauthenticated.

```bash
node src/logServer.js &
sleep 2
curl -s -o /dev/null -w "%{http_code}\n" \
  "http://localhost:3001/api/analysis-bundle?bot=15m"
kill %1
```

Expected: `401`.

- [ ] **Step 5: Commit**

```bash
git add src/logServer.js
git commit -m "feat(logServer): GET /api/analysis-bundle?bot=15m|5m"
```

---

## Task 4: Dashboard bundle button + bot filter toggle

**Files:**
- Modify: `dashboard/src/routes/files.tsx`

- [ ] **Step 1: Add imports** at the top of `dashboard/src/routes/files.tsx`. Add to the existing `lucide-react` import: `BarChart3, Filter`. Add a new import below the `api` import:

```typescript
import { useSelectedBot } from "@/lib/selected-bot"
```

The updated icon import:
```typescript
import { Download, FolderArchive, FileSpreadsheet, FileJson, FileText, AlertCircle, Package, Eye, BarChart3, Filter } from "lucide-react"
```

- [ ] **Step 2: Inside `FilesPage()`, after the existing `useQuery` call, add the selected bot + filter state.**

```typescript
const { selected: selectedBot } = useSelectedBot()
const [filterByBot, setFilterByBot] = useState(true)
```

- [ ] **Step 3: Compute the filtered list** before `included = ...`. Add:

```typescript
const filteredData = data && filterByBot
  ? data.filter((f) => {
      const n = f.name
      if (selectedBot === "15m") return n.includes("_15m") || n.includes("15m_")
      if (selectedBot === "5m") return n.includes("_5m") || n.includes("5m_")
      return true
    })
  : data
```

Then replace the references to `data` in the rendering (table body, totals counter, `allNames`) with `filteredData`. Specifically:

```typescript
const allNames = filteredData?.map((f) => f.name) ?? []
```

and in the table body:
```typescript
{filteredData.map((file) => (
  <FileRow ... />
))}
```

and the count chip near the title:
```typescript
{filteredData && (
  <span className="text-xs text-muted-foreground">
    {filteredData.length} arquivo{filteredData.length !== 1 ? "s" : ""} · {formatSize(totalSize)} total
  </span>
)}
```

Leave `included` / `excluded` / `totalSize` computed from the unfiltered `data` so the "Baixar tudo" button continues to reflect the full archive.

- [ ] **Step 4: Add the bundle download button + filter toggle** in the header `<div className="flex items-center gap-2 flex-wrap">` (the right-hand actions group). Place them before `<ClearLogsButton />`:

```tsx
<Button
  variant={filterByBot ? "secondary" : "ghost"}
  size="sm"
  onClick={() => setFilterByBot((v) => !v)}
  title={filterByBot ? "Mostrando apenas arquivos do bot selecionado" : "Mostrando todos os arquivos"}
>
  <Filter className="h-4 w-4 mr-2" />
  {filterByBot ? `Filtro: ${selectedBot}` : "Sem filtro"}
</Button>
<a
  href={`/api/analysis-bundle?bot=${selectedBot}`}
  download={`polymarket-analysis-${selectedBot}.zip`}
>
  <Button variant="default" size="sm" title="Bundle pronto para análise no Python (CSV ticks, trades sim, trades real, strategy versions, manifest)">
    <BarChart3 className="h-4 w-4 mr-2" />
    Bundle análise ({selectedBot})
  </Button>
</a>
```

- [ ] **Step 5: Build the dashboard** to catch TS errors.

```bash
cd dashboard && npm run build 2>&1 | tail -10
```

Expected: `built in <time>` with no TypeScript errors. The bundle size warning is fine.

- [ ] **Step 6: Manual UI smoke** — start the full stack, sign in, navigate to `/files`, click "Bundle análise (15m)" with the bot selector set to 15m, then switch to 5m and click again.

```bash
docker compose up -d --build dashboard
```

Expected: both downloads produce a ZIP whose name matches the selected bot. The filter toggle hides files belonging to the other bot.

- [ ] **Step 7: Commit**

```bash
git add dashboard/src/routes/files.tsx
git commit -m "feat(dashboard): analysis bundle download + per-bot file filter on /files"
```

---

## Task 5: Python scaffolding (`analysis/` directory)

**Files:**
- Create: `analysis/requirements.txt`
- Create: `analysis/README.md`

- [ ] **Step 1: Create `analysis/requirements.txt`**

```
pandas>=2.2
numpy>=1.26
matplotlib>=3.8
seaborn>=0.13
jupytext>=1.16
notebook>=7.0
```

- [ ] **Step 2: Create `analysis/README.md`**

````markdown
# Polymarket BTC Bot — Analysis Notebook

Offline Python analysis of the bot's performance.

## Setup

```bash
cd analysis
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

## Get the data

1. Open the dashboard, switch the bot selector to the bot you want to analyse (15m or 5m).
2. Go to **Files**.
3. Click **Bundle análise ({bot})**.
4. Extract the ZIP somewhere local — note the path.

The bundle contains:

| File | Purpose |
|---|---|
| `dryrun_{bot}.csv` | Per-tick log (every indicator + sim state + retroactive outcome). |
| `dryrun_{bot}_trades.csv` | Per-trade journal (with `config_hash` for strategy era). |
| `real_{bot}_trades.csv` | Live-trading journal (when present). Central to fee/delay analysis. |
| `strategy_versions_{bot}.json` | Maps each `config_hash` to its full config + label. |
| `manifest.json` | Generated metadata (row counts, date ranges, missing files). |

## Open the notebook

The starter is shipped as `starter.py` in [jupytext](https://jupytext.readthedocs.io/) percent format
(`# %%` cell markers). Two ways to use it:

**VS Code:** open `starter.py` — the Jupyter extension renders the cells natively.

**Classic Jupyter:** convert once with `jupytext`:

```bash
jupytext --to notebook starter.py
jupyter notebook starter.ipynb
```

## What the notebook covers

1. **Load** — reads the bundle and runs sanity checks.
2. **Decode strategy** — attaches a `strategy_label` to every trade.
3. **Real vs sim** — per-trade slippage, fees, PnL delta.
4. **Counterfactual backtest** — replays alternative exit configs (TP, SL, FLIP, TIME_DECAY) over historical ticks. Includes a validation cell that asserts the Python engine matches the JS engine.
5. **Indicator hit-rate** — per-bucket win-rate for each indicator.
6. **Strategy comparison** — pick two `config_hash` values, compare metrics on overlap.
7. **Fee + delay impact** — aggregated drag by hour, regime, and price band.
````

- [ ] **Step 3: Commit**

```bash
git add analysis/requirements.txt analysis/README.md
git commit -m "docs(analysis): Python scaffolding (requirements + README)"
```

---

## Task 6: `analysis/starter.py` — sections 1-3 (load, decode, real vs sim)

**Files:**
- Create: `analysis/starter.py`

- [ ] **Step 1: Create `analysis/starter.py` with the header + first three sections.**

```python
# ---
# jupyter:
#   jupytext:
#     text_representation:
#       format_name: percent
# ---

# %% [markdown]
# # Polymarket BTC Bot — Offline Analysis
#
# Edit `BUNDLE_DIR` to point at the directory where you extracted the analysis ZIP.

# %%
from __future__ import annotations
import json
from pathlib import Path

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
import seaborn as sns

sns.set_theme(style="whitegrid")
pd.set_option("display.max_columns", 60)

BUNDLE_DIR = Path("./bundle")  # <-- edit this
assert BUNDLE_DIR.exists(), f"Bundle dir not found: {BUNDLE_DIR.resolve()}"

# %% [markdown]
# ## 1. Load

# %%
manifest = json.loads((BUNDLE_DIR / "manifest.json").read_text())
BOT = manifest["bot"]
print(f"Bot: {BOT}  generatedAt: {manifest['generatedAt']}  source: {manifest['tradeSource']}")
print(f"Missing files: {manifest['missing']}")
for f in manifest["files"]:
    print(f"  {f['name']:36s}  rows={f['rows']}  {f['firstTs']} → {f['lastTs']}")

def load_csv(name: str) -> pd.DataFrame | None:
    fp = BUNDLE_DIR / name
    if not fp.exists():
        return None
    return pd.read_csv(fp)

ticks = load_csv(f"dryrun_{BOT}.csv")
sim_trades = load_csv(f"dryrun_{BOT}_trades.csv")
real_trades = load_csv(f"real_{BOT}_trades.csv")
versions = json.loads((BUNDLE_DIR / f"strategy_versions_{BOT}.json").read_text())

for df, label in [(ticks, "ticks"), (sim_trades, "sim_trades"), (real_trades, "real_trades")]:
    if df is None:
        print(f"  {label}: <missing>")
    else:
        print(f"  {label}: {len(df):,} rows, {len(df.columns)} cols")

# Parse timestamps once
for df, col in [(ticks, "timestamp"), (sim_trades, "entry_time"), (sim_trades, "exit_time"),
                (real_trades, "entry_time"), (real_trades, "exit_time")]:
    if df is not None and col in df.columns:
        df[col] = pd.to_datetime(df[col], utc=True, errors="coerce")

# %% [markdown]
# ## 2. Decode strategy
#
# Every trade row carries a `config_hash`. The strategy registry maps each hash to its full
# config + a human-readable label.

# %%
versions_df = pd.DataFrame(versions)
print(f"Strategy versions in registry: {len(versions_df)}")
print(versions_df[["hash", "label", "detectedAt"]].to_string(index=False))

def attach_label(df: pd.DataFrame) -> pd.DataFrame:
    if df is None or "config_hash" not in df.columns:
        return df
    out = df.merge(
        versions_df[["hash", "label"]].rename(columns={"hash": "config_hash", "label": "strategy_label"}),
        on="config_hash",
        how="left",
    )
    out["strategy_label"] = out["strategy_label"].fillna("unknown")
    return out

sim_trades = attach_label(sim_trades)
if real_trades is not None:
    real_trades = attach_label(real_trades)

print("\nTrades per strategy (sim):")
print(sim_trades["strategy_label"].value_counts())

# %% [markdown]
# ## 3. Real vs sim — slippage, fees, PnL delta
#
# Joins real and sim trades on `(entry_time, market_slug)`. Slippage = `real.entry_price - sim.entry_price`.
# Drag = sum of (sim.pnl - real.pnl).

# %%
if real_trades is None or real_trades.empty:
    print("No real trades in this bundle — skip section 3.")
else:
    key_cols = ["entry_time", "market_slug"]
    joined = sim_trades.merge(
        real_trades,
        on=key_cols,
        how="inner",
        suffixes=("_sim", "_real"),
    )
    joined["slippage"] = joined["entry_price_real"] - joined["entry_price_sim"]
    joined["pnl_delta"] = joined["pnl_sim"] - joined["pnl_real"]

    summary = joined[["slippage", "pnl_delta", "pnl_sim", "pnl_real"]].describe()
    print(summary)
    print(f"\nTotal sim PnL on matched trades:  {joined['pnl_sim'].sum():+.2f}")
    print(f"Total real PnL on matched trades: {joined['pnl_real'].sum():+.2f}")
    print(f"Total drag (sim - real):           {joined['pnl_delta'].sum():+.2f}")

    fig, axes = plt.subplots(1, 2, figsize=(11, 4))
    sns.histplot(joined["slippage"], bins=40, ax=axes[0])
    axes[0].set_title("Slippage distribution (real - sim entry price)")
    sns.scatterplot(data=joined, x="slippage", y="pnl_real", hue="side_real", ax=axes[1])
    axes[1].set_title("Slippage vs real PnL")
    plt.tight_layout()
```

- [ ] **Step 2: Smoke run the notebook script** with no bundle. It should fail fast at the assert.

```bash
cd analysis && python starter.py 2>&1 | head -5
```

Expected: `AssertionError: Bundle dir not found:` (this confirms the script parses and executes top-level statements).

- [ ] **Step 3: Commit**

```bash
git add analysis/starter.py
git commit -m "feat(analysis): starter notebook sections 1-3 (load, decode, real vs sim)"
```

---

## Task 7: `analysis/starter.py` — section 4 (counterfactual backtest)

**Files:**
- Modify: `analysis/starter.py`

This is the most fidelity-sensitive section. The Python `replay()` function mirrors `decide()` and `evaluateExit()` from the JS engines. A validation cell asserts the Python replay over the current strategy produces the same trade list as `dryrun_{bot}_trades.csv` — if it doesn't, all counterfactual conclusions are suspect.

The JS source to mirror lives in `src/engines/edge.js`, `src/engines/edge5m.js`, and `src/trading/position.js`. Open both side-by-side while writing the Python.

- [ ] **Step 1: Append section 4 to `analysis/starter.py`.**

```python
# %% [markdown]
# ## 4. Counterfactual backtest
#
# Replays alternative exit configurations over historical ticks. The engine mirrors
# `decide()` from `src/engines/edge.js` (or `edge5m.js`) and `evaluateExit()` from
# `src/trading/position.js`.
#
# **Validation gate:** the cell at the bottom of this section re-runs the replay with the
# CURRENT strategy and asserts the produced trade list matches `dryrun_{bot}_trades.csv`.
# If that assertion fails, the engine has drifted from the JS source — do NOT trust the
# counterfactual numbers until it is fixed.

# %%
from dataclasses import dataclass, field
from typing import Iterable

@dataclass
class StrategyCfg:
    entry_min_price: float
    entry_max_price: float
    blocked_hours_utc: tuple[int, ...] = ()
    blocked_regimes: tuple[str, ...] = ("CHOP", "RANGE")
    take_profit_pct: float = 20.0
    stop_loss_pct: float = 25.0
    signal_flip_min_prob: float = 0.58
    stop_loss_min_prob: float = 0.65
    stop_loss_min_duration_s: float = 240.0
    flip_cooldown_s: float = 60.0
    disable_take_profit: bool = False
    disable_stop_loss: bool = False
    disable_signal_flip: bool = False
    disable_time_decay: bool = False

@dataclass
class Position:
    side: str
    entry_price: float
    entry_time: pd.Timestamp
    invested: float
    shares: float
    opposite_prob_streak: int = 0

@dataclass
class TradeRow:
    entry_time: pd.Timestamp
    exit_time: pd.Timestamp
    market_slug: str
    side: str
    entry_price: float
    exit_price: float
    pnl: float
    roi_pct: float
    exit_reason: str
    duration_s: float

def _market_price(row: pd.Series, side: str) -> float:
    return float(row["market_up"] if side == "UP" else row["market_down"])

def _opposite_prob(row: pd.Series, side: str) -> float:
    return float(row["model_down"] if side == "UP" else row["model_up"])

def replay(ticks: pd.DataFrame, cfg: StrategyCfg, trade_amount: float = 5.0) -> list[TradeRow]:
    """Tick-by-tick replay. Returns the list of completed trades.

    Assumes `ticks` is sorted by timestamp and carries:
      timestamp, market_slug, time_left_min, regime (15m only), signal,
      model_up, model_down, market_up, market_down, btc_price, price_to_beat,
      btc_vs_ptb, outcome.
    """
    out: list[TradeRow] = []
    pos: Position | None = None
    cooldown_until: pd.Timestamp | None = None
    last_slug: str | None = None

    for _, row in ticks.iterrows():
        ts: pd.Timestamp = row["timestamp"]
        slug = row["market_slug"]

        # Settlement: market changed → close any open position at retroactive outcome
        if last_slug is not None and slug != last_slug and pos is not None:
            won = (row.get("outcome") == pos.side)
            exit_price = 1.0 if won else 0.0
            pnl = pos.shares * exit_price - pos.invested
            out.append(TradeRow(
                pos.entry_time, ts, last_slug, pos.side,
                pos.entry_price, exit_price, pnl,
                100 * pnl / pos.invested,
                "SETTLED_WIN" if won else "SETTLED_LOSS",
                (ts - pos.entry_time).total_seconds(),
            ))
            pos = None
            cooldown_until = None
        last_slug = slug

        # Exit checks first (matches src/trading/position.js evaluateExit ordering)
        if pos is not None:
            side = pos.side
            curr = _market_price(row, side)
            roi = 100 * (curr - pos.entry_price) / pos.entry_price
            opp = _opposite_prob(row, side)
            age_s = (ts - pos.entry_time).total_seconds()
            exit_reason: str | None = None

            if not cfg.disable_take_profit and roi >= cfg.take_profit_pct and opp >= cfg.signal_flip_min_prob:
                exit_reason = "TAKE_PROFIT"
            elif not cfg.disable_stop_loss and roi <= -cfg.stop_loss_pct and opp >= cfg.stop_loss_min_prob and age_s >= cfg.stop_loss_min_duration_s:
                exit_reason = "STOP_LOSS"
            elif not cfg.disable_signal_flip and opp >= cfg.signal_flip_min_prob:
                exit_reason = "SIGNAL_FLIP"
            elif not cfg.disable_time_decay and float(row["time_left_min"]) < 1.5 and roi < -5 and pos.entry_price >= 0.5:
                exit_reason = "TIME_DECAY"

            if exit_reason is not None:
                exit_price = curr
                pnl = pos.shares * exit_price - pos.invested
                out.append(TradeRow(
                    pos.entry_time, ts, slug, side,
                    pos.entry_price, exit_price, pnl,
                    100 * pnl / pos.invested,
                    exit_reason,
                    (ts - pos.entry_time).total_seconds(),
                ))
                pos = None
                if exit_reason == "SIGNAL_FLIP":
                    cooldown_until = ts + pd.Timedelta(seconds=cfg.flip_cooldown_s)
                continue

        # Entry check (only if no open position and not in cooldown)
        if pos is None and (cooldown_until is None or ts >= cooldown_until):
            sig = row.get("signal")
            if sig in ("UP", "DOWN"):
                price = _market_price(row, sig)
                hour = ts.hour
                if (cfg.entry_min_price <= price <= cfg.entry_max_price
                    and hour not in cfg.blocked_hours_utc
                    and row.get("regime") not in cfg.blocked_regimes):
                    shares = trade_amount / price
                    pos = Position(side=sig, entry_price=price, entry_time=ts,
                                   invested=trade_amount, shares=shares)

    return out

def trades_to_df(trades: list[TradeRow]) -> pd.DataFrame:
    return pd.DataFrame([t.__dict__ for t in trades])

# %% [markdown]
# ### 4a. Validation — Python replay must match JS engine
#
# Locate the current strategy in the registry, extract its config, run the replay,
# and compare against `dryrun_{bot}_trades.csv`. Trade counts and per-trade PnL must match.

# %%
def cfg_from_registry(entry: dict) -> StrategyCfg:
    c = entry.get("config", {})
    return StrategyCfg(
        entry_min_price=c.get("entryMinMarketPrice", 0.50),
        entry_max_price=c.get("entryMaxMarketPrice", 0.58 if BOT == "15m" else 0.52),
        blocked_hours_utc=tuple(c.get("blockedHoursUtc", []) or []),
        blocked_regimes=tuple(c.get("blockedRegimes", ["CHOP", "RANGE"]) or []),
        take_profit_pct=c.get("takeProfitPct", 20),
        stop_loss_pct=c.get("stopLossPct", 25),
        signal_flip_min_prob=c.get("signalFlipMinProb", 0.58 if BOT == "15m" else 0.62),
        stop_loss_min_prob=c.get("stopLossMinProb", 0.65),
        stop_loss_min_duration_s=c.get("stopLossMinDurationS", 240),
        flip_cooldown_s=c.get("flipCooldownS", 60 if BOT == "15m" else 90),
        disable_take_profit=c.get("disableTakeProfit", False),
        disable_stop_loss=c.get("disableStopLoss", False),
        disable_signal_flip=c.get("disableSignalFlip", False),
        disable_time_decay=c.get("disableTimeDecay", False),
    )

current = versions_df.iloc[-1].to_dict()  # most-recent strategy
current_cfg = cfg_from_registry(current)
print(f"Validating against current strategy: {current['label']} ({current['hash'][:8]}…)")

current_trades_recorded = sim_trades[sim_trades["config_hash"] == current["hash"]].copy()
window_start = current_trades_recorded["entry_time"].min()
window_end = current_trades_recorded["exit_time"].max()
ticks_window = ticks[(ticks["timestamp"] >= window_start) & (ticks["timestamp"] <= window_end)]

replayed = trades_to_df(replay(ticks_window, current_cfg))
print(f"Recorded trades: {len(current_trades_recorded)}   Replayed: {len(replayed)}")
print(f"Recorded PnL:    {current_trades_recorded['pnl'].sum():+.4f}")
print(f"Replayed PnL:    {replayed['pnl'].sum():+.4f}")

if abs(len(replayed) - len(current_trades_recorded)) > 2 or abs(replayed["pnl"].sum() - current_trades_recorded["pnl"].sum()) > 0.5:
    print("⚠️  Replay diverges from recorded trades. Engine port needs fixing before running counterfactuals.")
else:
    print("✅ Replay matches recorded trades within tolerance — engine port OK.")

# %% [markdown]
# ### 4b. Counterfactual variants

# %%
variants = {
    "current": current_cfg,
    "+TP": StrategyCfg(**{**current_cfg.__dict__, "disable_take_profit": False}),
    "+SL": StrategyCfg(**{**current_cfg.__dict__, "disable_stop_loss": False}),
    "+FLIP": StrategyCfg(**{**current_cfg.__dict__, "disable_signal_flip": False}),
    "+TIME_DECAY": StrategyCfg(**{**current_cfg.__dict__, "disable_time_decay": False}),
    "all exits on": StrategyCfg(**{**current_cfg.__dict__,
        "disable_take_profit": False, "disable_stop_loss": False,
        "disable_signal_flip": False, "disable_time_decay": False}),
}

rows = []
for label, cfg in variants.items():
    res = trades_to_df(replay(ticks_window, cfg))
    rows.append({
        "variant": label,
        "trades": len(res),
        "wins": int((res["pnl"] > 0).sum()) if len(res) else 0,
        "wr": float((res["pnl"] > 0).mean()) if len(res) else 0.0,
        "gross_pnl": float(res["pnl"].sum()) if len(res) else 0.0,
    })
summary = pd.DataFrame(rows)
print(summary.to_string(index=False))

fig, ax = plt.subplots(figsize=(8, 4))
sns.barplot(data=summary, x="variant", y="gross_pnl", ax=ax)
ax.set_title(f"Counterfactual gross PnL by exit-config variant ({BOT})")
ax.axhline(0, color="black", lw=0.5)
plt.xticks(rotation=20, ha="right")
plt.tight_layout()
```

- [ ] **Step 2: Smoke run** — same as before, expect the assert to fire (no bundle present).

```bash
cd analysis && python starter.py 2>&1 | head -5
```

Expected: `AssertionError`.

- [ ] **Step 3: Commit**

```bash
git add analysis/starter.py
git commit -m "feat(analysis): starter notebook section 4 (counterfactual backtest + validation)"
```

---

## Task 8: `analysis/starter.py` — sections 5-7 (indicator hit-rate, comparison, fee/delay impact)

**Files:**
- Modify: `analysis/starter.py`

- [ ] **Step 1: Append sections 5-7 to `analysis/starter.py`.**

```python
# %% [markdown]
# ## 5. Indicator hit-rate
#
# Buckets each indicator and computes settled win-rate + average PnL per bucket using the
# per-tick `outcome` column. Highlights buckets where WR < 50% or PnL is negative — those
# are conditions where the current scoring should probably down-weight that indicator.

# %%
def settled_view(ticks_df: pd.DataFrame) -> pd.DataFrame:
    """One row per (market_slug, outcome). Drops ticks without a known outcome."""
    df = ticks_df[ticks_df["outcome"].isin(["UP", "DOWN"])].copy()
    df["hour_utc"] = df["timestamp"].dt.hour
    return df

def hit_rate_by_bucket(df: pd.DataFrame, col: str, bins: int | list = 6, label: str | None = None):
    """Bucketise `col` and compute, for ticks where signal == outcome, win-rate."""
    label = label or col
    if df[col].dtype.kind in "biufc" and isinstance(bins, int):
        df = df.assign(_bucket=pd.qcut(df[col], q=bins, duplicates="drop"))
    elif isinstance(bins, list):
        df = df.assign(_bucket=pd.cut(df[col], bins=bins))
    else:
        df = df.assign(_bucket=df[col].astype(str))
    agg = df.groupby("_bucket", observed=True).agg(
        n=("outcome", "size"),
        wr=("signal", lambda s: float((s == df.loc[s.index, "outcome"]).mean())),
    ).reset_index().rename(columns={"_bucket": label})
    return agg

settled = settled_view(ticks)
print(f"Settled ticks for hit-rate analysis: {len(settled):,}")

# Pick indicators that exist in the columns. Different bots have different sets.
candidate_cols = ["rsi", "ofi_1m", "ha_count", "vwap_dist_pct", "btc_vs_ptb",
                  "regime", "hour_utc", "market_up", "market_down"]
present = [c for c in candidate_cols if c in settled.columns]
print(f"Available indicators: {present}")

for col in present:
    print(f"\n— {col} —")
    is_categorical = settled[col].dtype.kind not in "biufc"
    res = hit_rate_by_bucket(settled, col, bins=("__categorical__" if is_categorical else 6) if is_categorical else 6, label=col)
    print(res.to_string(index=False))

# %% [markdown]
# ## 6. Strategy comparison
#
# Picks two `config_hash` values from the registry and compares them on the overlap window.

# %%
def metrics(df: pd.DataFrame) -> dict:
    if df.empty:
        return {"trades": 0, "wr": 0.0, "pnl": 0.0, "pf": float("nan"), "max_dd": 0.0}
    wins = df[df["pnl"] > 0]["pnl"].sum()
    losses = -df[df["pnl"] <= 0]["pnl"].sum()
    cum = df.sort_values("exit_time")["pnl"].cumsum()
    drawdown = (cum - cum.cummax()).min()
    return {
        "trades": len(df),
        "wr": float((df["pnl"] > 0).mean()),
        "pnl": float(df["pnl"].sum()),
        "pf": float(wins / losses) if losses > 0 else float("inf"),
        "max_dd": float(drawdown),
    }

print("Available strategies:")
for _, v in versions_df.iterrows():
    print(f"  {v['hash'][:8]}  {v['label']}")

# Edit the two hashes below to compare.
HASH_A = versions_df.iloc[-2]["hash"] if len(versions_df) >= 2 else versions_df.iloc[0]["hash"]
HASH_B = versions_df.iloc[-1]["hash"]
a = sim_trades[sim_trades["config_hash"] == HASH_A]
b = sim_trades[sim_trades["config_hash"] == HASH_B]
print(f"\nA = {HASH_A[:8]}  trades={len(a)}")
print(f"B = {HASH_B[:8]}  trades={len(b)}")

compare = pd.DataFrame([
    {"strategy": HASH_A[:8], **metrics(a)},
    {"strategy": HASH_B[:8], **metrics(b)},
])
print(compare.to_string(index=False))

# %% [markdown]
# ## 7. Fee + delay impact
#
# Buckets the slippage + fee drag by hour, regime (when available), and entry price band.
# Surfaces conditions where the real-vs-sim gap is largest.

# %%
if real_trades is None or real_trades.empty:
    print("No real trades — section 7 skipped.")
else:
    key_cols = ["entry_time", "market_slug"]
    joined = sim_trades.merge(real_trades, on=key_cols, how="inner", suffixes=("_sim", "_real"))
    joined["hour_utc"] = joined["entry_time"].dt.hour
    joined["drag"] = joined["pnl_sim"] - joined["pnl_real"]
    joined["entry_band"] = pd.cut(joined["entry_price_real"], bins=[0, 0.45, 0.50, 0.55, 0.60, 1.0])

    print("Drag by hour UTC:")
    print(joined.groupby("hour_utc")["drag"].agg(["count", "sum", "mean"]).to_string())

    print("\nDrag by entry price band:")
    print(joined.groupby("entry_band", observed=True)["drag"].agg(["count", "sum", "mean"]).to_string())

    fig, ax = plt.subplots(figsize=(8, 4))
    sns.barplot(data=joined.assign(hour=joined["hour_utc"].astype(str)),
                x="hour", y="drag", estimator="sum", errorbar=None, ax=ax)
    ax.set_title("Total drag (sim PnL - real PnL) by hour UTC")
    ax.axhline(0, color="black", lw=0.5)
    plt.tight_layout()
```

- [ ] **Step 2: Smoke run again.**

```bash
cd analysis && python starter.py 2>&1 | head -5
```

Expected: still `AssertionError` (file parses cleanly, fails fast at bundle assert).

- [ ] **Step 3: Commit**

```bash
git add analysis/starter.py
git commit -m "feat(analysis): starter notebook sections 5-7 (hit-rate, comparison, fee/delay impact)"
```

---

## Task 9: End-to-end check + deploy

**Files:** none

- [ ] **Step 1: Rebuild and restart the dashboard container** so the new endpoint + UI ship.

```bash
docker compose down && docker compose up -d --build
docker ps --filter "name=polymarket" --format "table {{.Names}}\t{{.Status}}"
```

Expected: all three containers `Up`.

- [ ] **Step 2: Manual end-to-end** — sign in, switch the bot selector, click `Bundle análise (15m)`, extract the ZIP, point `BUNDLE_DIR` in `analysis/starter.py` at the extracted directory, run sections 1-3 in VS Code or Jupyter.

Expected: section 1 prints non-zero row counts, section 2 lists at least one strategy, section 3 either prints a real-vs-sim summary or the "No real trades" message.

- [ ] **Step 3: Run the bundle smoke test once more**

```bash
npm run smoke:bundle
```

Expected: `ok analysis-bundle smoke (5 assertions)`.

No commit — verification only.

---

## Self-Review

**Spec coverage:**
- Endpoint + auth + manifest schema → Tasks 1-3 ✅
- Bundle file list (4 data + manifest) → Task 2 (`ANALYSIS_BUNDLE_FILES`) ✅
- `/files` button + bot filter → Task 4 ✅
- Notebook sections 1-7 → Tasks 6-8 (sections 1-3 in Task 6, section 4 in Task 7, sections 5-7 in Task 8) ✅
- Validation gate in section 4 → Task 7 step 1 (4a cell) ✅
- Real-vs-sim drag by hour / regime / band → Task 8 section 7 ✅
- `requirements.txt` + README → Task 5 ✅
- Notebook risk note ("engine drift") → Task 7 (validation cell) ✅

**Spec deviation:** Spec says `analysis/starter.ipynb`. Plan ships `analysis/starter.py` in jupytext percent format. Rationale: pure-text files are reviewable in git and authorable in tasks without nbformat JSON gymnastics. VS Code Jupyter opens the `.py` natively; classic Jupyter users convert with one `jupytext` command. The README documents this. Behaviour is unchanged.

**Placeholder scan:** No "TBD", no "implement appropriate", every code step ships complete code. Validation tolerance (`> 2 trades`, `> $0.5 PnL`) is concrete.

**Type consistency:** `buildAnalysisBundle` → `{ manifest, items, error?, status? }` used consistently across Tasks 2-3. Python `StrategyCfg` constructed identically in Tasks 7 and 8 via `cfg_from_registry`. Trade dataclass fields match the CSV schema used by sections 5-7.

---

**Plan complete and saved to `docs/superpowers/plans/2026-05-20-analysis-bundle.md`. Two execution options:**

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
