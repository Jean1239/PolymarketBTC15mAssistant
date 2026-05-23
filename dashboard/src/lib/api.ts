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
  fee: number
  gross_pnl: number
  pnl_net: number
  config_hash?: string
}

export interface StrategyVersion {
  hash: string
  label: string
  startedAt: string
  endedAt: string | null
  source: "auto" | "backfill"
  partial: boolean
  fieldsVersion: number
  config: Record<string, unknown> | null
  configDiff: Record<string, { from: unknown; to: unknown }> | null
}

export interface StrategiesResponse {
  versions: StrategyVersion[]
  unknownPeriod: { startedAt: null; endedAt: string } | null
  backfillSource: "STRATEGY_LOG.md" | null
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
  pnlCurve: { time: string; pnl: number; pnlNet: number }[]
  feeRate: number
  feeExponent: number
  totalFees: number
  totalPnlNet: number
  avgFee: number
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
  edge_up: number | null
  edge_down: number | null
  rec_detail: string
  rsi: number | null
  rsi_slope: number | null
  macd_hist: number | null
  macd_label: string
  ha_color: string
  ha_count: number | null
  vwap: number | null
  vwap_dist_pct: number | null
  vwap_slope: number | null
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
  edge_up: number | null
  edge_down: number | null
  rec_detail: string
  ofi_30s: number | null
  ofi_1m: number | null
  ofi_2m: number | null
  roc1: number | null
  roc3: number | null
  ema_cross: string
  rsi: number | null
  ha_color: string
  ha_count: number | null
  vwap: number | null
  vwap_dist_pct: number | null
  vwap_slope: number | null
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

export interface FileTail {
  name: string
  lines: string[]
  totalSize: number
  truncated: boolean
}

export interface BotStatus {
  active: boolean
  lastTickAgoS: number | null
  exists: boolean
}

export type BotsStatusResponse = Record<"15m" | "5m", BotStatus>

export interface TradeEvent {
  timestamp: string | null
  type: "order" | "error"
  message: string
}

function maybeRedirectToLogin(status: number) {
  if (status === 401 && typeof window !== "undefined" && window.location.pathname !== "/login") {
    window.location.href = "/login"
  }
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path)
  if (!res.ok) {
    maybeRedirectToLogin(res.status)
    throw new Error(`${path} → ${res.status}`)
  }
  return res.json() as Promise<T>
}

export interface ClearLogsResult {
  ok: boolean
  cleared: string[]
  archive: string
}

export const api = {
  stats: (sinceIso?: string, strategy15m?: string, strategy5m?: string) => {
    const qs = new URLSearchParams()
    if (sinceIso) qs.set("since", sinceIso)
    if (strategy15m && strategy15m !== "all") qs.set("strategy15m", strategy15m)
    if (strategy5m && strategy5m !== "all") qs.set("strategy5m", strategy5m)
    const s = qs.toString()
    return get<StatsResponse>(`/api/stats${s ? `?${s}` : ""}`)
  },
  trades15m: () => get<Trade[]>("/api/trades/15m"),
  trades5m: () => get<Trade[]>("/api/trades/5m"),
  strategies15m: () => get<StrategiesResponse>("/api/strategies/15m"),
  strategies5m: () => get<StrategiesResponse>("/api/strategies/5m"),
  live: () => get<LiveResponse>("/api/live"),
  files: () => get<LogFile[]>("/api/files"),
  fileTail: (name: string, lines: number) =>
    get<FileTail>(`/api/files/tail?name=${encodeURIComponent(name)}&lines=${lines}`),
  botsStatus: () => get<BotsStatusResponse>("/api/bots/status"),
  tradeEvents: (limit = 5) => get<TradeEvent[]>(`/api/trade-events?limit=${limit}`),
  clearLogs: () =>
    fetch("/api/logs/clear", { method: "POST" }).then((r) => {
      if (!r.ok) {
        maybeRedirectToLogin(r.status)
        throw new Error(`/api/logs/clear → ${r.status}`)
      }
      return r.json() as Promise<ClearLogsResult>
    }),
}
