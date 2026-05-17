import { useEffect, useRef, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Download, FileText } from "lucide-react"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { api } from "@/lib/api"

const TAIL_OPTIONS = [50, 200, 500] as const
type TailSize = (typeof TAIL_OPTIONS)[number]

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function LogViewer({
  name,
  open,
  onOpenChange,
}: {
  name: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [lines, setLines] = useState<TailSize>(50)
  const scrollRef = useRef<HTMLDivElement>(null)

  const { data, isLoading, error, isFetching } = useQuery({
    queryKey: ["fileTail", name, lines],
    queryFn: () => api.fileTail(name!, lines),
    enabled: Boolean(open && name),
    refetchInterval: open ? 5_000 : false,
  })

  // Reset to default whenever a different file is opened.
  useEffect(() => {
    if (open) setLines(50)
  }, [name, open])

  // Auto-scroll to bottom when new data lands (latest line visible).
  useEffect(() => {
    if (data && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [data])

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="dark text-foreground w-full sm:max-w-3xl flex flex-col p-0 gap-0">
        <SheetHeader className="px-4 py-3 border-b border-border">
          <SheetTitle className="flex items-center gap-2 text-sm min-w-0">
            <FileText className="h-4 w-4 shrink-0" />
            <span className="font-mono text-xs truncate">{name ?? ""}</span>
            {data && (
              <Badge variant="outline" className="text-[10px] py-0 shrink-0">
                {formatSize(data.totalSize)}
              </Badge>
            )}
          </SheetTitle>
        </SheetHeader>

        <div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-border flex-wrap">
          <div className="flex items-center gap-1">
            <span className="text-xs text-muted-foreground mr-1">Linhas:</span>
            {TAIL_OPTIONS.map((n) => (
              <Button
                key={n}
                variant={lines === n ? "default" : "ghost"}
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => setLines(n)}
              >
                {n}
              </Button>
            ))}
            {isFetching && !isLoading && (
              <span className="text-[10px] text-muted-foreground ml-2">atualizando…</span>
            )}
          </div>
          {name && (
            <a
              href={`/api/files/download?name=${encodeURIComponent(name)}`}
              download={name}
            >
              <Button variant="ghost" size="sm" className="h-7 text-xs">
                <Download className="h-3 w-3 mr-1" />
                Baixar
              </Button>
            </a>
          )}
        </div>

        <div ref={scrollRef} className="flex-1 overflow-auto bg-muted/20">
          {isLoading && (
            <p className="p-4 text-xs text-muted-foreground">Carregando…</p>
          )}
          {error && (
            <p className="p-4 text-xs text-red-500">Falha ao ler arquivo.</p>
          )}
          {data && data.lines.length === 0 && (
            <p className="p-4 text-xs text-muted-foreground">Arquivo vazio.</p>
          )}
          {data && data.lines.length > 0 && (
            <pre className="text-[11px] leading-relaxed font-mono px-4 py-3 whitespace-pre-wrap break-all">
              {data.lines.join("\n")}
            </pre>
          )}
        </div>

        {data?.truncated && (
          <div className="px-4 py-2 border-t border-border text-[10px] text-muted-foreground">
            Mostrando últimas {data.lines.length} linhas. Baixe pra ver o histórico completo.
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
