import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import { Diff } from "lucide-react"

type DiffMap = Record<string, { from: unknown; to: unknown }>

function renderValue(v: unknown): string {
  if (v === null) return "—"
  if (v === undefined) return "·"
  if (Array.isArray(v)) return `[${v.join(", ")}]`
  if (typeof v === "boolean") return v ? "true" : "false"
  return String(v)
}

export function ConfigDiffPopover({ diff, label }: { diff: DiffMap | null; label: string }) {
  if (!diff || Object.keys(diff).length === 0) {
    return <span className="text-muted-foreground text-xs">—</span>
  }
  const entries = Object.entries(diff)
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="icon" variant="ghost" className="h-6 w-6">
          <Diff className="h-3.5 w-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="left" className="w-80">
        <p className="text-xs text-muted-foreground mb-2">
          {label} vs previous · {entries.length} field{entries.length === 1 ? "" : "s"} changed
        </p>
        <div className="space-y-1 text-xs font-mono">
          {entries.map(([k, v]) => (
            <div key={k} className="flex items-baseline gap-2">
              <span className="text-foreground">{k}:</span>
              <span className="text-red-400 line-through decoration-red-400/40">{renderValue(v.from)}</span>
              <span className="text-muted-foreground">→</span>
              <span className="text-green-400">{renderValue(v.to)}</span>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
