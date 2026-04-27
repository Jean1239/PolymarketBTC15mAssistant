import http from "http";
import { createReadStream, readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, existsSync, statSync } from "fs";
import { readdir } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const LOGS_DIR = path.join(ROOT, "logs");
const DIST_DIR = path.join(ROOT, "dashboard", "dist");
const PORT = process.env.LOG_SERVER_PORT ?? 3456;

// ── ZIP builder (no external deps, STORE mode) ───────────────────────────────

const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32buf(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function buildZip(entries) {
  const parts = [];
  const cds = [];
  let off = 0;
  for (const { name, data, mtime } of entries) {
    const nb = Buffer.from(name, "utf8");
    const d = mtime instanceof Date ? mtime : new Date();
    const dt = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const tm = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const crc = crc32buf(data);
    const sz = data.length;

    const lh = Buffer.alloc(30 + nb.length);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(0, 8); lh.writeUInt16LE(tm, 10); lh.writeUInt16LE(dt, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(sz, 18); lh.writeUInt32LE(sz, 22);
    lh.writeUInt16LE(nb.length, 26); lh.writeUInt16LE(0, 28); nb.copy(lh, 30);
    parts.push(lh, data);

    const cd = Buffer.alloc(46 + nb.length);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8); cd.writeUInt16LE(0, 10); cd.writeUInt16LE(tm, 12);
    cd.writeUInt16LE(dt, 14); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(sz, 20);
    cd.writeUInt32LE(sz, 24); cd.writeUInt16LE(nb.length, 28); cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32); cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38); cd.writeUInt32LE(off, 42); nb.copy(cd, 46);
    cds.push(cd);
    off += lh.length + sz;
  }
  const cdBuf = Buffer.concat(cds);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(off, 16); eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, cdBuf, eocd]);
}

const ZIP_MAX_FILE_BYTES = 50 * 1024 * 1024; // skip files > 50 MB in ZIP
const LOG_EXTS = new Set([".csv", ".json", ".log"]);

function listLogFiles() {
  return readdirSync(LOGS_DIR, { withFileTypes: true })
    .filter((d) => d.isFile() && LOG_EXTS.has(path.extname(d.name)))
    .map((d) => {
      const st = statSync(path.join(LOGS_DIR, d.name));
      return { name: d.name, size: st.size, modified: st.mtime.toISOString() };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ── CSV parsing ──────────────────────────────────────────────────────────────

function parseCsv(filepath) {
  if (!existsSync(filepath)) return [];
  const lines = readFileSync(filepath, "utf8").trim().split("\n");
  if (lines.length < 2) return [];
  const headers = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const vals = line.split(",");
    return Object.fromEntries(headers.map((h, i) => [h, vals[i] ?? ""]));
  });
}

function parseNum(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function coerceTrades(rows) {
  return rows.map((r) => ({
    ...r,
    entry_price: parseNum(r.entry_price),
    exit_price: parseNum(r.exit_price),
    shares: parseNum(r.shares),
    invested: parseNum(r.invested),
    exit_value: parseNum(r.exit_value),
    pnl: parseNum(r.pnl),
    roi_pct: parseNum(r.roi_pct),
    duration_s: parseNum(r.duration_s),
    ptb_at_entry: parseNum(r.ptb_at_entry),
    btc_at_entry: parseNum(r.btc_at_entry),
    btc_vs_ptb_at_entry: parseNum(r.btc_vs_ptb_at_entry),
    market_up_at_entry: parseNum(r.market_up_at_entry),
    market_down_at_entry: parseNum(r.market_down_at_entry),
  }));
}

function coerceSignals15m(rows) {
  return rows.map((r) => ({
    ...r,
    time_left_min: parseNum(r.time_left_min),
    btc_price: parseNum(r.btc_price),
    market_up: parseNum(r.market_up),
    market_down: parseNum(r.market_down),
    model_up: parseNum(r.model_up),
    model_down: parseNum(r.model_down),
    edge_up: parseNum(r.edge_up),
    edge_down: parseNum(r.edge_down),
    rsi: parseNum(r.rsi),
    rsi_slope: parseNum(r.rsi_slope),
    macd_hist: parseNum(r.macd_hist),
    ha_count: parseNum(r.ha_count),
    vwap: parseNum(r.vwap),
    vwap_dist_pct: parseNum(r.vwap_dist_pct),
    vwap_slope: parseNum(r.vwap_slope),
    sim_entry_price: parseNum(r.sim_entry_price),
    sim_current_price: parseNum(r.sim_current_price),
    sim_roi_pct: parseNum(r.sim_roi_pct),
    sim_pnl: parseNum(r.sim_pnl),
    sim_cum_pnl: parseNum(r.sim_cum_pnl) ?? 0,
    sim_invested: parseNum(r.sim_invested),
  }));
}

function coerceSignals5m(rows) {
  return rows.map((r) => ({
    ...r,
    time_left_min: parseNum(r.time_left_min),
    btc_price: parseNum(r.btc_price),
    market_up: parseNum(r.market_up),
    market_down: parseNum(r.market_down),
    model_up: parseNum(r.model_up),
    model_down: parseNum(r.model_down),
    edge_up: parseNum(r.edge_up),
    edge_down: parseNum(r.edge_down),
    ofi_30s: parseNum(r.ofi_30s),
    ofi_1m: parseNum(r.ofi_1m),
    ofi_2m: parseNum(r.ofi_2m),
    roc1: parseNum(r.roc1),
    roc3: parseNum(r.roc3),
    rsi: parseNum(r.rsi),
    ha_count: parseNum(r.ha_count),
    vwap: parseNum(r.vwap),
    vwap_dist_pct: parseNum(r.vwap_dist_pct),
    vwap_slope: parseNum(r.vwap_slope),
    sim_entry_price: parseNum(r.sim_entry_price),
    sim_current_price: parseNum(r.sim_current_price),
    sim_roi_pct: parseNum(r.sim_roi_pct),
    sim_pnl: parseNum(r.sim_pnl),
    sim_cum_pnl: parseNum(r.sim_cum_pnl) ?? 0,
    sim_invested: parseNum(r.sim_invested),
  }));
}

// ── Stats computation ────────────────────────────────────────────────────────

function computeStats(trades) {
  if (trades.length === 0) {
    return {
      totalTrades: 0, wins: 0, losses: 0, winRate: 0,
      totalPnl: 0, avgPnl: 0, avgWin: 0, avgLoss: 0, profitFactor: 0,
      maxWinRoi: 0, maxLossRoi: 0, avgDurationS: 0,
      maxWinStreak: 0, maxLossStreak: 0,
      firstEntry: null, lastExit: null,
      byReason: {}, bySide: {}, pnlCurve: [],
    };
  }

  const wins = trades.filter((t) => t.pnl > 0).length;
  const losses = trades.length - wins;
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const winTrades = trades.filter((t) => t.pnl > 0);
  const lossTrades = trades.filter((t) => t.pnl <= 0);
  const avgWin = winTrades.length ? winTrades.reduce((s, t) => s + t.pnl, 0) / winTrades.length : 0;
  const avgLoss = lossTrades.length ? lossTrades.reduce((s, t) => s + t.pnl, 0) / lossTrades.length : 0;
  const profitFactor = lossTrades.length && avgLoss !== 0
    ? Math.abs(avgWin * winTrades.length) / Math.abs(avgLoss * lossTrades.length)
    : Infinity;

  const byReason = {};
  const bySide = {};
  for (const t of trades) {
    const r = t.exit_reason || "UNKNOWN";
    if (!byReason[r]) byReason[r] = { count: 0, pnl: 0 };
    byReason[r].count++;
    byReason[r].pnl += t.pnl;
    const s = t.side || "UNKNOWN";
    if (!bySide[s]) bySide[s] = { count: 0, wins: 0, pnl: 0 };
    bySide[s].count++;
    bySide[s].pnl += t.pnl;
    if (t.pnl > 0) bySide[s].wins++;
  }

  let maxWinStreak = 0, maxLossStreak = 0, curWin = 0, curLoss = 0;
  for (const t of trades) {
    if (t.pnl > 0) { curWin++; curLoss = 0; maxWinStreak = Math.max(maxWinStreak, curWin); }
    else { curLoss++; curWin = 0; maxLossStreak = Math.max(maxLossStreak, curLoss); }
  }

  const rois = trades.map((t) => t.roi_pct);
  let cum = 0;
  const pnlCurve = trades.map((t) => { cum += t.pnl; return { time: t.exit_time, pnl: parseFloat(cum.toFixed(4)) }; });

  return {
    totalTrades: trades.length,
    wins,
    losses,
    winRate: wins / trades.length,
    totalPnl: parseFloat(totalPnl.toFixed(4)),
    avgPnl: parseFloat((totalPnl / trades.length).toFixed(4)),
    avgWin: parseFloat(avgWin.toFixed(4)),
    avgLoss: parseFloat(avgLoss.toFixed(4)),
    profitFactor: profitFactor === Infinity ? 9999 : parseFloat(profitFactor.toFixed(4)),
    maxWinRoi: Math.max(...rois),
    maxLossRoi: Math.min(...rois),
    avgDurationS: trades.reduce((s, t) => s + (t.duration_s ?? 0), 0) / trades.length,
    maxWinStreak,
    maxLossStreak,
    firstEntry: trades[0]?.entry_time ?? null,
    lastExit: trades[trades.length - 1]?.exit_time ?? null,
    byReason,
    bySide,
    pnlCurve,
  };
}

// ── Static file serving ──────────────────────────────────────────────────────

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

function serveStatic(urlPath, res) {
  if (!existsSync(DIST_DIR)) {
    res.writeHead(503, { "Content-Type": "text/plain" });
    res.end("Dashboard not built yet. Run: cd dashboard && npm run build");
    return;
  }

  let filePath = path.join(DIST_DIR, urlPath === "/" ? "index.html" : urlPath);
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = path.join(DIST_DIR, "index.html");
  }

  try {
    const data = readFileSync(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404); res.end("Not found");
  }
}

// ── Request handler ──────────────────────────────────────────────────────────

function json(res, data) {
  const body = JSON.stringify(data);
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST" });
    res.end(); return;
  }

  try {
    if (p === "/api/trades/15m") {
      const rows = coerceTrades(parseCsv(path.join(LOGS_DIR, "dryrun_15m_trades.csv")));
      return json(res, rows);
    }

    if (p === "/api/trades/5m") {
      const rows = coerceTrades(parseCsv(path.join(LOGS_DIR, "dryrun_5m_trades.csv")));
      return json(res, rows);
    }

    if (p === "/api/stats") {
      const t15 = coerceTrades(parseCsv(path.join(LOGS_DIR, "dryrun_15m_trades.csv")));
      const t5 = coerceTrades(parseCsv(path.join(LOGS_DIR, "dryrun_5m_trades.csv")));
      return json(res, { "15m": computeStats(t15), "5m": computeStats(t5) });
    }

    if (p === "/api/live") {
      const rows15 = coerceSignals15m(parseCsv(path.join(LOGS_DIR, "dryrun_15m.csv")));
      const rows5 = coerceSignals5m(parseCsv(path.join(LOGS_DIR, "dryrun_5m.csv")));
      return json(res, {
        "15m": rows15.length ? rows15[rows15.length - 1] : null,
        "5m": rows5.length ? rows5[rows5.length - 1] : null,
      });
    }

    if (p === "/api/files") {
      return json(res, listLogFiles());
    }

    if (p === "/api/files/download") {
      const name = url.searchParams.get("name") ?? "";
      if (!name || name.includes("/") || name.includes("\\") || name.startsWith(".")) {
        res.writeHead(400); res.end("Invalid filename"); return;
      }
      const fp = path.join(LOGS_DIR, name);
      if (!existsSync(fp) || statSync(fp).isDirectory()) { res.writeHead(404); res.end("Not found"); return; }
      const st = statSync(fp);
      const extMime = { ".csv": "text/csv", ".json": "application/json", ".log": "text/plain" };
      res.writeHead(200, {
        "Content-Type": extMime[path.extname(name)] ?? "application/octet-stream",
        "Content-Disposition": `attachment; filename="${name}"`,
        "Content-Length": st.size,
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      });
      createReadStream(fp).pipe(res);
      return;
    }

    if (p === "/api/files/zip") {
      const files = listLogFiles().filter((f) => f.size <= ZIP_MAX_FILE_BYTES);
      const entries = files.map(({ name, modified }) => ({
        name,
        data: readFileSync(path.join(LOGS_DIR, name)),
        mtime: new Date(modified),
      }));
      const zip = buildZip(entries);
      const date = new Date().toISOString().slice(0, 10);
      res.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="polymarket-logs-${date}.zip"`,
        "Content-Length": zip.length,
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(zip);
      return;
    }

    if (p === "/api/logs/clear" && req.method === "POST") {
      const CSV_FILES = [
        "dryrun_15m.csv",
        "dryrun_5m.csv",
        "dryrun_15m_trades.csv",
        "dryrun_5m_trades.csv",
        "signals.csv",
        "signals_5m.csv",
      ];
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const archiveDir = path.join(LOGS_DIR, "archive", ts);
      mkdirSync(archiveDir, { recursive: true });
      const cleared = [];
      for (const name of CSV_FILES) {
        const fp = path.join(LOGS_DIR, name);
        if (!existsSync(fp)) continue;
        copyFileSync(fp, path.join(archiveDir, name));
        const content = readFileSync(fp, "utf8");
        const header = content.split("\n")[0];
        writeFileSync(fp, header + "\n", "utf8");
        cleared.push(name);
      }
      return json(res, { ok: true, cleared, archive: `archive/${ts}` });
    }

    if (p.startsWith("/api/")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" })); return;
    }

    serveStatic(p, res);
  } catch (err) {
    console.error(err);
    res.writeHead(500); res.end(err.message);
  }
});

server.listen(PORT, () => console.log(`Dashboard server on http://0.0.0.0:${PORT}`));
