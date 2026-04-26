import { createFileRoute } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { TrendingUp, TrendingDown, Activity } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"
import { Area, AreaChart, CartesianGrid, XAxis, YAxis, Bar, BarChart, Cell } from "recharts"
import { api, type BotStats } from "@/lib/api"

export const Route = createFileRoute("/")({
  component: OverviewPage,
})

function fmt(n: number, prefix = "") {
  const sign = n >= 0 ? "+" : ""
  return `${sign}${prefix}${n.toFixed(2)}`
}

function pct(n: number) {
  return `${(n * 100).toFixed(1)}%`
}

const EXIT_COLORS: Record<string, string> = {
  SETTLED_WIN: "hsl(142 76% 36%)",
  SETTLED_LOSS: "hsl(0 72% 51%)",
  TAKE_PROFIT: "hsl(210 98% 48%)",
  STOP_LOSS: "hsl(38 92% 50%)",
  TIME_DECAY: "hsl(262 83% 58%)",
  SIGNAL_FLIP: "hsl(200 98% 39%)",
}

function StatCard({ title, value, sub, positive }: { title: string; value: string; sub?: string; positive?: boolean }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className={`text-xl sm:text-2xl font-bold tabular-nums truncate ${positive === true ? "text-green-500" : positive === false ? "text-red-500" : ""}`}>
          {value}
        </p>
        {sub && <p className="text-xs text-muted-foreground mt-1 truncate">{sub}</p>}
      </CardContent>
    </Card>
  )
}

function BotOverview({ stats, label }: { stats: BotStats; label: string }) {
  const exitReasonData = Object.entries(stats.byReason)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([reason, d]) => ({ reason, count: d.count, pnl: d.pnl }))

  const pnlChartConfig = { pnl: { label: "Cum. P&L", color: "hsl(142 76% 36%)" } }
  const exitChartConfig = Object.fromEntries(
    exitReasonData.map((d) => [d.reason, { label: d.reason, color: EXIT_COLORS[d.reason] ?? "hsl(240 5% 64%)" }])
  )

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          title="Total P&L"
          value={`${stats.totalPnl >= 0 ? "+" : ""}$${stats.totalPnl.toFixed(2)}`}
          sub={`${stats.totalTrades} trades`}
          positive={stats.totalPnl >= 0}
        />
        <StatCard
          title="Win Rate"
          value={pct(stats.winRate)}
          sub={`${stats.wins}W / ${stats.losses}L`}
          positive={stats.winRate >= 0.5}
        />
        <StatCard
          title="Profit Factor"
          value={stats.profitFactor === Infinity ? "∞" : stats.profitFactor.toFixed(2)}
          sub={`avg win ${fmt(stats.avgWin, "$")} / loss ${fmt(stats.avgLoss, "$")}`}
          positive={stats.profitFactor > 1}
        />
        <StatCard
          title="Avg Duration"
          value={`${Math.round(stats.avgDurationS)}s`}
          sub={`streak: ${stats.maxWinStreak}W / ${stats.maxLossStreak}L`}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-sm">Cumulative P&L — {label}</CardTitle>
          </CardHeader>
          <CardContent>
            <ChartContainer config={pnlChartConfig} className="h-52 w-full">
              <AreaChart data={stats.pnlCurve}>
                <defs>
                  <linearGradient id={`grad-${label}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="hsl(142 76% 36%)" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="hsl(142 76% 36%)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(240 3.7% 15.9%)" />
                <XAxis dataKey="time" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={(v) => v.slice(11, 16)} />
                <YAxis tick={{ fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={(v) => `$${v.toFixed(1)}`} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Area type="monotone" dataKey="pnl" stroke="hsl(142 76% 36%)" fill={`url(#grad-${label})`} strokeWidth={2} dot={false} />
              </AreaChart>
            </ChartContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Exit Reasons</CardTitle>
          </CardHeader>
          <CardContent>
            <ChartContainer config={exitChartConfig} className="h-52 w-full">
              <BarChart data={exitReasonData} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(240 3.7% 15.9%)" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                <YAxis dataKey="reason" type="category" tick={{ fontSize: 8 }} tickLine={false} axisLine={false} width={72} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Bar dataKey="count" radius={3}>
                  {exitReasonData.map((entry) => (
                    <Cell key={entry.reason} fill={EXIT_COLORS[entry.reason] ?? "hsl(240 5% 64%)"} />
                  ))}
                </Bar>
              </BarChart>
            </ChartContainer>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-2 gap-4">
        {Object.entries(stats.bySide).map(([side, d]) => (
          <Card key={side}>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs text-muted-foreground uppercase flex items-center gap-2">
                {side === "UP" ? <TrendingUp className="h-3 w-3 text-green-500" /> : <TrendingDown className="h-3 w-3 text-red-500" />}
                Side {side}
              </CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-3 gap-2 text-sm">
              <div><p className="text-muted-foreground text-xs">Trades</p><p className="font-semibold">{d.count}</p></div>
              <div><p className="text-muted-foreground text-xs">Win rate</p><p className="font-semibold">{pct(d.wins / d.count)}</p></div>
              <div><p className="text-muted-foreground text-xs">P&L</p><p className={`font-semibold ${d.pnl >= 0 ? "text-green-500" : "text-red-500"}`}>{fmt(d.pnl, "$")}</p></div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}

function OverviewPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["stats"],
    queryFn: api.stats,
    refetchInterval: 30_000,
  })

  if (isLoading) return <div className="flex items-center justify-center h-full text-muted-foreground p-8">Loading…</div>
  if (error || !data) return <div className="p-8 text-red-500">Failed to load stats.</div>

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div className="flex items-center gap-2 flex-wrap">
        <Activity className="h-5 w-5 shrink-0" />
        <h1 className="text-lg font-semibold">Overview</h1>
        <span className="text-xs text-muted-foreground">refreshes every 30s</span>
      </div>

      <Tabs defaultValue="15m">
        <TabsList>
          <TabsTrigger value="15m">15-minute bot</TabsTrigger>
          <TabsTrigger value="5m">5-minute bot</TabsTrigger>
        </TabsList>
        <TabsContent value="15m" className="mt-4">
          <BotOverview stats={data["15m"]} label="15m" />
        </TabsContent>
        <TabsContent value="5m" className="mt-4">
          <BotOverview stats={data["5m"]} label="5m" />
        </TabsContent>
      </Tabs>
    </div>
  )
}
