import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mig-"));
process.env.LOG_ROOT = tmp;

// Criar arquivos flat
fs.writeFileSync(path.join(tmp, "dryrun_5m.csv"), "header\n");
fs.writeFileSync(path.join(tmp, "real_5m_trades.csv"),
  "entry_time,exit_time,market_slug,side,entry_price,exit_price,shares,invested,exit_value,pnl,roi_pct,exit_reason,duration_s,ptb_at_entry,btc_at_entry,btc_vs_ptb_at_entry,market_up_at_entry,market_down_at_entry,entry_fee_model,exit_fee_model,gross_pnl,entry_tx_hash,exit_tx_hash,entry_usdc_real,exit_usdc_real\n" +
  "2026-04-01,2026-04-01,mkt-1,UP,0.5,0.6,10,5,6,1,20,WIN,180,100,100,0,0.5,0.5,0,0,1,,,,\n");
fs.writeFileSync(path.join(tmp, "strategy_versions_5m.json"), "[]");

const { migrateLogLayout } = await import("./migrateLogLayout.js");

migrateLogLayout({ logRoot: tmp });

// Subdir creation + move
assert.ok(fs.existsSync(path.join(tmp, "sim", "dryrun_5m.csv")), "dryrun_5m → sim/");
assert.ok(!fs.existsSync(path.join(tmp, "dryrun_5m.csv")), "flat dryrun removido");
assert.ok(fs.existsSync(path.join(tmp, "meta", "strategy_versions_5m.json")), "strategy_versions → meta/");

// Real trades CSV — header legado ganha config_hash
const realPath = path.join(tmp, "real", "real_5m_trades.csv");
assert.ok(fs.existsSync(realPath), "real_5m_trades → real/");
const realContent = fs.readFileSync(realPath, "utf8");
assert.ok(realContent.split("\n")[0].endsWith(",config_hash"), "header reescrito com config_hash");
assert.ok(realContent.includes(",mkt-1,UP,"), "linha histórica preservada");

// Idempotente — re-run não faz nada
const before = JSON.stringify(fs.readdirSync(path.join(tmp, "sim")));
migrateLogLayout({ logRoot: tmp });
const after = JSON.stringify(fs.readdirSync(path.join(tmp, "sim")));
assert.equal(before, after, "idempotente");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("OK migration");
