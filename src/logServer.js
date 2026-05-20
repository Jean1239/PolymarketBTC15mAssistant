import http from "http";
import { createReadStream, readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, existsSync, statSync, openSync, fstatSync, readSync, closeSync } from "fs";
import { readdir } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { toNodeHandler, fromNodeHeaders } from "better-auth/node";
import { getAuth } from "./auth/instance.js";
import { runMigrations } from "./auth/migrate.js";
import { seedAdmin } from "./auth/seedAdmin.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const LOGS_DIR = path.join(ROOT, "logs");
const DIST_DIR = path.join(ROOT, "dashboard", "dist");
const PORT = process.env.LOG_SERVER_PORT ?? 3456;

// Selects which trade journal the /api/trades/* and /api/stats endpoints read.
// "sim"  (default) → dryrun_{15m,5m}_trades.csv  (paper-trading simulator)
// "real"           → real_{15m,5m}_trades.csv    (executed live orders)
// The per-tick /api/live endpoint always reads the dryrun CSVs because they
// are the only tick-by-tick source the bots emit.
const TRADE_SOURCE = (process.env.DASHBOARD_TRADE_SOURCE ?? "sim").toLowerCase() === "real" ? "real" : "sim";
const TRADES_FILE = {
  "15m": TRADE_SOURCE === "real" ? "real_15m_trades.csv" : "dryrun_15m_trades.csv",
  "5m":  TRADE_SOURCE === "real" ? "real_5m_trades.csv"  : "dryrun_5m_trades.csv",
};

// Polymarket taker fee model for crypto markets.
// Source: https://docs.polymarket.com/trading/fees — fees apply only to taker
// orders on crypto markets (BTC/ETH/SOL/XRP, all timeframes since 2026-03).
// Formula:   fee_per_side = trade_value × feeRate × (p × (1-p))^exponent
// Crypto category: exponent = 1; the feeRate (`r` in the CLOB market info)
// peaks the effective rate at feeRate × 0.25 when p = 0.50 and decays toward
// the extremes. Defaults below give ≈2.5% peak per side (matching the
// "up to ~3%" range reported when 15m fees launched). Override via env vars.
//
// Settlement (SETTLED_WIN / SETTLED_LOSS) is an on-chain CTF redemption, not
// a trade — no taker fee is charged on that leg.
const FEE_RATE = (() => {
  const raw = parseFloat(process.env.POLYMARKET_FEE_RATE ?? "0.10");
  return Number.isFinite(raw) && raw >= 0 ? raw : 0.10;
})();
const FEE_EXPONENT = (() => {
  const raw = parseFloat(process.env.POLYMARKET_FEE_EXPONENT ?? "1");
  return Number.isFinite(raw) && raw >= 0 ? raw : 1;
})();

function feePerSide(tradeValue, price) {
  if (!Number.isFinite(tradeValue) || tradeValue <= 0) return 0;
  if (!Number.isFinite(price) || price <= 0 || price >= 1) return 0;
  return tradeValue * FEE_RATE * Math.pow(price * (1 - price), FEE_EXPONENT);
}

function feeForTrade(t) {
  const entryFee = feePerSide(t.invested, t.entry_price);
  const exitIsSettlement = typeof t.exit_reason === "string" && t.exit_reason.startsWith("SETTLED");
  const exitFee = exitIsSettlement ? 0 : feePerSide(t.exit_value, t.exit_price);
  return entryFee + exitFee;
}

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

// Reads the last `lines` lines of a file by tailing from EOF in 16 KB chunks.
// Memory bounded — never loads the full file even if it's 100 MB.
function tailFile(filepath, lines) {
  if (!existsSync(filepath)) return null;
  const st = statSync(filepath);
  if (st.isDirectory()) return null;
  const totalSize = st.size;
  if (totalSize === 0) return { lines: [], totalSize, truncated: false };

  const CHUNK = 16 * 1024;
  const wanted = Math.max(1, Math.min(lines, 5000));
  let fd;
  try {
    fd = openSync(filepath, "r");
    let pos = totalSize;
    let collected = "";
    let newlines = 0;
    while (pos > 0 && newlines <= wanted) {
      const readSize = Math.min(CHUNK, pos);
      pos -= readSize;
      const buf = Buffer.alloc(readSize);
      readSync(fd, buf, 0, readSize, pos);
      const chunk = buf.toString("utf8");
      collected = chunk + collected;
      newlines = (collected.match(/\n/g) ?? []).length;
    }
    const all = collected.split("\n");
    if (all.length && all[all.length - 1] === "") all.pop();
    const truncated = all.length > wanted || pos > 0;
    const tail = all.slice(-wanted);
    return { lines: tail, totalSize, truncated };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// Returns whether the 15m / 5m bot is currently writing ticks.
// A bot is "active" when its tick CSV (dryrun_{15m,5m}.csv) was modified
// within the last `staleSeconds` window. 60s is generous (poll is 1s) so
// brief stalls don't blink the UI off.
function getBotStatus(staleSeconds = 60) {
  const result = {};
  for (const tf of ["15m", "5m"]) {
    const fp = path.join(LOGS_DIR, `dryrun_${tf}.csv`);
    if (!existsSync(fp)) {
      result[tf] = { active: false, lastTickAgoS: null, exists: false };
      continue;
    }
    const st = statSync(fp);
    const ageS = Math.round((Date.now() - st.mtime.getTime()) / 1000);
    result[tf] = { active: ageS <= staleSeconds, lastTickAgoS: ageS, exists: true };
  }
  return result;
}

// Parses "ISO_TIMESTAMP rest..." log lines into {timestamp, message}.
const LOG_LINE_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s+(.*)$/;

function parseTradeEventLines(lines, type) {
  const out = [];
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (!line) continue;
    const m = LOG_LINE_RE.exec(line);
    if (m) out.push({ timestamp: m[1], type, message: m[2] });
    else out.push({ timestamp: null, type, message: line });
  }
  return out;
}

function getTradeEvents(limit) {
  const want = Math.max(1, Math.min(limit, 200));
  // Pull more than `want` from each file so the merge has enough to interleave.
  const perFile = want * 2;
  const orders = tailFile(path.join(LOGS_DIR, "trade_orders.log"), perFile);
  const errors = tailFile(path.join(LOGS_DIR, "trade_errors.log"), perFile);
  const events = [
    ...(orders ? parseTradeEventLines(orders.lines, "order") : []),
    ...(errors ? parseTradeEventLines(errors.lines, "error") : []),
  ];
  events.sort((a, b) => {
    const ta = a.timestamp ?? "";
    const tb = b.timestamp ?? "";
    return tb.localeCompare(ta); // newest first
  });
  return events.slice(0, want);
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

// Reads only the header line + last data line — O(1) memory regardless of file size.
function readLastCsvRow(filepath) {
  if (!existsSync(filepath)) return null;
  let fd;
  try {
    fd = openSync(filepath, "r");
    const { size } = fstatSync(fd);
    if (size === 0) return null;

    const hBuf = Buffer.alloc(Math.min(2048, size));
    readSync(fd, hBuf, 0, hBuf.length, 0);
    const hEnd = hBuf.indexOf(10); // '\n'
    if (hEnd < 0) return null;
    const headerLine = hBuf.subarray(0, hEnd).toString("utf8").replace(/\r$/, "");

    const CHUNK = Math.min(16384, size);
    const tBuf = Buffer.alloc(CHUNK);
    readSync(fd, tBuf, 0, CHUNK, size - CHUNK);
    const lines = tBuf.toString("utf8").split("\n");

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line || line.startsWith("timestamp,")) continue;
      const headers = headerLine.split(",");
      const vals = line.split(",");
      return Object.fromEntries(headers.map((h, j) => [h, vals[j] ?? ""]));
    }
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function parseNum(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function coerceTrades(rows) {
  return rows.map((r) => {
    const t = {
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
    };
    const fee = feeForTrade(t);
    t.fee = parseFloat(fee.toFixed(4));
    t.pnl_net = t.pnl != null ? parseFloat((t.pnl - fee).toFixed(4)) : null;
    return t;
  });
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
      feeRate: FEE_RATE, feeExponent: FEE_EXPONENT,
      totalFees: 0, totalPnlNet: 0, avgFee: 0,
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
  let cumNet = 0;
  const pnlCurve = trades.map((t) => {
    cum += t.pnl;
    cumNet += (t.pnl_net ?? t.pnl);
    return {
      time: t.exit_time,
      pnl: parseFloat(cum.toFixed(4)),
      pnlNet: parseFloat(cumNet.toFixed(4)),
    };
  });

  const totalFees = trades.reduce((s, t) => s + (t.fee ?? 0), 0);
  const totalPnlNet = totalPnl - totalFees;

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
    feeRate: FEE_RATE,
    feeExponent: FEE_EXPONENT,
    totalFees: parseFloat(totalFees.toFixed(4)),
    totalPnlNet: parseFloat(totalPnlNet.toFixed(4)),
    avgFee: parseFloat((totalFees / trades.length).toFixed(4)),
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

// ── Strategy registry helpers ────────────────────────────────────────────────

function loadStrategyRegistry(bot) {
  const p = path.join(LOGS_DIR, `strategy_versions_${bot}.json`);
  if (!existsSync(p)) return [];
  try {
    const arr = JSON.parse(readFileSync(p, "utf8"));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return null; // sentinel for "exists but unparseable"
  }
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

function buildStrategiesResponse(bot) {
  const raw = loadStrategyRegistry(bot);
  if (raw === null) return { error: "registry_parse_error", status: 500 };
  raw.sort((a, b) => (a.detectedAt ?? "").localeCompare(b.detectedAt ?? ""));

  let prevConfig = null;
  const versions = raw.map((v, i) => {
    const next = raw[i + 1];
    const out = {
      hash: v.hash,
      label: v.label,
      startedAt: v.detectedAt,
      endedAt: next ? next.detectedAt : null,
      source: v.source ?? "auto",
      partial: v.partial ?? false,
      fieldsVersion: v.fieldsVersion ?? 1,
      config: v.config ?? null,
      configDiff: computeConfigDiff(prevConfig, v.config),
    };
    prevConfig = v.config ?? prevConfig;
    return out;
  });

  const unknown = versions.find(v => v.hash === "unknown") ?? null;
  return {
    versions, // includes unknown if present
    unknownPeriod: unknown ? { startedAt: null, endedAt: unknown.endedAt } : null,
    backfillSource: raw.some(v => v.source === "backfill") ? "STRATEGY_LOG.md" : null,
  };
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

const auth = getAuth();
const authHandler = toNodeHandler(auth);

const PUBLIC_API_PATHS = new Set(["/api/health"]);

async function isAuthenticated(req) {
  try {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    return Boolean(session?.user);
  } catch {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST" });
    res.end(); return;
  }

  // better-auth owns /api/auth/* (sign-in, sign-out, session, etc.)
  if (p.startsWith("/api/auth")) {
    return authHandler(req, res);
  }

  // Health check is public so Coolify/Docker can probe without a session.
  if (p === "/api/health") {
    return json(res, { ok: true });
  }

  // All other /api/* routes require an authenticated session.
  if (p.startsWith("/api/")) {
    const ok = await isAuthenticated(req);
    if (!ok) {
      res.writeHead(401, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
  }

  try {
    if (p === "/api/trades/15m") {
      const rows = coerceTrades(parseCsv(path.join(LOGS_DIR, TRADES_FILE["15m"])));
      return json(res, rows);
    }

    if (p === "/api/trades/5m") {
      const rows = coerceTrades(parseCsv(path.join(LOGS_DIR, TRADES_FILE["5m"])));
      return json(res, rows);
    }

    if (p === "/api/strategies/15m" || p === "/api/strategies/5m") {
      const bot = p.endsWith("/15m") ? "15m" : "5m";
      const body = buildStrategiesResponse(bot);
      if (body.error) {
        res.writeHead(body.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: body.error }));
        return;
      }
      return json(res, body);
    }

    if (p === "/api/stats") {
      const t15 = coerceTrades(parseCsv(path.join(LOGS_DIR, TRADES_FILE["15m"])));
      const t5 = coerceTrades(parseCsv(path.join(LOGS_DIR, TRADES_FILE["5m"])));
      return json(res, { "15m": computeStats(t15), "5m": computeStats(t5), source: TRADE_SOURCE });
    }

    if (p === "/api/live") {
      const row15 = readLastCsvRow(path.join(LOGS_DIR, "dryrun_15m.csv"));
      const row5  = readLastCsvRow(path.join(LOGS_DIR, "dryrun_5m.csv"));
      return json(res, {
        "15m": row15 ? coerceSignals15m([row15])[0] : null,
        "5m":  row5  ? coerceSignals5m([row5])[0]   : null,
      });
    }

    if (p === "/api/files") {
      return json(res, listLogFiles());
    }

    if (p === "/api/files/tail") {
      const name = url.searchParams.get("name") ?? "";
      if (!name || name.includes("/") || name.includes("\\") || name.startsWith(".")) {
        res.writeHead(400); res.end("Invalid filename"); return;
      }
      const linesParam = parseInt(url.searchParams.get("lines") ?? "50", 10);
      const lines = Number.isFinite(linesParam) && linesParam > 0 ? linesParam : 50;
      const fp = path.join(LOGS_DIR, name);
      const result = tailFile(fp, lines);
      if (!result) { res.writeHead(404); res.end("Not found"); return; }
      return json(res, { name, lines: result.lines, totalSize: result.totalSize, truncated: result.truncated });
    }

    if (p === "/api/bots/status") {
      return json(res, getBotStatus());
    }

    if (p === "/api/trade-events") {
      const limitParam = parseInt(url.searchParams.get("limit") ?? "5", 10);
      const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 5;
      return json(res, getTradeEvents(limit));
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

    if (p === "/api/files/zip-selected" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        let names;
        try {
          ({ names } = JSON.parse(body));
        } catch {
          res.writeHead(400); res.end("Invalid JSON"); return;
        }
        if (!Array.isArray(names) || names.length === 0) {
          res.writeHead(400); res.end("names must be a non-empty array"); return;
        }
        const invalid = names.find((n) => typeof n !== "string" || n.includes("/") || n.includes("\\") || n.startsWith("."));
        if (invalid) { res.writeHead(400); res.end("Invalid filename"); return; }

        const date = new Date().toISOString().slice(0, 10);
        res.writeHead(200, {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="polymarket-logs-selected-${date}.zip"`,
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*",
        });
        const cds = [];
        let globalOffset = 0;
        for (const name of names) {
          const fp = path.join(LOGS_DIR, name);
          if (!existsSync(fp) || statSync(fp).isDirectory()) continue;
          if (statSync(fp).size > ZIP_MAX_FILE_BYTES) continue;
          const data = readFileSync(fp);
          const nb = Buffer.from(name, "utf8");
          const d = new Date(statSync(fp).mtime);
          const dt = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
          const tm = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
          const crc = crc32buf(data);
          const sz = data.length;
          const localOff = globalOffset;
          const lh = Buffer.alloc(30 + nb.length);
          lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
          lh.writeUInt16LE(0, 8); lh.writeUInt16LE(tm, 10); lh.writeUInt16LE(dt, 12);
          lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(sz, 18); lh.writeUInt32LE(sz, 22);
          lh.writeUInt16LE(nb.length, 26); lh.writeUInt16LE(0, 28); nb.copy(lh, 30);
          res.write(lh);
          res.write(data);
          globalOffset += lh.length + sz;
          const cd = Buffer.alloc(46 + nb.length);
          cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
          cd.writeUInt16LE(0, 8); cd.writeUInt16LE(0, 10); cd.writeUInt16LE(tm, 12);
          cd.writeUInt16LE(dt, 14); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(sz, 20);
          cd.writeUInt32LE(sz, 24); cd.writeUInt16LE(nb.length, 28); cd.writeUInt16LE(0, 30);
          cd.writeUInt16LE(0, 32); cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36);
          cd.writeUInt32LE(0, 38); cd.writeUInt32LE(localOff, 42); nb.copy(cd, 46);
          cds.push(cd);
        }
        const cdStart = globalOffset;
        for (const cd of cds) { res.write(cd); globalOffset += cd.length; }
        const eocd = Buffer.alloc(22);
        eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
        eocd.writeUInt16LE(cds.length, 8); eocd.writeUInt16LE(cds.length, 10);
        eocd.writeUInt32LE(globalOffset - cdStart, 12); eocd.writeUInt32LE(cdStart, 16);
        eocd.writeUInt16LE(0, 20);
        res.end(eocd);
      });
      return;
    }

    if (p === "/api/files/zip") {
      const files = listLogFiles().filter((f) => f.size <= ZIP_MAX_FILE_BYTES);
      const date = new Date().toISOString().slice(0, 10);
      res.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="polymarket-logs-${date}.zip"`,
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
        // No Content-Length — chunked transfer, one file at a time
      });
      const cds = [];
      let globalOffset = 0;
      for (const { name, modified } of files) {
        const fp = path.join(LOGS_DIR, name);
        if (!existsSync(fp)) continue;
        const data = readFileSync(fp);
        const nb = Buffer.from(name, "utf8");
        const d = new Date(modified);
        const dt = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
        const tm = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
        const crc = crc32buf(data);
        const sz = data.length;
        const localOff = globalOffset;
        const lh = Buffer.alloc(30 + nb.length);
        lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
        lh.writeUInt16LE(0, 8); lh.writeUInt16LE(tm, 10); lh.writeUInt16LE(dt, 12);
        lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(sz, 18); lh.writeUInt32LE(sz, 22);
        lh.writeUInt16LE(nb.length, 26); lh.writeUInt16LE(0, 28); nb.copy(lh, 30);
        res.write(lh);
        res.write(data);
        globalOffset += lh.length + sz;
        const cd = Buffer.alloc(46 + nb.length);
        cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
        cd.writeUInt16LE(0, 8); cd.writeUInt16LE(0, 10); cd.writeUInt16LE(tm, 12);
        cd.writeUInt16LE(dt, 14); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(sz, 20);
        cd.writeUInt32LE(sz, 24); cd.writeUInt16LE(nb.length, 28); cd.writeUInt16LE(0, 30);
        cd.writeUInt16LE(0, 32); cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36);
        cd.writeUInt32LE(0, 38); cd.writeUInt32LE(localOff, 42); nb.copy(cd, 46);
        cds.push(cd);
      }
      const cdStart = globalOffset;
      for (const cd of cds) { res.write(cd); globalOffset += cd.length; }
      const eocd = Buffer.alloc(22);
      eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
      eocd.writeUInt16LE(cds.length, 8); eocd.writeUInt16LE(cds.length, 10);
      eocd.writeUInt32LE(globalOffset - cdStart, 12); eocd.writeUInt32LE(cdStart, 16);
      eocd.writeUInt16LE(0, 20);
      res.end(eocd);
      return;
    }

    if (p === "/api/logs/clear" && req.method === "POST") {
      const CSV_FILES = [
        "dryrun_15m.csv",
        "dryrun_5m.csv",
        "dryrun_15m_trades.csv",
        "dryrun_5m_trades.csv",
        "real_15m_trades.csv",
        "real_5m_trades.csv",
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
        const hBuf = Buffer.alloc(4096);
        const hFd = openSync(fp, "r");
        const hRead = readSync(hFd, hBuf, 0, hBuf.length, 0);
        closeSync(hFd);
        const hEnd = hBuf.indexOf(10, 0); // first newline
        const header = hBuf.subarray(0, hEnd >= 0 ? hEnd : hRead).toString("utf8").replace(/\r$/, "");
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

async function bootstrap() {
  if (process.env.SKIP_DB_MIGRATIONS !== "true") {
    try {
      await runMigrations();
      console.log("DB migrations applied");
    } catch (err) {
      console.error("DB migrations failed:", err.message);
      throw err;
    }
  }

  try {
    const result = await seedAdmin();
    console.log("Admin seed:", result);
  } catch (err) {
    console.error("Admin seed failed:", err.message);
    throw err;
  }

  server.listen(PORT, () => console.log(`Dashboard server on http://0.0.0.0:${PORT}`));
}

bootstrap().catch((err) => {
  console.error("Bootstrap failed:", err);
  process.exit(1);
});
