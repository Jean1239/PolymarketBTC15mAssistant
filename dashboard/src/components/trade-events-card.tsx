import { useQuery } from "@tanstack/react-query"
import { AlertTriangle, CheckCircle2, Radio } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { api, type TradeEvent } from "@/lib/api"

const EVENT_LIMIT = 5

function fmtTs(iso: string | null): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "—"
  return d.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

function EventRow({ event }: { event: TradeEvent }) {
  const isError = event.type === "error"
  return (
    <li className="flex items-start gap-3 py-2 first:pt-0 last:pb-0 border-b border-border last:border-0">
      <div className="shrink-0 mt-0.5">
        {isError ? (
          <AlertTriangle className="h-3.5 w-3.5 text-red-500" />
        ) : (
          <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap text-[10px] text-muted-foreground">
          <Badge
            variant={isError ? "destructive" : "secondary"}
            className="text-[10px] py-0 h-4"
          >
            {isError ? "ERROR" : "ORDER"}
          </Badge>
          <span className="font-mono">{fmtTs(event.timestamp)}</span>
        </div>
        <p className="text-xs font-mono mt-1 break-all leading-snug">
          {event.message}
        </p>
      </div>
    </li>
  )
}

export function TradeEventsCard({
  refreshMs = 5_000,
  className,
}: {
  refreshMs?: number
  className?: string
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["tradeEvents", EVENT_LIMIT],
    queryFn: () => api.tradeEvents(EVENT_LIMIT),
    refetchInterval: refreshMs,
  })

  return (
    <Card className={className}>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Radio className="h-4 w-4 shrink-0" />
          Últimos eventos de trade
          <span className="text-xs text-muted-foreground font-normal ml-1">
            (orders + errors)
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        {isLoading && (
          <p className="text-xs text-muted-foreground">Carregando…</p>
        )}
        {error && (
          <p className="text-xs text-red-500">Falha ao carregar eventos.</p>
        )}
        {data && data.length === 0 && (
          <p className="text-xs text-muted-foreground">
            Nenhum evento registrado ainda.
          </p>
        )}
        {data && data.length > 0 && (
          <ul className="space-y-0">
            {data.map((e, i) => (
              <EventRow key={`${e.timestamp ?? "x"}-${i}`} event={e} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
