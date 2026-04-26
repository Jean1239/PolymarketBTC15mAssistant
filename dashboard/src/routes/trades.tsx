import { createFileRoute } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { Table2 } from "lucide-react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { api, type Trade } from "@/lib/api"

export const Route = createFileRoute("/trades")({
  component: TradesPage,
})

const EXIT_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  SETTLED_WIN: "default",
  SETTLED_LOSS: "destructive",
  TAKE_PROFIT: "default",
  STOP_LOSS: "destructive",
  TIME_DECAY: "secondary",
  SIGNAL_FLIP: "outline",
}

const rtf = new Intl.RelativeTimeFormat("pt-BR", { numeric: "auto" })

function relativeTime(iso: string): string {
  const diffS = (new Date(iso).getTime() - Date.now()) / 1000
  const abs = Math.abs(diffS)
  if (abs < 60) return rtf.format(Math.round(diffS), "second")
  if (abs < 3600) return rtf.format(Math.round(diffS / 60), "minute")
  if (abs < 86400) return rtf.format(Math.round(diffS / 3600), "hour")
  return rtf.format(Math.round(diffS / 86400), "day")
}

function fmtLocalBR(iso: string): string {
  return new Date(iso).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function fmtDur(s: number) {
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m${s % 60}s`
}

function TradesTable({ trades }: { trades: Trade[] }) {
  if (trades.length === 0) return <p className="text-muted-foreground text-sm p-4">No trades yet.</p>

  const sorted = [...trades].reverse()

  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <div className="overflow-y-auto max-h-[calc(100svh-230px)]">
        <Table className="min-w-[800px]">
          <TableHeader>
            <TableRow>
              <TableHead>Entry</TableHead>
              <TableHead>Market</TableHead>
              <TableHead>Side</TableHead>
              <TableHead className="text-right">Invested</TableHead>
              <TableHead className="text-right">Entry $</TableHead>
              <TableHead className="text-right">Exit $</TableHead>
              <TableHead className="text-right">ROI</TableHead>
              <TableHead className="text-right">P&L</TableHead>
              <TableHead>Exit Reason</TableHead>
              <TableHead className="text-right">Duration</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((t, i) => {
              const roi = t.roi_pct
              const pnl = t.pnl
              return (
                <TableRow key={i}>
                  <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                    <span className="block font-medium text-foreground">{relativeTime(t.entry_time)}</span>
                    <span className="block text-[10px] opacity-60">{fmtLocalBR(t.entry_time)}</span>
                  </TableCell>
                  <TableCell className="text-xs font-mono max-w-[160px] truncate">{t.market_slug}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className={t.side === "UP" ? "text-green-500 border-green-500/30" : "text-red-500 border-red-500/30"}>
                      {t.side}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">${(+t.invested).toFixed(2)}</TableCell>
                  <TableCell className="text-right tabular-nums">{(+t.entry_price).toFixed(2)}</TableCell>
                  <TableCell className="text-right tabular-nums">{(+t.exit_price).toFixed(2)}</TableCell>
                  <TableCell className={`text-right tabular-nums font-medium ${roi >= 0 ? "text-green-500" : "text-red-500"}`}>
                    {roi >= 0 ? "+" : ""}{roi.toFixed(1)}%
                  </TableCell>
                  <TableCell className={`text-right tabular-nums font-medium ${pnl >= 0 ? "text-green-500" : "text-red-500"}`}>
                    {pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={EXIT_VARIANT[t.exit_reason] ?? "outline"} className="text-xs whitespace-nowrap">
                      {t.exit_reason}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground">{fmtDur(+t.duration_s)}</TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

function TradesPage() {
  const q15 = useQuery({ queryKey: ["trades-15m"], queryFn: api.trades15m, refetchInterval: 30_000 })
  const q5 = useQuery({ queryKey: ["trades-5m"], queryFn: api.trades5m, refetchInterval: 30_000 })

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex items-center gap-2">
        <Table2 className="h-5 w-5 shrink-0" />
        <h1 className="text-lg font-semibold">Trade History</h1>
      </div>

      <Tabs defaultValue="15m">
        <TabsList>
          <TabsTrigger value="15m">15-minute bot</TabsTrigger>
          <TabsTrigger value="5m">5-minute bot</TabsTrigger>
        </TabsList>

        <TabsContent value="15m" className="mt-4">
          {q15.isLoading ? <p className="text-muted-foreground">Loading…</p> : <TradesTable trades={q15.data ?? []} />}
        </TabsContent>
        <TabsContent value="5m" className="mt-4">
          {q5.isLoading ? <p className="text-muted-foreground">Loading…</p> : <TradesTable trades={q5.data ?? []} />}
        </TabsContent>
      </Tabs>
    </div>
  )
}
