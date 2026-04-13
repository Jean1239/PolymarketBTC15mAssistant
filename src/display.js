// Shared display/rendering utilities used by both 15m and 5m modes.

export const ANSI = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  lightRed: "\x1b[91m",
  gray: "\x1b[90m",
  white: "\x1b[97m",
  dim: "\x1b[2m",
  bold: "\x1b[1m"
};

export function screenWidth() {
  const w = Number(process.stdout?.columns);
  return Number.isFinite(w) && w >= 40 ? w : 80;
}

export function sepLine(ch = "\u2500") {
  const w = screenWidth();
  return `${ANSI.dim}${ch.repeat(w)}${ANSI.reset}`;
}

let _screenInitialized = false;

function initAlternateScreen() {
  process.stdout.write("\x1b[?1049h\x1b[H");
  const restoreScreen = () => {
    try { process.stdout.write("\x1b[?1049l"); } catch { /* ignore */ }
  };
  process.once("exit", restoreScreen);
  process.once("SIGINT", () => { restoreScreen(); process.exit(0); });
  process.once("SIGTERM", () => { restoreScreen(); process.exit(0); });
}

export function renderScreen(text) {
  try {
    if (!_screenInitialized) {
      initAlternateScreen();
      _screenInitialized = true;
    }
    const maxRows = (process.stdout.rows ?? 24) - 1;
    const lines = text.split("\n").slice(0, maxRows);
    const output = "\x1b[H" + lines.map(l => l + "\x1b[K").join("\n") + "\x1b[J";
    process.stdout.write(output);
  } catch {
    // ignore
  }
}

export function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, "");
}

function visLen(s) {
  return stripAnsi(String(s)).length;
}

function padRight(s, width) {
  const pad = width - visLen(s);
  return pad > 0 ? s + " ".repeat(pad) : s;
}

export function padLabel(label, width) {
  const visible = visLen(label);
  if (visible >= width) return label;
  return label + " ".repeat(width - visible);
}

export function centerText(text, width) {
  const visible = visLen(text);
  if (visible >= width) return text;
  const left = Math.floor((width - visible) / 2);
  return " ".repeat(left) + text;
}

export const LABEL_W = 14;

export function kv(label, value) {
  return `${padLabel(String(label), LABEL_W)}${value}`;
}

export function section(title) {
  return `${ANSI.white}${ANSI.bold}${title}${ANSI.reset}`;
}

// Merge left and right column arrays into full-width lines
function mergeColumns(left, right, totalWidth) {
  const colW = Math.floor(totalWidth / 2) - 1;
  const len = Math.max(left.length, right.length);
  const out = [];
  for (let i = 0; i < len; i++) {
    const l = padRight(left[i] ?? "", colW);
    const r = right[i] ?? "";
    out.push(`${l} ${ANSI.dim}\u2502${ANSI.reset} ${r}`);
  }
  return out;
}

export function colorPriceLine({ label, price, prevPrice, decimals = 0, prefix = "" }) {
  if (price === null || price === undefined) {
    return `${label}: ${ANSI.gray}-${ANSI.reset}`;
  }
  const p = Number(price);
  const prev = prevPrice === null || prevPrice === undefined ? null : Number(prevPrice);
  let color = ANSI.reset;
  let arrow = "";
  if (prev !== null && Number.isFinite(prev) && Number.isFinite(p) && p !== prev) {
    if (p > prev) { color = ANSI.green; arrow = " \u2191"; }
    else { color = ANSI.red; arrow = " \u2193"; }
  }
  const formatted = `${prefix}${formatNumberDisplay(p, decimals)}`;
  return `${color}${formatted}${arrow}${ANSI.reset}`;
}

export function formatNumberDisplay(x, digits = 0) {
  if (x === null || x === undefined || Number.isNaN(x)) return "-";
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  }).format(x);
}

export function formatSignedDelta(delta, base) {
  if (delta === null || base === null || base === 0) return `${ANSI.gray}-${ANSI.reset}`;
  const sign = delta > 0 ? "+" : delta < 0 ? "-" : "";
  const pct = (Math.abs(delta) / Math.abs(base)) * 100;
  return `${sign}$${Math.abs(delta).toFixed(2)}, ${sign}${pct.toFixed(2)}%`;
}

export function colorByNarrative(text, narrative) {
  if (narrative === "LONG") return `${ANSI.green}${text}${ANSI.reset}`;
  if (narrative === "SHORT") return `${ANSI.red}${text}${ANSI.reset}`;
  return `${ANSI.gray}${text}${ANSI.reset}`;
}

export function formatNarrativeValue(label, value, narrative) {
  return `${label}: ${colorByNarrative(value, narrative)}`;
}

export function narrativeFromSign(x) {
  if (x === null || x === undefined || !Number.isFinite(Number(x)) || Number(x) === 0) return "NEUTRAL";
  return Number(x) > 0 ? "LONG" : "SHORT";
}

export function narrativeFromRsi(rsi) {
  if (rsi === null || rsi === undefined || !Number.isFinite(Number(rsi))) return "NEUTRAL";
  const v = Number(rsi);
  if (v >= 55) return "LONG";
  if (v <= 45) return "SHORT";
  return "NEUTRAL";
}

export function narrativeFromSlope(slope) {
  if (slope === null || slope === undefined || !Number.isFinite(Number(slope)) || Number(slope) === 0) return "NEUTRAL";
  return Number(slope) > 0 ? "LONG" : "SHORT";
}

export function formatProbPct(p, digits = 0) {
  if (p === null || p === undefined || !Number.isFinite(Number(p))) return "-";
  return `${(Number(p) * 100).toFixed(digits)}%`;
}

export function fmtEtTime(now = new Date()) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
    }).format(now);
  } catch { return "-"; }
}

export function fmtEtHHMM(dateOrMs) {
  try {
    const d = typeof dateOrMs === "number" ? new Date(dateOrMs) : dateOrMs;
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit", minute: "2-digit", hour12: false
    }).format(d);
  } catch { return "-"; }
}

export function getBtcSession(now = new Date()) {
  const h = now.getUTCHours();
  const inAsia = h >= 0 && h < 8;
  const inEurope = h >= 7 && h < 16;
  const inUs = h >= 13 && h < 22;
  if (inEurope && inUs) return "EU/US";
  if (inAsia && inEurope) return "Asia/EU";
  if (inAsia) return "Asia";
  if (inEurope) return "Europe";
  if (inUs) return "US";
  return "Off-hours";
}

export function fmtTimeLeft(mins) {
  const totalSeconds = Math.max(0, Math.floor(mins * 60));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function parsePriceToBeat(market) {
  const text = String(market?.question ?? market?.title ?? "");
  if (!text) return null;
  const m = text.match(/price\s*to\s*beat[^\d$]*\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i);
  if (!m) return null;
  const raw = m[1].replace(/,/g, "");
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function safeFileSlug(x) {
  return String(x ?? "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/(^-|-$)/g, "").slice(0, 120);
}

export function extractNumericFromMarket(market) {
  const directKeys = [
    "priceToBeat", "price_to_beat", "strikePrice", "strike_price",
    "strike", "threshold", "thresholdPrice", "threshold_price",
    "targetPrice", "target_price", "referencePrice", "reference_price"
  ];
  for (const k of directKeys) {
    const v = market?.[k];
    const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
    if (Number.isFinite(n)) return n;
  }
  const seen = new Set();
  const stack = [{ obj: market, depth: 0 }];
  while (stack.length) {
    const { obj, depth } = stack.pop();
    if (!obj || typeof obj !== "object") continue;
    if (seen.has(obj) || depth > 6) continue;
    seen.add(obj);
    const entries = Array.isArray(obj) ? obj.entries() : Object.entries(obj);
    for (const [key, value] of entries) {
      const k = String(key).toLowerCase();
      if (value && typeof value === "object") { stack.push({ obj: value, depth: depth + 1 }); continue; }
      if (!/(price|strike|threshold|target|beat)/i.test(k)) continue;
      const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
      if (!Number.isFinite(n)) continue;
      if (n > 1000 && n < 2_000_000) return n;
    }
  }
  return null;
}

export function priceToBeatFromPolymarketMarket(market) {
  const n = extractNumericFromMarket(market);
  if (n !== null) return n;
  return parsePriceToBeat(market);
}

// --- Trading display helpers ---

let _statusMsg = { text: "", expiresAt: 0 };

export function setStatusMessage(text, durationMs = 3000) {
  _statusMsg = { text, expiresAt: Date.now() + durationMs };
}

export function getStatusLine() {
  if (_statusMsg.expiresAt > Date.now() && _statusMsg.text) {
    return `${ANSI.yellow}${_statusMsg.text}${ANSI.reset}`;
  }
  return null;
}

const EXIT_REASON_LABEL = {
  TAKE_PROFIT:    "REALIZAR LUCRO",
  STOP_LOSS:      "STOP LOSS",
  SIGNAL_FLIPPED: "SINAL INVERTIDO",
  TIME_DECAY:     "TEMPO CURTO",
};

// ─────────────────────────────────────────────────────────
// buildScreen(d) — unified 2-column layout for 15m and 5m
// ─────────────────────────────────────────────────────────
export function buildScreen(d) {
  const W = screenWidth();
  const lines = [];

  // ── HEADER ──
  const titleLine = d.modeTag ? `${d.modeTag} ${d.title}` : d.title;
  lines.push(titleLine);

  // Trading status + shortcuts + clock on a single line
  const etStr = `${ANSI.dim}${fmtEtTime()} ${getBtcSession()}${ANSI.reset}`;
  let tradingBadge;
  if (d.liveTrading) {
    // Live trading mode
    if (d.tradingEnabled) {
      tradingBadge = `${ANSI.green}● LIVE${ANSI.reset} $${d.tradeAmount}`;
      if (d.usdcBalanceError) {
        tradingBadge += `  ${ANSI.red}Saldo: ${d.usdcBalanceError}${ANSI.reset}`;
      } else if (d.usdcBalance != null) {
        tradingBadge += `  ${ANSI.dim}Saldo: ${ANSI.reset}${ANSI.white}$${Number(d.usdcBalance).toFixed(2)} USDC${ANSI.reset}`;
      }
    } else if (d.initError) {
      tradingBadge = `${ANSI.red}● LIVE ERRO${ANSI.reset}`;
    } else {
      tradingBadge = `${ANSI.red}● LIVE (sem chave)${ANSI.reset}`;
    }
  } else {
    // Simulated mode
    tradingBadge = `${ANSI.yellow}● SIM${ANSI.reset} $${d.tradeAmount}`;
  }
  const confirmOrKeys = d.confirmHint ?? d.shortcutsHint ?? "";
  lines.push(`${tradingBadge}  ${confirmOrKeys}${" ".repeat(Math.max(0, W - visLen(tradingBadge) - visLen(confirmOrKeys) - visLen(etStr) - 4))}  ${etStr}`);

  // Status message (errors, confirmations) — always visible
  const statusLine = getStatusLine();
  if (statusLine) {
    lines.push(statusLine);
  }

  lines.push(sepLine());

  // ── TOP ROW: Prices left │ Polymarket right ──
  const leftPrices = [];
  leftPrices.push(section("PRECOS"));
  leftPrices.push(kv("Binance:", d.binanceSpot));
  leftPrices.push(kv("Chainlink:", d.chainlinkLine));
  if (d.priceToBeat !== null) {
    leftPrices.push(kv("Price Beat:", `$${formatNumberDisplay(d.priceToBeat, 0)}`));
  }
  if (d.intervalLine) leftPrices.push(d.intervalLine);

  const rightPoly = [];
  rightPoly.push(section("POLYMARKET"));
  rightPoly.push(`${ANSI.green}\u2191 UP${ANSI.reset} ${d.marketUpStr}  ${ANSI.dim}|${ANSI.reset}  ${ANSI.red}\u2193 DOWN${ANSI.reset} ${d.marketDownStr}`);
  rightPoly.push(kv("Time left:", `${d.timeColor}${fmtTimeLeft(d.timeLeftMin)}${ANSI.reset}`));
  if (d.liquidity !== null) rightPoly.push(kv("Liquidity:", formatNumberDisplay(d.liquidity, 0)));
  rightPoly.push(kv("Market:", d.marketSlug));

  lines.push(...mergeColumns(leftPrices, rightPoly, W));
  lines.push(sepLine());

  // ── MIDDLE ROW: Indicators left │ Signal right ──
  const leftInd = [];
  leftInd.push(section("INDICADORES"));
  for (const ind of d.indicators) {
    leftInd.push(kv(ind.label + ":", ind.value));
  }

  const rightSignal = [];
  rightSignal.push(section("SINAL"));
  rightSignal.push(kv("Predict:", d.predictValue));
  rightSignal.push(kv("Rec:", d.recLine));
  // pad to match left height
  while (rightSignal.length < leftInd.length) rightSignal.push("");

  lines.push(...mergeColumns(leftInd, rightSignal, W));
  lines.push(sepLine());

  // ── BOTTOM ROW: Position left │ History right ──
  const leftPos = [];
  const posLabel = d.liveTrading ? "POSICAO" : "POSICAO (sim)";
  leftPos.push(section(posLabel));

  if (!d.liveTrading && !d.position.active) {
    leftPos.push(`${ANSI.gray}Aguardando sinal...${ANSI.reset}`);
  } else if (d.liveTrading && !d.tradingEnabled) {
    leftPos.push(`${ANSI.gray}Trading desativado${ANSI.reset}`);
  } else if (!d.position.active) {
    leftPos.push(`${ANSI.gray}Nenhuma posicao aberta${ANSI.reset}`);
  } else {
    const p = d.position;
    const sideColor = p.side === "UP" ? ANSI.green : ANSI.red;
    const sideLabel = p.side === "UP" ? "\u2191 UP" : "\u2193 DOWN";
    const entryStr = (p.entryPrice * 100).toFixed(1) + "\u00A2";
    leftPos.push(`${sideColor}${sideLabel}${ANSI.reset} @ ${entryStr}  ${p.shares.toFixed(2)} shares  $${p.invested.toFixed(2)}`);
    if (d.currentMktPrice != null) {
      const val = p.shares * d.currentMktPrice;
      const pnl = val - p.invested;
      const roiPct = (pnl / p.invested) * 100;
      const c = pnl >= 0 ? ANSI.green : ANSI.red;
      const s = pnl >= 0 ? "+" : "";
      leftPos.push(kv("ROI:", `${c}${s}${roiPct.toFixed(1)}%${ANSI.reset}  P&L: ${c}${s}$${pnl.toFixed(2)}${ANSI.reset}  Val: $${val.toFixed(2)}`));
    }
    if (d.exitEval?.shouldSell) {
      const uc = d.exitEval.urgency === "HIGH" ? ANSI.red : ANSI.yellow;
      const label = EXIT_REASON_LABEL[d.exitEval.reason] ?? d.exitEval.reason;
      leftPos.push(`${uc}\u25BA VENDER \u2014 ${label}${ANSI.reset}`);
    }
  }

  const rightHist = [];
  rightHist.push(section("TRADES (paper)"));
  // Paper-trading stats
  const rs = d.runningStats ?? { wins: 0, losses: 0, totalPnl: 0 };
  const total = rs.wins + rs.losses;
  const wr = total > 0 ? `${((rs.wins / total) * 100).toFixed(0)}%` : "-";
  const pc = rs.totalPnl > 0 ? ANSI.green : rs.totalPnl < 0 ? ANSI.red : ANSI.gray;
  const ps = rs.totalPnl > 0 ? "+" : "";
  rightHist.push(`${ANSI.dim}Trades: ${ANSI.reset}${total}  W:${ANSI.green}${rs.wins}${ANSI.reset} L:${ANSI.red}${rs.losses}${ANSI.reset}  WR:${wr}`);
  rightHist.push(`${ANSI.dim}PNL:${ANSI.reset} ${pc}${ps}$${rs.totalPnl.toFixed(2)}${ANSI.reset}`);

  // Recent closed trades
  if (d.closedTrades?.length) {
    for (const t of d.closedTrades.slice(0, 4)) {
      const color = t.pnl >= 0 ? ANSI.green : ANSI.red;
      const pSign = t.pnl >= 0 ? "+" : "";
      const rSign = t.roi >= 0 ? "+" : "";
      const sl = t.side === "UP" ? `${ANSI.green}\u2191UP${ANSI.reset}` : `${ANSI.red}\u2193DN${ANSI.reset}`;
      const ts = new Date(t.ts).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
      const reasonShort = t.reason === "TAKE_PROFIT" ? "TP" : t.reason === "STOP_LOSS" ? "SL"
        : t.reason === "SIGNAL_FLIP" ? "FLIP" : t.reason === "TIME_DECAY" ? "TD"
        : t.reason === "SETTLED_WIN" ? "WIN" : t.reason === "SETTLED_LOSS" ? "LOSS" : (t.reason ?? "");
      rightHist.push(`${ANSI.dim}${ts}${ANSI.reset} ${sl} ${color}${pSign}$${t.pnl.toFixed(2)} ${rSign}${t.roi.toFixed(0)}%${ANSI.reset} ${ANSI.dim}${reasonShort}${ANSI.reset}`);
    }
  }

  // Pad columns
  while (leftPos.length < rightHist.length) leftPos.push("");
  while (rightHist.length < leftPos.length) rightHist.push("");

  lines.push(...mergeColumns(leftPos, rightHist, W));
  lines.push(sepLine());
  lines.push(centerText(`${ANSI.dim}${ANSI.gray}created by @krajekis${ANSI.reset}`, W));

  return lines.join("\n") + "\n";
}
