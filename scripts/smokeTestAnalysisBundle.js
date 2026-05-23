import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Point LOG_ROOT at a temp dir BEFORE importing paths.js / analysisBundle.js
// so all paths.* constants resolve under our controlled directory.
const tmp = mkdtempSync(path.join(tmpdir(), "bundle-smoke-"));
process.env.LOG_ROOT = tmp;

// Dynamic import ensures paths.js sees the updated env.
const { buildAnalysisBundle } = await import("../src/analysisBundle.js");

try {
  // Replicate the subdir layout that paths.js creates.
  const simDir  = path.join(tmp, "sim");
  const realDir = path.join(tmp, "real");
  const metaDir = path.join(tmp, "meta");
  for (const d of [simDir, realDir, metaDir]) mkdirSync(d, { recursive: true });

  writeFileSync(
    path.join(simDir, "dryrun_15m.csv"),
    "timestamp,btc_price\n2026-05-01T00:00:00Z,60000\n2026-05-01T00:00:01Z,60010\n",
  );
  writeFileSync(
    path.join(simDir, "dryrun_15m_trades.csv"),
    "entry_time,exit_time,pnl\n2026-05-01T00:00:00Z,2026-05-01T00:15:00Z,1.5\n",
  );
  writeFileSync(
    path.join(metaDir, "strategy_versions_15m.json"),
    JSON.stringify([{ hash: "abc", label: "v1" }]),
  );
  // real_15m_trades.csv intentionally absent — must land in `missing`.

  // 1. Invalid bot returns error
  const bad = buildAnalysisBundle(tmp, "99m");
  assert.equal(bad.status, 400, "invalid bot rejected");
  assert.ok(bad.error, "error message present");

  // 2. Valid bot produces a manifest + file items
  const out = buildAnalysisBundle(tmp, "15m", "sim");
  assert.ok(out.manifest, "manifest returned");
  assert.equal(out.manifest.bot, "15m");
  assert.equal(out.manifest.tradeSource, "sim");
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

  // 6. items count matches present files + manifest
  assert.equal(out.items.length, 4); // 3 data files + manifest.json

  console.log("ok analysis-bundle smoke (6 assertions)");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
