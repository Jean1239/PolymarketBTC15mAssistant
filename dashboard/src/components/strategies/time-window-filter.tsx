import { Button } from "@/components/ui/button"
import type { TimeWindow } from "@/lib/strategy-aggregate"

const OPTIONS: { value: TimeWindow; label: string }[] = [
  { value: "1d", label: "1D" },
  { value: "1w", label: "1W" },
  { value: "1m", label: "1M" },
  { value: "all", label: "All" },
]

export function TimeWindowFilter({
  value,
  onChange,
}: {
  value: TimeWindow
  onChange: (v: TimeWindow) => void
}) {
  return (
    <div data-slot="time-window-filter" className="inline-flex gap-1 rounded-md border border-border p-1 bg-background">
      {OPTIONS.map(opt => (
        <Button
          key={opt.value}
          size="sm"
          variant={value === opt.value ? "default" : "ghost"}
          className="h-7 px-2 text-xs"
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </Button>
      ))}
    </div>
  )
}
