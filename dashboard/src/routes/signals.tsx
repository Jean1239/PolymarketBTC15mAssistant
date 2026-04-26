import type { ReactNode } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { Wifi, WifiOff } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { api, type Signal15m, type Signal5m } from "@/lib/api"

export const Route = createFileRoute("/signals")({
  component: SignalsPage,
})

function fmtTs(iso: string) {
  return iso.replace("T", " ").slice(0, 19) + "Z"
}

function ProbBar({ label, value, color }: { label: string; value: number; color: string }) {
  const pct = Math.round(value * 100)
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono font-medium">{pct}%</span>
      </div>
      <div className="h-2 rounded-full bg-muted overflow-hidden">
        <div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
    </div>
  )
}

function Kv({ label, value, mono = false }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="flex justify-between items-center gap-2 py-1 text-sm min-w-0">
      <span className="text-muted-foreground text-xs shrink-0">{label}</span>
      <span className={`font-medium text-xs text-right min-w-0 ${mono ? "font-mono" : ""}`}>{value}</span>
    </div>
  )
}

function recColor(rec: string) {
  if (rec.includes("ENTER") || rec === "BUY") return "text-green-500"
  if (rec.includes("NO_TRADE") || rec === "WAIT") return "text-muted-foreground"
  return "text-yellow-500"
}

function SimStatus({ action, side, roi, cumPnl }: { action: string; side: string; roi: number | null; cumPnl: number }) {
  const isHolding = action === "HOLD" || action === "BUY"
  return (
    <div className="rounded-md bg-muted/50 p-3 space-y-1">
      <div className="flex items-center gap-2 flex-wrap text-xs font-medium">
        <Badge variant={isHolding ? "default" : "secondary"} className="text-xs shrink-0">{action}</Badge>
        {side && <span className={side === "UP" ? "text-green-500" : "text-red-500"}>{side}</span>}
        {roi !== null && (
          <span className={`ml-auto font-mono shrink-0 ${roi >= 0 ? "text-green-500" : "text-red-500"}`}>
            {roi >= 0 ? "+" : ""}{roi.toFixed(1)}%
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Cum. P&L:{" "}
        <span className={`font-mono ${cumPnl >= 0 ? "text-green-500" : "text-red-500"}`}>
          {cumPnl >= 0 ? "+" : ""}${cumPnl.toFixed(2)}
        </span>
      </p>
    </div>
  )
}

function Signal15mCard({ s }: { s: Signal15m }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2 min-w-0">
          <CardTitle className="text-sm shrink-0">15-minute bot</CardTitle>
          <span className="text-xs text-muted-foreground font-mono text-right break-all">{fmtTs(s.timestamp)}</span>
        </div>
        <p className="text-xs text-muted-foreground font-mono truncate">{s.market_slug}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-lg font-bold shrink-0 ${recColor(s.rec_detail)}`}>{s.rec_detail}</span>
          <Badge variant="outline" className="text-xs shrink-0">{s.regime}</Badge>
          <span className="text-xs text-muted-foreground ml-auto shrink-0">{s.time_left_min.toFixed(1)}m left</span>
        </div>

        <div className="space-y-2">
          <ProbBar label="UP" value={s.model_up} color="hsl(142 76% 36%)" />
          <ProbBar label="DOWN" value={s.model_down} color="hsl(0 72% 51%)" />
        </div>

        <Separator />

        <div className="grid grid-cols-2 gap-x-4">
          <div>
            <Kv label="Market UP" value={`${(s.market_up * 100).toFixed(0)}¢`} mono />
            <Kv label="Market DOWN" value={`${(s.market_down * 100).toFixed(0)}¢`} mono />
            <Kv label="Edge UP" value={<span className={s.edge_up > 0 ? "text-green-500" : "text-red-500"}>{s.edge_up.toFixed(3)}</span>} mono />
          </div>
          <div>
            <Kv label="RSI" value={s.rsi?.toFixed(1)} mono />
            <Kv label="RSI slope" value={s.rsi_slope?.toFixed(3)} mono />
            <Kv label="MACD" value={<Badge variant="outline" className="text-xs">{s.macd_label}</Badge>} />
          </div>
          <div>
            <Kv label="HA" value={<span className={s.ha_color === "green" ? "text-green-500" : "text-red-500"}>{s.ha_color} ×{s.ha_count}</span>} />
          </div>
          <div>
            <Kv label="VWAP dist" value={`${s.vwap_dist_pct?.toFixed(3)}%`} mono />
          </div>
        </div>

        <Separator />
        <SimStatus action={s.sim_action} side={s.sim_side} roi={s.sim_roi_pct} cumPnl={s.sim_cum_pnl} />
      </CardContent>
    </Card>
  )
}

function Signal5mCard({ s }: { s: Signal5m }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2 min-w-0">
          <CardTitle className="text-sm shrink-0">5-minute bot</CardTitle>
          <span className="text-xs text-muted-foreground font-mono text-right break-all">{fmtTs(s.timestamp)}</span>
        </div>
        <p className="text-xs text-muted-foreground font-mono truncate">{s.market_slug}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-lg font-bold shrink-0 ${recColor(s.rec_detail)}`}>{s.rec_detail}</span>
          <Badge variant="outline" className={s.ema_cross !== "NONE" ? "text-blue-400 border-blue-400/30 text-xs shrink-0" : "text-xs shrink-0"}>
            EMA {s.ema_cross}
          </Badge>
          <span className="text-xs text-muted-foreground ml-auto shrink-0">{s.time_left_min.toFixed(1)}m left</span>
        </div>

        <div className="space-y-2">
          <ProbBar label="UP" value={s.model_up} color="hsl(142 76% 36%)" />
          <ProbBar label="DOWN" value={s.model_down} color="hsl(0 72% 51%)" />
        </div>

        <Separator />

        <div className="grid grid-cols-2 gap-x-4">
          <div>
            <Kv label="Market UP" value={`${(s.market_up * 100).toFixed(0)}¢`} mono />
            <Kv label="Market DOWN" value={`${(s.market_down * 100).toFixed(0)}¢`} mono />
            <Kv label="OFI 30s" value={s.ofi_30s?.toFixed(2)} mono />
          </div>
          <div>
            <Kv label="OFI 1m" value={s.ofi_1m?.toFixed(2)} mono />
            <Kv label="OFI 2m" value={s.ofi_2m?.toFixed(2)} mono />
            <Kv label="RSI" value={s.rsi?.toFixed(1)} mono />
          </div>
          <div>
            <Kv label="ROC 1m" value={s.roc1?.toFixed(5)} mono />
            <Kv label="ROC 3m" value={s.roc3?.toFixed(5)} mono />
          </div>
          <div>
            <Kv label="HA" value={<span className={s.ha_color === "green" ? "text-green-500" : "text-red-500"}>{s.ha_color} ×{s.ha_count}</span>} />
            <Kv label="VWAP dist" value={`${s.vwap_dist_pct?.toFixed(3)}%`} mono />
          </div>
        </div>

        <Separator />
        <SimStatus action={s.sim_action} side={s.sim_side} roi={s.sim_roi_pct} cumPnl={s.sim_cum_pnl} />
      </CardContent>
    </Card>
  )
}

function SignalsPage() {
  const { data, isLoading, dataUpdatedAt } = useQuery({
    queryKey: ["live"],
    queryFn: api.live,
    refetchInterval: 5_000,
  })

  const lastUpdate = dataUpdatedAt ? new Date(dataUpdatedAt).toLocaleTimeString() : null

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div className="flex items-center gap-2 flex-wrap">
        {isLoading ? <WifiOff className="h-5 w-5 text-muted-foreground shrink-0" /> : <Wifi className="h-5 w-5 text-green-500 shrink-0" />}
        <h1 className="text-lg font-semibold">Live Signals</h1>
        {lastUpdate && <span className="text-xs text-muted-foreground">updated {lastUpdate}</span>}
      </div>

      {isLoading && <p className="text-muted-foreground text-sm">Connecting…</p>}

      {data && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {data["15m"] ? <Signal15mCard s={data["15m"]} /> : <Card><CardContent className="p-6 text-muted-foreground text-sm">15m bot offline</CardContent></Card>}
          {data["5m"] ? <Signal5mCard s={data["5m"]} /> : <Card><CardContent className="p-6 text-muted-foreground text-sm">5m bot offline</CardContent></Card>}
        </div>
      )}
    </div>
  )
}
