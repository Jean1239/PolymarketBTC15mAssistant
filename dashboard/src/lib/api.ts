export interface Trade {
  entry_time: string
  exit_time: string
  market_slug: string
  side: "UP" | "DOWN"
  entry_price: number
  exit_price: number
  shares: number
  invested: number
  exit_value: number
  pnl: number
  roi_pct: number
  exit_reason: string
  duration_s: number
  ptb_at_entry: number
  btc_at_entry: number
  btc_vs_ptb_at_entry: number
  market_up_at_entry: number
  market_down_at_entry: number
}

export interface BotStats {
  totalTrades: number
  wins: number
  losses: number
  winRate: number
  totalPnl: number
  avgPnl: number
  avgWin: number
  avgLoss: number
  profitFactor: number
  maxWinRoi: number
  maxLossRoi: number
  avgDurationS: number
  maxWinStreak: number
  maxLossStreak: number
  firstEntry: string | null
  lastExit: string | null
  byReason: Record<string, { count: number; pnl: number }>
  bySide: Record<string, { count: number; wins: number; pnl: number }>
  pnlCurve: { time: string; pnl: number }[]
}

export interface StatsResponse {
  "15m": BotStats
  "5m": BotStats
}

export interface Signal15m {
  timestamp: string
  market_slug: string
  time_left_min: number
  btc_price: number | null
  market_up: number
  market_down: number
  regime: string
  signal: string
  model_up: number
  model_down: number
  edge_up: number
  edge_down: number
  rec_detail: string
  rsi: number
  rsi_slope: number
  macd_hist: number
  macd_label: string
  ha_color: string
  ha_count: number
  vwap: number
  vwap_dist_pct: number
  vwap_slope: number
  sim_action: string
  sim_side: string
  sim_entry_price: number | null
  sim_current_price: number | null
  sim_roi_pct: number | null
  sim_exit_reason: string
  sim_pnl: number | null
  sim_cum_pnl: number
  sim_invested: number | null
}

export interface Signal5m {
  timestamp: string
  market_slug: string
  time_left_min: number
  btc_price: number | null
  market_up: number
  market_down: number
  signal: string
  model_up: number
  model_down: number
  edge_up: number
  edge_down: number
  rec_detail: string
  ofi_30s: number
  ofi_1m: number
  ofi_2m: number
  roc1: number
  roc3: number
  ema_cross: string
  rsi: number
  ha_color: string
  ha_count: number
  vwap: number
  vwap_dist_pct: number
  vwap_slope: number
  sim_action: string
  sim_side: string
  sim_entry_price: number | null
  sim_current_price: number | null
  sim_roi_pct: number | null
  sim_exit_reason: string
  sim_pnl: number | null
  sim_cum_pnl: number
  sim_invested: number | null
}

export interface LiveResponse {
  "15m": Signal15m | null
  "5m": Signal5m | null
}

export interface LogFile {
  name: string
  size: number
  modified: string
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path)
  if (!res.ok) throw new Error(`${path} → ${res.status}`)
  return res.json() as Promise<T>
}

export interface ClearLogsResult {
  ok: boolean
  cleared: string[]
  archive: string
}

export const api = {
  stats: () => get<StatsResponse>("/api/stats"),
  trades15m: () => get<Trade[]>("/api/trades/15m"),
  trades5m: () => get<Trade[]>("/api/trades/5m"),
  live: () => get<LiveResponse>("/api/live"),
  files: () => get<LogFile[]>("/api/files"),
  clearLogs: () =>
    fetch("/api/logs/clear", { method: "POST" }).then((r) => {
      if (!r.ok) throw new Error(`/api/logs/clear → ${r.status}`)
      return r.json() as Promise<ClearLogsResult>
    }),
}
