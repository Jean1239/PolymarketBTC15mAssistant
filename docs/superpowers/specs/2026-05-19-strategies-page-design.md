# Strategies Page — Design Spec

**Date:** 2026-05-19
**Status:** Draft (awaiting user review)
**Scope:** Dashboard upgrade — `/strategies` page with auto-detected strategy versioning, time-window filtering, odd-band breakdown, and N-way comparison.

## Goal

Surface evolution of trading strategy over time so user can answer:
- Which version performs best (P&L net, WR, PF)?
- In which entry-price band does the profit concentrate?
- What changed between v12 and v13 (or any two versions)?

Strategy versions are identified by a hash of the gates-relevant subset of `CONFIG.trading`. New version is auto-detected on bot startup. Historical trades are backfilled from `STRATEGY_LOG.md`.

## Architecture & Data Flow

```
┌─────────────────────────────────────────────────────────────┐
│                         BOT (15m / 5m)                      │
│                                                             │
│  startup: computeStrategyHash(CONFIG.trading)               │
│   → src/strategy/hash.js  (subset: gates entrada/saída)     │
│                                                             │
│  if hash !== latest in registry:                            │
│   → append { hash, label, detectedAt, config } to           │
│     logs/strategy_versions_{15m,5m}.json                    │
│                                                             │
│  dryRun.js BUY row → adds `config_hash` column to CSV       │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                    SERVER (logServer.js)                    │
│                                                             │
│  GET /api/strategies/15m | /api/strategies/5m               │
│    reads strategy_versions_*.json                           │
│    derives configDiff vs previous version                   │
│    returns { versions, unknownPeriod, backfillSource }      │
│                                                             │
│  GET /api/trades/15m | /api/trades/5m  (already exists)     │
│    returns rows with new `config_hash` field                │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│              DASHBOARD (React + Recharts)                   │
│                                                             │
│  Route: /strategies                                         │
│   Tabs: 15m | 5m                                            │
│    [TimeWindowFilter: 1D | 1W | 1M | All]                   │
│    <StrategyTable rows={versions} compute={byVersion}/>     │
│    <CompareDrawer a={hashA} b={hashB}/>  (when 2 selected)  │
│                                                             │
│  In-browser aggregation: groupBy(config_hash) + window      │
│  → core KPIs, exit-reason breakdown, odd-band breakdown     │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
        scripts/backfillStrategyHash.js  (one-shot)
         parseia STRATEGY_LOG.md → janelas (v12, v13)
         escreve config_hash em rows pré-deploy
```

**Boundaries:**
- **Bot:** computes + persists hash. Does not know dashboard.
- **Server:** exposes registry + diff. Does not know aggregator.
- **Dashboard:** aggregates + renders. Does not know hash formula.

**Dependencies:** `crypto` (Node built-in) for hashing. Recharts already in use. No new libs.

## Bot-side: Hashing, Registry, CSV Column

### New module `src/strategy/hash.js`

```js
import crypto from "node:crypto";

// Canonical list of entry/exit gate fields.
// Mudanças nessa lista quebram hashes existentes → bump STRATEGY_FIELDS_VERSION.
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

export function extractStrategySubset(trading) {
  const out = {};
  for (const k of STRATEGY_FIELDS) {
    const v = trading[k];
    out[k] = Array.isArray(v) ? [...v].sort() : v;
  }
  return out;
}

export function computeStrategyHash(trading) {
  const subset = extractStrategySubset(trading);
  const serialized = JSON.stringify(subset, Object.keys(subset).sort());
  return crypto.createHash("sha256").update(serialized).digest("hex").slice(0, 8);
}
```

### Registry file `logs/strategy_versions_{bot}.json`

Append-only array:

```json
[
  {
    "hash": "a1b2c3d4",
    "label": "v14",
    "detectedAt": "2026-05-19T14:32:11.000Z",
    "fieldsVersion": 1,
    "config": { "takeProfitPct": 20, "entryMaxMarketPrice": 0.58, "...": "full subset" },
    "source": "auto"
  }
]
```

- `label`: auto-incremented next slot = `v<N+1>`. Backfill uses `v12`, `v13`, `unknown`.
- `source`: `"auto"` (runtime detection) | `"backfill"` (script).

### Bot startup wiring

- `src/index.js` / `src/index5m.js`: call `ensureStrategyVersion(CONFIG.trading, botMode)` before the poll loop. Function:
  1. Reads registry. If current hash already present, no-op.
  2. Else append new entry, stderr log `[strategy] new version detected: vN (a1b2c3d4)`.
- Module-scoped `currentHash` passed to simulator factory.

### CSV column

- `src/dryRun.js`: append `"config_hash"` to `TRADE_JOURNAL_HEADER` (same pattern as fee columns).
- `_logTrade` receives `configHash` from simulator factory.
- `createDryRunSimulator15m/5m(csvPath, tradingConfig, { configHash })` — third optional arg. Defaults `"unknown"` when missing (compat).

## Backfill Script

**New: `scripts/backfillStrategyHash.js`** (one-shot, idempotent).

Pipeline:

1. Read `STRATEGY_LOG.md`.
2. Regex captures blocks: `/^## (v\d+) — (\d{4}-\d{2}-\d{2})$/m` → `[{ label: "v13", date: "2026-05-17" }, { label: "v12", date: "2026-05-04" }]`.
3. For each version:
   - Extract parameters from block (regex on markdown tables/lists):
     - `"entryMaxMarketPrice: 0.58 → 0.52"` → take post-arrow value.
     - `"disableTimeDecay = true"` → bool.
     - `"takeProfitPct=20"` → number.
   - Merge with defaults from current `CONFIG` (fields not mentioned = default).
   - Compute hash via `computeStrategyHash()`.
   - Create entry `{ hash, label, detectedAt: <date+00:00Z>, fieldsVersion: 1, config: <merged subset>, source: "backfill", partial: true }`.
4. Sort by `detectedAt` asc.
5. Define windows: vN covers `[vN.detectedAt, vN+1.detectedAt)`. Last vN covers until `now()`.
6. Trades earlier than oldest version (v12) → hash `"unknown"`.
7. Prepend `"unknown"` entry to registry with config=null, endedAt=v12.detectedAt.
8. Write `logs/strategy_versions_{15m,5m}.json` (overwrite only if diff).
9. For each `dryrun_{15m,5m}_trades.csv`:
   - Read all rows + header.
   - If header lacks `config_hash` → add column.
   - For each row without `config_hash`:
     - Find window by `entry_time`.
     - Fill with window's hash or `"unknown"`.
   - Rewrite CSV. Backup first to `logs/archive/backfill_<ts>/`.
10. Stdout report: e.g. `"v12: 47 trades | v13: 196 trades | unknown: 318 trades | total: 561"`.

### Parser limitation (accepted)

- Markdown is free-form. Parser uses conservative regex + merge with defaults.
- Fields new in v13 absent in v12 inherit current default → potentially imprecise hash for v12.
- Mitigation: registry stores `config: <subset used>` + `partial: true`. Dashboard shows ⚠️ tooltip.
- Acceptable: goal is grouping trades into coherent eras, not bit-perfect historical reproduction.

### Idempotency

- Re-run: skip if hash already in registry; skip CSV row if already has `config_hash`.
- Backup only once per execution (unique timestamp).

### Command

```bash
node scripts/backfillStrategyHash.js          # both bots
node scripts/backfillStrategyHash.js --bot=5m # filter
node scripts/backfillStrategyHash.js --dry    # print only
```

### Expected first run (with current STRATEGY_LOG.md)

```
strategy_versions_15m.json:
  unknown (covers pré-2026-05-04, source="backfill", partial=true)
  v12 a1b2c3d4 (2026-05-04 → 2026-05-17)
  v13 e5f6a7b8 (2026-05-17 → now)
```

### Fallback

If `STRATEGY_LOG.md` parse fails entirely, script aborts with error, does NOT touch CSVs. User edits file and re-runs.

## Server Endpoint

**Path:** `GET /api/strategies/15m` | `GET /api/strategies/5m`
**Auth:** required (better-auth middleware, same as `/api/stats`).
**Cache:** none. Registry is small (<10KB), read per request.

### Implementation in `src/logServer.js`

```js
if (p === "/api/strategies/15m" || p === "/api/strategies/5m") {
  const bot = p.endsWith("/15m") ? "15m" : "5m";
  return json(buildStrategiesResponse(bot));
}

function buildStrategiesResponse(bot) {
  const registryPath = path.join(LOGS_DIR, `strategy_versions_${bot}.json`);
  if (!fs.existsSync(registryPath)) {
    return { versions: [], unknownPeriod: null, backfillSource: null };
  }
  const raw = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  raw.sort((a, b) => (a.detectedAt ?? "").localeCompare(b.detectedAt ?? ""));

  const versions = raw.map((v, i) => {
    const next = raw[i + 1];
    return {
      hash: v.hash,
      label: v.label,
      startedAt: v.detectedAt,
      endedAt: next ? next.detectedAt : null,
      source: v.source ?? "auto",
      partial: v.partial ?? false,
      fieldsVersion: v.fieldsVersion ?? 1,
      config: v.config ?? null,
      configDiff: computeConfigDiff(raw[i - 1]?.config, v.config),
    };
  });

  // unknown stays in `versions[]` so the dashboard renders it as a regular row.
  // `unknownPeriod` is a convenience pointer used only for the top-of-page banner.
  const unknown = versions.find(v => v.hash === "unknown") ?? null;
  return {
    versions, // includes "unknown" if present, ordered by detectedAt asc
    unknownPeriod: unknown ? { startedAt: null, endedAt: unknown.endedAt } : null,
    backfillSource: "STRATEGY_LOG.md",
  };
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
```

### Response shape

```ts
{
  versions: [
    {
      hash: "a1b2c3d4",
      label: "v12",
      startedAt: "2026-05-04T00:00:00.000Z",
      endedAt: "2026-05-17T00:00:00.000Z",   // null se última
      source: "backfill",                     // | "auto"
      partial: true,                          // true = parser não viu todos campos
      fieldsVersion: 1,
      config: { entryMaxMarketPrice: 0.58, takeProfitPct: 20, /* ... */ },
      configDiff: { entryMaxMarketPrice: { from: 0.60, to: 0.58 } } | null
    },
    { hash: "e5f6a7b8", label: "v13", startedAt: "2026-05-17T...", endedAt: null, /* ... */ }
  ],
  unknownPeriod: { startedAt: null, endedAt: "2026-05-04T00:00:00.000Z" } | null,
  backfillSource: "STRATEGY_LOG.md" | null
}
```

### Trades endpoint

`/api/trades/{15m,5m}` already exists. Adding the `config_hash` column to the CSV propagates automatically through the existing row parser. Document the new field in CLAUDE.md.

### Frontend lib (`dashboard/src/lib/api.ts`)

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

// add to api object:
strategies15m: () => get<StrategiesResponse>("/api/strategies/15m"),
strategies5m:  () => get<StrategiesResponse>("/api/strategies/5m"),
```

## Dashboard: Page Structure & Components

### New file layout

```
dashboard/src/
├── routes/
│   └── strategies.tsx                  ← new (page)
├── components/
│   └── strategies/                     ← new subdir
│       ├── strategy-table.tsx          (N-way table)
│       ├── time-window-filter.tsx      (1D/1W/1M/All chips)
│       ├── version-row.tsx             (1 row of table)
│       ├── config-diff-popover.tsx     (popover with diff)
│       ├── odd-band-chart.tsx          (bar chart P&L per bin)
│       ├── exit-reason-chart.tsx       (reuses overview pattern)
│       └── compare-drawer.tsx          (drill-down 2 versions)
└── lib/
    ├── strategy-aggregate.ts           ← new (client-side aggregation)
    └── api.ts                          (extended)
```

### Sidebar nav

Add "Strategies" item between "Trades" and "Files" in `__root.tsx`.

### `lib/strategy-aggregate.ts`

```ts
export type TimeWindow = "1d" | "1w" | "1m" | "all";

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
  byOddBand: Array<{ label: string; lo: number; hi: number; count: number; pnl: number; winRate: number }>;
}

export function aggregateByVersion({
  trades, versions, window,
}: {
  trades: Trade[];
  versions: StrategyVersion[];
  window: TimeWindow;
}): AggregateRow[] {
  const since = computeSince(window);  // null para "all"
  const filtered = trades.filter(t =>
    (!since || new Date(t.entry_time) >= since) &&
    versions.some(v => v.hash === t.config_hash)
  );

  return versions.map(v => {
    const rows = filtered.filter(t => t.config_hash === v.hash);
    return {
      version: v,
      trades: rows.length,
      pnlGross: sum(rows, "pnl"),
      pnlNet: sum(rows, "pnl_net"),
      winRate: rows.length ? rows.filter(t => t.pnl_net > 0).length / rows.length : 0,
      profitFactor: profitFactorOf(rows),
      avgWin: avgWin(rows),
      avgLoss: avgLoss(rows),
      maxDrawdown: maxDrawdownOf(rows),
      byExitReason: groupExitReasons(rows),
      byOddBand: binByEntryPrice(rows, v.config),
    };
  });
}
```

### Odd bin algorithm (`binByEntryPrice`)

```
bins = [
  { lo: 0,            hi: entryMin,    label: "< entryMin" },
  { lo: entryMin,     hi: entryMin+.02 },                        // e.g. 0.50-0.52
  { lo: entryMin+.02, hi: entryMin+.04 },                        // 0.52-0.54
  ...
  until hi >= entryMax → last in-band bin closes at entryMax
  { lo: entryMax,     hi: 1,           label: "> entryMax" },
]
```

When comparing two versions with different bands, each version renders its own chart in the drawer.

**Fallback for unknown bucket (config=null):** no band metadata is available. The odd-band chart falls back to fixed bins of 0.02 width covering `[0.40, 0.62]` (the historically observed entry range), with overflow buckets `< 0.40` and `> 0.62`. The chart header labels this as "fallback bins (no config available)".

### Page layout — `routes/strategies.tsx`

```
┌────────────────────────────────────────────────────────────────┐
│ Strategies     [15m] [5m]     [1D] [1W] [1M] [All]             │  ← TimeWindowFilter
├────────────────────────────────────────────────────────────────┤
│ ⚠️  463 trades pré-v12 estão agrupados em "unknown" (backfill)  │
├────────────────────────────────────────────────────────────────┤
│ ☐ □ Version  Period         Trades  P&L net  WR    PF   Diff   │  ← StrategyTable
│ ☐ □ v13      05-17 → now    196     +$12.40  73%   1.42  📋    │
│ ☐ □ v12      05-04 → 05-17  47      -$3.20   61%   0.89  📋    │
│ ☐ □ unkn     pré-05-04      318     -$8.10   58%   0.94   —    │
├────────────────────────────────────────────────────────────────┤
│ [Compare 2 selected]   (CTA — enabled when exactly 2)          │
└────────────────────────────────────────────────────────────────┘
```

### Component responsibilities

- **TimeWindowFilter** — 4 chips, local state. Re-aggregates on change (pure client, instant).
- **StrategyTable** — shadcn `<Table>`. Each row: select checkbox, label, period (relative + absolute), trades, P&L net (color-coded), WR%, PF, diff popover icon. Row click opens single-version detail panel.
- **OddBandChart** — Recharts `<BarChart>` horizontal, bar per bin, fill colored by P&L sign. Tooltip: count + WR + P&L.
- **ExitReasonChart** — reuses overview pattern (vertical bar with cells).
- **ConfigDiffPopover** — shadcn `<Popover>`, lists `field: from → to`. Boolean flips highlighted.

### Compare flow

- 2 checkboxes selected → CTA "Compare" enables.
- Click → `<CompareDrawer>` opens (shadcn `<Sheet>` from right, full-height):

```
┌──────────────────────────┬───────────────────────────┐
│ v12 (47 trades)          │ v13 (196 trades)          │
│ P&L net: -$3.20          │ P&L net: +$12.40          │
│ WR: 61%                  │ WR: 73%                   │
│ PF: 0.89                 │ PF: 1.42                  │
├──────────────────────────┴───────────────────────────┤
│ Config diff (only changed fields):                    │
│   entryMaxMarketPrice:  0.58 → 0.52                   │
│   disableTimeDecay:    false → true                   │
├──────────────────────────┬───────────────────────────┤
│ Odd band P&L  (v12)      │ Odd band P&L  (v13)       │
│ [bar chart, v12 bands]   │ [bar chart, v13 bands]    │
├──────────────────────────┼───────────────────────────┤
│ Exit reasons (v12)       │ Exit reasons (v13)        │
│ [bar chart]              │ [bar chart]               │
└──────────────────────────┴───────────────────────────┘
```

### Data fetching

- TanStack Query, per active bot:
  - `["strategies", bot]` → `api.strategies{15m,5m}()`
  - `["trades", bot]` → existing.
- Refetch interval: 60s (versions change slowly).
- Aggregation memoized: `useMemo(() => aggregateByVersion(...), [trades, versions, window])`.

### Empty / edge states

- **No versions in registry:** "Nenhuma estratégia detectada. Rode `npm start` ou `node scripts/backfillStrategyHash.js`."
- **Bot inactive** (not in `visibleBots`): tab hidden (same logic as `/trades`).
- **Bin with count=0:** still renders bar with min height + gray label.
- **Partial backfill:** ⚠️ badge on row + tooltip explains possible imprecision.

## Error Handling

### Bot startup (`ensureStrategyVersion`)

| Failure | Treatment |
|---|---|
| `logs/strategy_versions_*.json` corrupt | stderr `[strategy] registry parse error, recreating empty`; rename to `.corrupt-<ts>.bak`; create new empty array. Bot continues. |
| `fs.writeFileSync` fails (disk full, perms) | stderr log; bot continues without registering version; CSV records `config_hash="unknown"`. Does not block trading. |
| `crypto.createHash` unavailable (impossible in Node) | crash with clear message. |

### Backfill script

| Failure | Treatment |
|---|---|
| `STRATEGY_LOG.md` missing | abort with `error: STRATEGY_LOG.md not found`. Does NOT touch CSVs. |
| Regex fails to parse a block | warning per block + skip. Continue. Stdout final reports skipped blocks. |
| CSV corrupt / malformed row | log offending row + skip (default tolerant). `--strict` flag rewrites without it. |
| Backup dir exists | use timestamp + suffix `_1`, `_2`. |
| `--dry` flag | print everything, write nothing. |
| Re-run idempotent | skip rows already with `config_hash`; skip hashes already in registry. |

### Server endpoint

| Failure | Treatment |
|---|---|
| Registry absent | returns `{ versions: [], unknownPeriod: null, backfillSource: null }` (200). Frontend shows empty state. |
| Registry JSON invalid | 500 with `{ error: "registry_parse_error" }`. Frontend shows alert. |
| Auth missing | 401 (handled by better-auth middleware). |

### Dashboard

| Failure | Treatment |
|---|---|
| `/api/strategies/*` 500 | TanStack Query error state; `<Card>` "Failed to load strategies. Retry." |
| Trades CSV missing `config_hash` column | parser frontend defaults to `"unknown"`. Row absorbed by unknown bucket. |
| `config_hash` points to a hash not in registry | synthetic "orphan" bucket (truncated hash as label). Does not break render. |
| Zero trades in window | row shows `0 trades, —, —, —` (no NaN). Charts show "Nenhum trade nesta janela." |
| Bin with 0 trades | zero-height bar + tooltip "0 trades". |
| Aggregation > 200ms (big CSV) | already runs in useMemo; if becomes problem, move to Web Worker. Not now (YAGNI). |

### Schema migration (forward compat)

- `STRATEGY_FIELDS_VERSION` bump invalidates old hashes. No auto migration — backfill script handles.
- Frontend detects mismatch (`version.fieldsVersion !== expectedVersion`) → "outdated schema" badge + tooltip.

## Testing

Project has no test runner (CLAUDE.md confirms). Maintain consistency: manual validation + ad-hoc sanity scripts via `node -e`.

### Unit-style sanity (`scripts/smokeTestStrategy.js`)

```js
import assert from "node:assert/strict";
import { computeStrategyHash, extractStrategySubset, STRATEGY_FIELDS } from "../src/strategy/hash.js";

// 1. Hash deterministic
const a = computeStrategyHash({ takeProfitPct: 20, entryMaxMarketPrice: 0.58 });
const b = computeStrategyHash({ entryMaxMarketPrice: 0.58, takeProfitPct: 20 });
assert.equal(a, b, "hash insensitive to key order");

// 2. Array sort stability
const c = computeStrategyHash({ blockedRegimes: ["CHOP", "RANGE"] });
const d = computeStrategyHash({ blockedRegimes: ["RANGE", "CHOP"] });
assert.equal(c, d, "hash insensitive to array order");

// 3. Field change breaks hash
const e = computeStrategyHash({ takeProfitPct: 20 });
const f = computeStrategyHash({ takeProfitPct: 25 });
assert.notEqual(e, f, "hash changes when field changes");

// 4. extractStrategySubset returns only STRATEGY_FIELDS
const sub = extractStrategySubset({ takeProfitPct: 20, privateKey: "0xSECRET" });
assert.equal(sub.privateKey, undefined, "privateKey never enters hash");

console.log("✓ strategy hash smoke OK");
```

### Backfill dry-run integration

```bash
# Create temp CSV with rows of different dates, run backfill --dry, validate output
node scripts/backfillStrategyHash.js --dry --bot=15m --csv=/tmp/fake_trades.csv
# Should print correct mapping without writing
```

### Server endpoint manual

```bash
# After backfill runs:
curl -b cookies.txt http://localhost:3000/api/strategies/15m | jq '.versions[] | {hash, label, source, partial}'
# Expected: v12 + v13 rows + (eventually) auto-detected current
```

### Dashboard manual checklist

| Case | Expected |
|---|---|
| Load `/strategies` with empty registry | Empty state with instruction to run bot/backfill |
| Tabs 15m vs 5m | Distinct tables, no mixing |
| Filter 1D vs All | Counts and P&L update instantly (no RTT) |
| Checkbox 2 versions | CTA "Compare" enables; click opens drawer |
| Checkbox 3 versions | Third auto-deselects first (FIFO 2-slot) |
| Unknown row | ⚠️ badge + tooltip explains origin |
| Config diff popover | Lists changed fields, format `field: from → to` |
| Odd band chart | Bins aligned to `version.config.entryMinMarketPrice / Max` |
| Hover on bin | Tooltip: `count`, `WR%`, `P&L total` |
| Loading state | Skeleton (shadcn `<Skeleton>`) on table |
| Error state | Red alert + retry button |
| Inactive bot | Tab hidden (same as `/trades`) |
| Window with 0 trades | "Nenhum trade nesta janela." (no NaN) |
| 5m with `disableTakeProfit=true` | Hash differs from 15m (distinct configs, distinct bots, distinct registries) |
| Re-run backfill | Idempotent: nothing changes in files |

### Performance smoke

- Generate synthetic 10k-row CSV; verify `aggregateByVersion` < 100ms in browser.
- If exceeds: profile + consider Web Worker (do not pre-optimize).

### Pre-deploy gate

```bash
npm install
cd dashboard && npm run build     # type check + bundle
node --check src/strategy/hash.js src/dryRun.js src/logServer.js
node scripts/smokeTestStrategy.js
node scripts/backfillStrategyHash.js --dry   # exit code 0
```

## Out of scope (intentional)

- Real-trade journal (`real_*_trades.csv`) — same backfill applies, but mentioned only in passing. Implementation will need to mirror the CSV column addition; this spec focuses on `dryrun_*_trades.csv`.
- Filter on `/index` overview chart with 1D/1W/1M — separate spec follow-up.
- Dashboard write API to manually retag versions — not needed; STRATEGY_LOG.md backfill + auto detection cover it.
- Real-time updates via WebSocket — not needed; 60s poll is enough.
- Statistical significance highlighting (per-bin p-values, CIs) — defer until sample sizes per bin justify it.

## Acceptance criteria

1. New `/strategies` route loads, gated by auth.
2. Bot startup creates entry in `logs/strategy_versions_15m.json` (and 5m) on first run after deploy.
3. `scripts/backfillStrategyHash.js` applied to current CSVs produces `v12`, `v13`, `unknown` buckets matching STRATEGY_LOG.md windows.
4. `/strategies` shows all versions in a sortable table with P&L net, WR, PF, trades count, period.
5. TimeWindowFilter changes table values instantly (no API call).
6. Selecting exactly 2 rows enables "Compare"; click opens drawer with side-by-side metrics + config diff + 2 odd-band charts + 2 exit-reason charts.
7. Config diff popover lists changed fields with `from → to`.
8. Re-run of backfill is idempotent (no file diff).
9. `dashboard && npm run build` passes (type check + bundle).
10. `node scripts/smokeTestStrategy.js` exits 0.
