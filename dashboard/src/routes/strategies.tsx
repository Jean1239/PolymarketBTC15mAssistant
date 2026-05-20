import { useMemo, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { GitBranch } from "lucide-react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { api, type Trade } from "@/lib/api"
import { useSelectedBot } from "@/lib/selected-bot"
import { TimeWindowFilter } from "@/components/strategies/time-window-filter"
import { StrategyTable } from "@/components/strategies/strategy-table"
import { CompareDrawer } from "@/components/strategies/compare-drawer"
import { aggregateByVersion, type TimeWindow } from "@/lib/strategy-aggregate"

export const Route = createFileRoute("/strategies")({
  component: StrategiesPage,
})

type Bot = "15m" | "5m"

function BotView({ bot }: { bot: Bot }) {
  const stratsQ = useQuery({
    queryKey: ["strategies", bot],
    queryFn: () => (bot === "15m" ? api.strategies15m() : api.strategies5m()),
    refetchInterval: 60_000,
  })
  const tradesQ = useQuery({
    queryKey: ["trades", bot],
    queryFn: () => (bot === "15m" ? api.trades15m() : api.trades5m()),
    refetchInterval: 60_000,
  })

  const [window, setWindow] = useState<TimeWindow>("all")
  const [selected, setSelected] = useState<string[]>([])
  const [drawerOpen, setDrawerOpen] = useState(false)

  const versions = stratsQ.data?.versions ?? []
  const trades: Trade[] = tradesQ.data ?? []

  const aggregated = useMemo(() => {
    if (versions.length === 0) return []
    return aggregateByVersion({ trades, versions, window })
  }, [versions, trades, window])

  function toggle(hash: string) {
    setSelected(prev => {
      if (prev.includes(hash)) return prev.filter(h => h !== hash)
      if (prev.length >= 2) return [prev[1], hash]
      return [...prev, hash]
    })
  }

  const rowA = aggregated.find(r => r.version.hash === selected[0]) ?? null
  const rowB = aggregated.find(r => r.version.hash === selected[1]) ?? null

  if (stratsQ.isLoading || tradesQ.isLoading) {
    return <p className="text-muted-foreground text-sm p-4">Loading…</p>
  }
  if (stratsQ.error || tradesQ.error) {
    return (
      <Card>
        <CardContent className="p-6 text-red-500 text-sm">
          Failed to load strategies.
          <Button variant="outline" size="sm" className="ml-2" onClick={() => { stratsQ.refetch(); tradesQ.refetch(); }}>
            Retry
          </Button>
        </CardContent>
      </Card>
    )
  }
  if (versions.length === 0) {
    return (
      <Card>
        <CardContent className="p-6 text-muted-foreground text-sm">
          Nenhuma estratégia detectada. Rode <code>npm start</code> ou <code>npm run backfill:strategy</code>.
        </CardContent>
      </Card>
    )
  }

  const unknownTrades = aggregated.find(r => r.version.hash === "unknown")?.trades ?? 0

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <TimeWindowFilter value={window} onChange={setWindow} />
        <Button
          variant="outline"
          size="sm"
          disabled={selected.length !== 2}
          onClick={() => setDrawerOpen(true)}
        >
          Compare {selected.length}/2
        </Button>
      </div>

      {unknownTrades > 0 && (
        <div className="text-xs text-amber-400 border border-amber-500/30 rounded-md p-2 bg-amber-500/5">
          ⚠️ {unknownTrades} trade{unknownTrades === 1 ? "" : "s"} sem versão conhecida estão agrupados em <code>unknown</code> (backfill).
        </div>
      )}

      <StrategyTable rows={aggregated} selectedHashes={selected} onToggle={toggle} />

      <CompareDrawer open={drawerOpen} onOpenChange={setDrawerOpen} rowA={rowA} rowB={rowB} />
    </div>
  )
}

function StrategiesPage() {
  const { selected, setSelected, visibleBots } = useSelectedBot()
  const show15 = visibleBots.includes("15m")
  const show5 = visibleBots.includes("5m")

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex items-center gap-2">
        <GitBranch className="h-5 w-5 shrink-0" />
        <h1 className="text-lg font-semibold">Strategies</h1>
        <span className="text-xs text-muted-foreground">refreshes every 60s</span>
      </div>

      {visibleBots.length === 0 ? (
        <p className="text-muted-foreground text-sm">Nenhum bot ativo no momento.</p>
      ) : (
        <Tabs value={selected} onValueChange={(v) => setSelected(v as Bot)}>
          <TabsList>
            {show15 && <TabsTrigger value="15m">15-minute bot</TabsTrigger>}
            {show5 && <TabsTrigger value="5m">5-minute bot</TabsTrigger>}
          </TabsList>
          {show15 && (
            <TabsContent value="15m" className="mt-4">
              <BotView bot="15m" />
            </TabsContent>
          )}
          {show5 && (
            <TabsContent value="5m" className="mt-4">
              <BotView bot="5m" />
            </TabsContent>
          )}
        </Tabs>
      )}
    </div>
  )
}
