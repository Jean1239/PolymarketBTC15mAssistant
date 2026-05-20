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
