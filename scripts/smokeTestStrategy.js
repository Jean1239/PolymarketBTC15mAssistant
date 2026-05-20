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
