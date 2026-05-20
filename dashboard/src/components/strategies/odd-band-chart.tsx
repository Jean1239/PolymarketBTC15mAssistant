import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Cell, LabelList } from "recharts"
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"
import type { OddBand } from "@/lib/strategy-aggregate"

export function OddBandChart({ bins, title }: { bins: OddBand[]; title?: string }) {
  const data = bins.map(b => ({
    label: b.label,
    pnl: +b.pnl.toFixed(2),
    count: b.count,
    wr: (b.winRate * 100).toFixed(0),
  }))

  const config = {
    pnl: { label: "P&L net", color: "hsl(142 76% 36%)" },
  }

  return (
    <div data-slot="odd-band-chart" className="space-y-1">
      {title && <p className="text-xs text-muted-foreground">{title}</p>}
      <ChartContainer config={config} className="h-44 w-full">
        <BarChart data={data} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(240 3.7% 15.9%)" />
          <XAxis dataKey="label" tick={{ fontSize: 9 }} tickLine={false} axisLine={false} interval={0} angle={-30} textAnchor="end" height={48} />
          <YAxis tick={{ fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={(v) => `$${v}`} />
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelKey="label"
                formatter={(value, _name, item) => {
                  const row = item.payload as { count: number; wr: string; pnl: number }
                  return [`$${value}  (n=${row.count}, WR=${row.wr}%)`, "P&L"]
                }}
              />
            }
          />
          <Bar dataKey="pnl" radius={3}>
            {data.map((d, i) => (
              <Cell key={i} fill={d.pnl >= 0 ? "hsl(142 76% 36%)" : "hsl(0 72% 51%)"} />
            ))}
            <LabelList dataKey="count" position="top" className="fill-muted-foreground text-[9px]" />
          </Bar>
        </BarChart>
      </ChartContainer>
    </div>
  )
}
