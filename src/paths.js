import fs from "node:fs";
import path from "node:path";

export const LOG_ROOT = process.env.LOG_ROOT || "./logs";

export const CAPTURE_DIR = path.join(LOG_ROOT, "capture");
export const SIM_DIR     = path.join(LOG_ROOT, "sim");
export const REAL_DIR    = path.join(LOG_ROOT, "real");
export const META_DIR    = path.join(LOG_ROOT, "meta");
export const ARCHIVE_DIR = path.join(LOG_ROOT, "archive");

for (const dir of [CAPTURE_DIR, SIM_DIR, REAL_DIR, META_DIR, ARCHIVE_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

// ── capture/ ────────────────────────────────────────────────────────────────
export const orderbook5m    = path.join(CAPTURE_DIR, "orderbook_5m.jsonl");
export const orderbook15m   = path.join(CAPTURE_DIR, "orderbook_15m.jsonl");
export const pipelineTrace  = path.join(CAPTURE_DIR, "pipeline_trace.jsonl");

// ── sim/ ────────────────────────────────────────────────────────────────────
export const signals15m       = path.join(SIM_DIR, "signals.csv");
export const signals5m        = path.join(SIM_DIR, "signals_5m.csv");
export const dryrun15m        = path.join(SIM_DIR, "dryrun_15m.csv");
export const dryrun5m         = path.join(SIM_DIR, "dryrun_5m.csv");
export const dryrun15mTrades  = path.join(SIM_DIR, "dryrun_15m_trades.csv");
export const dryrun5mTrades   = path.join(SIM_DIR, "dryrun_5m_trades.csv");

// ── real/ ───────────────────────────────────────────────────────────────────
export const ticks15m         = path.join(REAL_DIR, "ticks_15m.csv");
export const ticks5m          = path.join(REAL_DIR, "ticks_5m.csv");
export const real15mTrades    = path.join(REAL_DIR, "real_15m_trades.csv");
export const real5mTrades     = path.join(REAL_DIR, "real_5m_trades.csv");
export const tradeOrdersLog   = path.join(REAL_DIR, "trade_orders.log");
export const tradeErrorsLog   = path.join(REAL_DIR, "trade_errors.log");

// ── meta/ ───────────────────────────────────────────────────────────────────
export const strategyVersions5m  = path.join(META_DIR, "strategy_versions_5m.json");
export const strategyVersions15m = path.join(META_DIR, "strategy_versions_15m.json");
