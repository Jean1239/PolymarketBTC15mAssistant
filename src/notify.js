/**
 * Telegram notification helper.
 *
 * All functions are fire-and-forget — they never throw and never block the
 * main loop. Set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID in .env to enable.
 * If either var is missing, all calls are silent no-ops.
 */

const TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const TIMEOUT_MS = 5_000;

async function _send(text) {
  if (!TOKEN || !CHAT_ID) return;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "HTML" }),
      signal: controller.signal,
    });
  } catch {
    // never let notification failure affect the bot
  } finally {
    clearTimeout(t);
  }
}

/** Send a free-form message. Never awaited by callers — fire and forget. */
export function notify(text) {
  _send(text);
}

/**
 * Notify a simulated or real trade event (BUY or SELL/settlement).
 *
 * @param {object} p
 * @param {string}  p.bot         - "15m" or "5m"
 * @param {boolean} p.isLive      - true = real money, false = sim
 * @param {"BUY"|"SELL"}  p.action
 * @param {string}  p.side        - "UP" or "DOWN"
 * @param {string}  p.market      - market slug
 * @param {number}  p.entryPrice
 * @param {number}  [p.exitPrice]
 * @param {number}  [p.roi]       - ROI % (SELL only)
 * @param {number}  [p.pnl]       - realized PNL (SELL only)
 * @param {number}  [p.cumPnl]    - cumulative PNL after this trade (SELL only)
 * @param {string}  [p.reason]    - exit reason (SELL only)
 * @param {number}  [p.invested]  - amount invested (BUY only)
 */
export function notifyTrade({ bot, isLive, action, side, market, entryPrice,
                              exitPrice, roi, pnl, cumPnl, reason, invested }) {
  const mode   = isLive ? "LIVE" : "SIM";
  const slug   = String(market ?? "").slice(-16); // keep last 16 chars to stay compact
  const sideArrow = side === "UP" ? "↑ UP" : "↓ DOWN";

  let text;

  if (action === "BUY") {
    const icon = isLive ? "🟢" : "📈";
    const inv  = invested != null ? `$${Number(invested).toFixed(2)}` : "";
    const ep   = entryPrice != null ? `${(entryPrice * 100).toFixed(1)}¢` : "-";
    text = [
      `${icon} <b>[${bot}·${mode}] BUY ${sideArrow}</b>`,
      `Mercado: ...${slug}`,
      `Entrada: ${ep}${inv ? ` | Inv: ${inv}` : ""}`,
    ].join("\n");

  } else {
    // SELL / settlement
    const won  = pnl != null && pnl >= 0;
    const icon = isLive
      ? (won ? "💰" : "🔴")
      : (reason?.startsWith("SETTLED") ? (won ? "🏆" : "💀") : (won ? "📊" : "📉"));

    const ep   = entryPrice != null ? `${(entryPrice * 100).toFixed(1)}¢` : "-";
    const xp   = exitPrice  != null ? `${(exitPrice  * 100).toFixed(1)}¢` : "-";
    const roiStr  = roi  != null ? `${roi  >= 0 ? "+" : ""}${Number(roi).toFixed(1)}%` : "-";
    const pnlStr  = pnl  != null ? `${pnl  >= 0 ? "+" : ""}$${Math.abs(pnl).toFixed(2)}` : "-";
    const cumStr  = cumPnl != null ? `${cumPnl >= 0 ? "+" : ""}$${Number(cumPnl).toFixed(2)}` : null;

    text = [
      `${icon} <b>[${bot}·${mode}] SELL — ${reason ?? "MANUAL"}</b>`,
      `${sideArrow}: ${ep} → ${xp}`,
      `ROI: <b>${roiStr}</b> | PNL: ${pnlStr}`,
      cumStr ? `Acum: ${cumStr}` : null,
    ].filter(Boolean).join("\n");
  }

  _send(text);
}

/** Notify that the bot process started (after crash/restart or fresh deploy). */
export function notifyStart(bot) {
  _send(`✅ <b>Bot ${bot} iniciado</b>`);
}

/**
 * Send a daily summary of paper-trading stats.
 *
 * @param {string} bot  - "15m" or "5m"
 * @param {{ wins: number, losses: number, totalTrades: number, cumulativePnl: number }} stats
 */
export function notifyDailySummary(bot, stats) {
  const { wins, losses, totalTrades, cumulativePnl } = stats;
  const wr  = totalTrades > 0 ? `${((wins / totalTrades) * 100).toFixed(0)}%` : "-";
  const cum = `${cumulativePnl >= 0 ? "+" : ""}$${Number(cumulativePnl).toFixed(2)}`;
  _send([
    `📋 <b>[${bot}·SIM] Resumo do dia</b>`,
    `Trades: ${totalTrades} | W:${wins} L:${losses} | WR: ${wr}`,
    `PNL acumulado: <b>${cum}</b>`,
  ].join("\n"));
}
