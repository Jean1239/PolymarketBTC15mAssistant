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
    .map(e => (e.label ?? "").match(/^v(\d+)$/))
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
