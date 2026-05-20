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
