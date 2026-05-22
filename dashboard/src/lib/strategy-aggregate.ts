import type { Trade, StrategyVersion } from "./api";

export type TimeWindow = "1d" | "1w" | "1m" | "all";

export interface OddBand {
  label: string;
  lo: number;
  hi: number;
  count: number;
  pnl: number;
  winRate: number;
}

export interface AggregateRow {
  version: StrategyVersion;
  trades: number;
  pnlGross: number;
  pnlNet: number;
  winRate: number;
  profitFactor: number;
  avgWin: number;
  avgLoss: number;
  maxDrawdown: number;
  byExitReason: Record<string, { count: number; pnl: number }>;
  byOddBand: OddBand[];
}

// Trades earlier than the cutoff are dropped. "all" -> no cutoff.
export function computeSince(window: TimeWindow, now: Date = new Date()): Date | null {
  if (window === "all") return null;
  const d = new Date(now);
  if (window === "1d") d.setUTCDate(d.getUTCDate() - 1);
  if (window === "1w") d.setUTCDate(d.getUTCDate() - 7);
  if (window === "1m") d.setUTCMonth(d.getUTCMonth() - 1);
  return d;
}

function sumKey(rows: Trade[], key: keyof Trade): number {
  let s = 0;
  for (const r of rows) {
    const v = r[key];
    if (typeof v === "number") s += v;
  }
  return s;
}

function profitFactor(rows: Trade[]): number {
  let win = 0, loss = 0;
  for (const r of rows) {
    const v = r.pnl_net ?? r.pnl;
    if (v > 0) win += v;
    else if (v < 0) loss += -v;
  }
  if (loss === 0) return win > 0 ? Infinity : 0;
  return win / loss;
}

function avgOf(rows: Trade[], pred: (n: number) => boolean): number {
  const vals = rows.map(r => r.pnl_net ?? r.pnl).filter(pred);
  return vals.length ? vals.reduce((s, n) => s + n, 0) / vals.length : 0;
}

function maxDrawdown(rows: Trade[]): number {
  // Walk by entry_time ascending; track running cumulative and peak.
  const sorted = [...rows].sort((a, b) => a.entry_time.localeCompare(b.entry_time));
  let cum = 0, peak = 0, worst = 0;
  for (const r of sorted) {
    cum += r.pnl_net ?? r.pnl;
    peak = Math.max(peak, cum);
    worst = Math.min(worst, cum - peak);
  }
  return worst;
}

function groupExitReasons(rows: Trade[]): Record<string, { count: number; pnl: number }> {
  const out: Record<string, { count: number; pnl: number }> = {};
  for (const r of rows) {
    const key = r.exit_reason || "UNKNOWN";
    if (!out[key]) out[key] = { count: 0, pnl: 0 };
    out[key].count += 1;
    out[key].pnl += r.pnl_net ?? r.pnl;
  }
  return out;
}

// Fallback bins used when version.config is null (unknown bucket).
const FALLBACK_BINS: Array<[number, number, string]> = [
  [0,    0.40, "< 0.40"],
  [0.40, 0.42, "0.40-0.42"],
  [0.42, 0.44, "0.42-0.44"],
  [0.44, 0.46, "0.44-0.46"],
  [0.46, 0.48, "0.46-0.48"],
  [0.48, 0.50, "0.48-0.50"],
  [0.50, 0.52, "0.50-0.52"],
  [0.52, 0.54, "0.52-0.54"],
  [0.54, 0.56, "0.54-0.56"],
  [0.56, 0.58, "0.56-0.58"],
  [0.58, 0.60, "0.58-0.60"],
  [0.60, 0.62, "0.60-0.62"],
  [0.62, 1.00, "> 0.62"],
];

function bandsForVersion(version: StrategyVersion): Array<[number, number, string]> {
  const cfg = version.config;
  if (!cfg || typeof cfg.entryMinMarketPrice !== "number" || typeof cfg.entryMaxMarketPrice !== "number") {
    return FALLBACK_BINS;
  }
  const min = cfg.entryMinMarketPrice as number;
  const max = cfg.entryMaxMarketPrice as number;
  const bins: Array<[number, number, string]> = [[0, min, `< ${min.toFixed(2)}`]];
  let lo = min;
  while (lo < max) {
    const hi = Math.min(max, +(lo + 0.02).toFixed(2));
    bins.push([lo, hi, `${lo.toFixed(2)}-${hi.toFixed(2)}`]);
    lo = hi;
  }
  bins.push([max, 1, `> ${max.toFixed(2)}`]);
  return bins;
}

function binByEntryPrice(rows: Trade[], version: StrategyVersion): OddBand[] {
  const bins = bandsForVersion(version);
  return bins.map(([lo, hi, label]) => {
    const inBin = rows.filter(r => {
      const p = +r.entry_price;
      return p >= lo && p < hi;
    });
    const wins = inBin.filter(r => (r.pnl_net ?? r.pnl) > 0).length;
    const pnl = inBin.reduce((s, r) => s + (r.pnl_net ?? r.pnl), 0);
    return {
      label,
      lo,
      hi,
      count: inBin.length,
      pnl,
      winRate: inBin.length ? wins / inBin.length : 0,
    };
  });
}

export function aggregateByVersion({
  trades,
  versions,
  window,
  now,
}: {
  trades: Trade[];
  versions: StrategyVersion[];
  window: TimeWindow;
  now?: Date;
}): AggregateRow[] {
  const since = computeSince(window, now);
  const filtered = trades.filter(t => {
    if (since && new Date(t.entry_time) < since) return false;
    return true;
  });

  return versions.map(v => {
    const rows = filtered.filter(t => (t.config_hash ?? "unknown") === v.hash);
    return {
      version: v,
      trades: rows.length,
      pnlGross: sumKey(rows, "gross_pnl"),
      pnlNet: rows.reduce((s, r) => s + (r.pnl_net ?? r.pnl), 0),
      winRate: rows.length ? rows.filter(r => (r.pnl_net ?? r.pnl) > 0).length / rows.length : 0,
      profitFactor: profitFactor(rows),
      avgWin: avgOf(rows, n => n > 0),
      avgLoss: avgOf(rows, n => n < 0),
      maxDrawdown: maxDrawdown(rows),
      byExitReason: groupExitReasons(rows),
      byOddBand: binByEntryPrice(rows, v),
    };
  });
}
