import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { OddBandChart } from "./odd-band-chart"
import { ExitReasonChart } from "./exit-reason-chart"
import type { AggregateRow } from "@/lib/strategy-aggregate"

function fmt(n: number, prefix = ""): string {
  if (!Number.isFinite(n)) return "—"
  const sign = n > 0 ? "+" : ""
  return `${sign}${prefix}${n.toFixed(2)}`
}

function pct(n: number): string {
  if (!Number.isFinite(n)) return "—"
  return `${(n * 100).toFixed(1)}%`
}

function Metrics({ row, label }: { row: AggregateRow; label: string }) {
  return (
    <div className="space-y-1 text-sm">
      <p className="text-xs text-muted-foreground uppercase">{label}</p>
      <p>Trades: <span className="tabular-nums">{row.trades}</span></p>
      <p>P&L net: <span className={`tabular-nums font-medium ${row.pnlNet >= 0 ? "text-green-500" : "text-red-500"}`}>{fmt(row.pnlNet, "$")}</span></p>
      <p>WR: <span className="tabular-nums">{pct(row.winRate)}</span></p>
      <p>PF: <span className="tabular-nums">{Number.isFinite(row.profitFactor) ? row.profitFactor.toFixed(2) : "∞"}</span></p>
      <p>Max DD: <span className="tabular-nums text-red-400">{fmt(row.maxDrawdown, "$")}</span></p>
    </div>
  )
}

export function CompareDrawer({
  open,
  onOpenChange,
  rowA,
  rowB,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  rowA: AggregateRow | null
  rowB: AggregateRow | null
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-3xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle>
            Compare {rowA?.version.label ?? "?"} vs {rowB?.version.label ?? "?"}
          </SheetTitle>
        </SheetHeader>

        {rowA && rowB ? (
          <div className="mt-6 space-y-6 px-4 pb-6">
            <div className="grid grid-cols-2 gap-6">
              <Metrics row={rowA} label={rowA.version.label} />
              <Metrics row={rowB} label={rowB.version.label} />
            </div>

            <div className="grid grid-cols-2 gap-6">
              <OddBandChart bins={rowA.byOddBand} title={`Odd band P&L — ${rowA.version.label}`} />
              <OddBandChart bins={rowB.byOddBand} title={`Odd band P&L — ${rowB.version.label}`} />
            </div>

            <div className="grid grid-cols-2 gap-6">
              <ExitReasonChart data={rowA.byExitReason} title={`Exit reasons — ${rowA.version.label}`} />
              <ExitReasonChart data={rowB.byExitReason} title={`Exit reasons — ${rowB.version.label}`} />
            </div>
          </div>
        ) : (
          <p className="text-muted-foreground mt-6 px-4 text-sm">Select exactly two versions to compare.</p>
        )}
      </SheetContent>
    </Sheet>
  )
}
