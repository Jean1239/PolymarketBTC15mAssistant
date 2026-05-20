import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ConfigDiffPopover } from "./config-diff-popover"
import type { AggregateRow } from "@/lib/strategy-aggregate"

function fmtPeriod(start: string, end: string | null): string {
  if (start === "0000-01-01T00:00:00.000Z") {
    return end ? `pré-${end.slice(0, 10)}` : "pré-history"
  }
  const a = start.slice(0, 10)
  const b = end ? end.slice(0, 10) : "now"
  return `${a} → ${b}`
}

function fmtNum(n: number, prefix = "", digits = 2): string {
  if (!Number.isFinite(n)) return "—"
  const sign = n > 0 ? "+" : ""
  return `${sign}${prefix}${n.toFixed(digits)}`
}

function pctNum(n: number): string {
  if (!Number.isFinite(n)) return "—"
  return `${(n * 100).toFixed(1)}%`
}

export function StrategyTable({
  rows,
  selectedHashes,
  onToggle,
}: {
  rows: AggregateRow[]
  selectedHashes: string[]
  onToggle: (hash: string) => void
}) {
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <Table className="min-w-[860px]">
        <TableHeader>
          <TableRow>
            <TableHead className="w-8"></TableHead>
            <TableHead>Version</TableHead>
            <TableHead>Period</TableHead>
            <TableHead className="text-right">Trades</TableHead>
            <TableHead className="text-right">P&L net</TableHead>
            <TableHead className="text-right">WR</TableHead>
            <TableHead className="text-right">PF</TableHead>
            <TableHead className="text-right">Max DD</TableHead>
            <TableHead>Diff</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(row => {
            const isSelected = selectedHashes.includes(row.version.hash)
            return (
              <TableRow key={row.version.hash} data-state={isSelected ? "selected" : undefined}>
                <TableCell>
                  <Checkbox
                    checked={isSelected}
                    onCheckedChange={() => onToggle(row.version.hash)}
                    aria-label={`select ${row.version.label}`}
                  />
                </TableCell>
                <TableCell className="font-mono">
                  <span>{row.version.label}</span>
                  {row.version.partial && (
                    <Badge variant="outline" className="ml-2 text-[10px] border-amber-500/40 text-amber-400">
                      partial
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                  {fmtPeriod(row.version.startedAt, row.version.endedAt)}
                </TableCell>
                <TableCell className="text-right tabular-nums">{row.trades}</TableCell>
                <TableCell className={`text-right tabular-nums font-medium ${row.pnlNet >= 0 ? "text-green-500" : "text-red-500"}`}>
                  {fmtNum(row.pnlNet, "$")}
                </TableCell>
                <TableCell className="text-right tabular-nums">{pctNum(row.winRate)}</TableCell>
                <TableCell className="text-right tabular-nums">{Number.isFinite(row.profitFactor) ? row.profitFactor.toFixed(2) : "∞"}</TableCell>
                <TableCell className="text-right tabular-nums text-red-400">{fmtNum(row.maxDrawdown, "$")}</TableCell>
                <TableCell>
                  <ConfigDiffPopover diff={row.version.configDiff} label={row.version.label} />
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}
