import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Cell } from "recharts"
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"

const COLORS: Record<string, string> = {
  SETTLED_WIN: "hsl(142 76% 36%)",
  SETTLED_LOSS: "hsl(0 72% 51%)",
  TAKE_PROFIT: "hsl(210 98% 48%)",
  STOP_LOSS: "hsl(38 92% 50%)",
  TIME_DECAY: "hsl(262 83% 58%)",
  SIGNAL_FLIP: "hsl(200 98% 39%)",
}

export function ExitReasonChart({
  data,
  title,
}: {
  data: Record<string, { count: number; pnl: number }>
  title?: string
}) {
  const rows = Object.entries(data)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([reason, d]) => ({ reason, count: d.count, pnl: +d.pnl.toFixed(2) }))

  const config = { count: { label: "Count" } }

  return (
    <div data-slot="exit-reason-chart" className="space-y-1">
      {title && <p className="text-xs text-muted-foreground">{title}</p>}
      <ChartContainer config={config} className="h-44 w-full">
        <BarChart data={rows} layout="vertical">
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(240 3.7% 15.9%)" horizontal={false} />
          <XAxis type="number" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
          <YAxis dataKey="reason" type="category" tick={{ fontSize: 8 }} tickLine={false} axisLine={false} width={84} />
          <ChartTooltip
            content={
              <ChartTooltipContent
                formatter={(value, _name, item) => {
                  const row = item.payload as { pnl: number }
                  return [`${value}  ($${row.pnl})`, "trades"]
                }}
              />
            }
          />
          <Bar dataKey="count" radius={3}>
            {rows.map(r => (
              <Cell key={r.reason} fill={COLORS[r.reason] ?? "hsl(240 5% 64%)"} />
            ))}
          </Bar>
        </BarChart>
      </ChartContainer>
    </div>
  )
}
