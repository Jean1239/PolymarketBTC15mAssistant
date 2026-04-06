import { ANSI } from "../display.js";
import { getPosition } from "./position.js";

/**
 * Sets up raw-mode stdin, an action queue, and pending-confirmation state.
 *
 * Returns:
 *   actionQueue    — array drained by processActionQueue() each tick
 *   getConfirmHint — builds the confirmation line shown on the display
 *   stdinError     — non-null string if TTY setup failed
 */
export function setupKeyboard({ tradingEnabled }) {
  const actionQueue = [];
  let pendingAction = null;
  let stdinError = null;

  try {
    if (!process.stdin.isTTY) throw new Error("stdin não é TTY — rode diretamente com node (sem pipe)");
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (key) => {
      const ch = key.toString().toLowerCase();
      if (tradingEnabled) {
        if (pendingAction !== null) {
          if (ch === "y") { actionQueue.push({ ...pendingAction }); pendingAction = null; }
          else if (ch === "n" || key[0] === 0x1b) { pendingAction = null; }
        } else {
          if (ch === "b") pendingAction = { type: "buy" };
          else if (ch === "s") pendingAction = { type: "sell" };
        }
      }
      if (ch === "q" || key[0] === 0x03) process.exit(0);
    });
  } catch (err) {
    stdinError = err?.message ?? String(err);
  }

  /**
   * Builds the confirmation hint string for the current pending action.
   * Returns null if nothing is pending.
   *
   * @param {object} ctx
   * @param {object} ctx.rec         - decide() result
   * @param {object} ctx.timeAware   - applyTimeAwareness() result
   * @param {number|null} ctx.marketUp
   * @param {number|null} ctx.marketDown
   * @param {number} ctx.tradeAmount
   */
  function getConfirmHint({ rec, timeAware, marketUp, marketDown, tradeAmount }) {
    if (!pendingAction) return null;
    if (pendingAction.type === "buy") {
      const side = rec.action === "ENTER"
        ? rec.side
        : (timeAware.adjustedUp >= timeAware.adjustedDown ? "UP" : "DOWN");
      const sc = side === "UP" ? ANSI.green : ANSI.red;
      const mp = side === "UP" ? marketUp : marketDown;
      const ps = mp != null ? `@ ${(mp * 100).toFixed(1)}\u00A2` : "";
      return `${ANSI.yellow}\u26A1 BUY ${sc}${side}${ANSI.reset} ${ANSI.yellow}${ps} $${tradeAmount}${ANSI.reset}  ${ANSI.white}[Y]${ANSI.reset} Sim  ${ANSI.white}[N]${ANSI.reset} Cancelar`;
    }
    if (pendingAction.type === "sell") {
      const pos = getPosition();
      if (!pos.active) return `${ANSI.gray}Sem posicao${ANSI.reset}  ${ANSI.white}[N]${ANSI.reset}`;
      const sc = pos.side === "UP" ? ANSI.green : ANSI.red;
      return `${ANSI.yellow}\u26A1 VENDER ${sc}${pos.side}${ANSI.reset} ${ANSI.yellow}${pos.shares.toFixed(2)} sh${ANSI.reset}  ${ANSI.white}[Y]${ANSI.reset} Sim  ${ANSI.white}[N]${ANSI.reset} Cancelar`;
    }
    return null;
  }

  return { actionQueue, getConfirmHint, get stdinError() { return stdinError; } };
}
