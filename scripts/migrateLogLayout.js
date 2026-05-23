import fs from "node:fs";
import path from "node:path";

// Mapa flat → subdir. Cada arquivo conhecido tem um lar.
const LAYOUT = {
  "signals.csv":              "sim",
  "signals_5m.csv":           "sim",
  "dryrun_15m.csv":           "sim",
  "dryrun_5m.csv":            "sim",
  "dryrun_15m_trades.csv":    "sim",
  "dryrun_5m_trades.csv":     "sim",
  "real_15m_trades.csv":      "real",
  "real_5m_trades.csv":       "real",
  "trade_orders.log":         "real",
  "trade_errors.log":         "real",
  "strategy_versions_5m.json":  "meta",
  "strategy_versions_15m.json": "meta",
};

const LEGACY_HEADER_REGEX = /,exit_usdc_real\s*$/;
const NEW_HEADER_SUFFIX = ",config_hash";

export function migrateLogLayout({ logRoot = process.env.LOG_ROOT || "./logs" } = {}) {
  // Criar subdirs (mkdir é idempotente)
  for (const subdir of ["capture", "sim", "real", "meta", "archive"]) {
    fs.mkdirSync(path.join(logRoot, subdir), { recursive: true });
  }

  for (const [name, role] of Object.entries(LAYOUT)) {
    const src = path.join(logRoot, name);
    const dst = path.join(logRoot, role, name);

    if (!fs.existsSync(src)) continue;
    if (fs.existsSync(dst)) {
      console.warn(`[migrate] both exist, skipping ${name}`);
      continue;
    }

    fs.renameSync(src, dst);
    console.error(`[migrate] ${name} → ${role}/`);
  }

  // Fix de header legado em real_*_trades.csv
  for (const name of ["real_5m_trades.csv", "real_15m_trades.csv"]) {
    const fp = path.join(logRoot, "real", name);
    if (!fs.existsSync(fp)) continue;
    const content = fs.readFileSync(fp, "utf8");
    const lines = content.split("\n");
    if (lines.length === 0) continue;
    const header = lines[0];
    if (LEGACY_HEADER_REGEX.test(header)) {
      const newHeader = header + NEW_HEADER_SUFFIX;
      const rest = lines.slice(1).map(l => (l.length > 0 ? l + "," : l));
      fs.writeFileSync(fp, newHeader + "\n" + rest.join("\n"));
      console.error(`[migrate] ${name} header upgraded with config_hash`);
    }
  }
}

// CLI standalone
if (import.meta.url === `file://${process.argv[1]}`) {
  migrateLogLayout();
  console.error("[migrate] done");
}
