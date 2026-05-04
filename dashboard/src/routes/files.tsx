import { createFileRoute } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { useState, useCallback } from "react"
import { Download, FolderArchive, FileSpreadsheet, FileJson, FileText, AlertCircle, Package } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ClearLogsButton } from "@/components/clear-logs-button"
import { api, type LogFile } from "@/lib/api"

export const Route = createFileRoute("/files")({
  component: FilesPage,
})

const ZIP_MAX_BYTES = 50 * 1024 * 1024

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function FileIcon({ name }: { name: string }) {
  const ext = name.split(".").pop()
  if (ext === "csv") return <FileSpreadsheet className="h-4 w-4 text-green-500 shrink-0" />
  if (ext === "json") return <FileJson className="h-4 w-4 text-blue-400 shrink-0" />
  return <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
}

function FileRow({
  file,
  selected,
  onToggle,
}: {
  file: LogFile
  selected: boolean
  onToggle: (name: string) => void
}) {
  const tooLarge = file.size > ZIP_MAX_BYTES
  return (
    <tr
      className="border-b border-border last:border-0 hover:bg-muted/30 transition-colors cursor-pointer"
      onClick={() => onToggle(file.name)}
    >
      <td className="py-3 px-4 w-10">
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggle(file.name)}
          onClick={(e) => e.stopPropagation()}
          className="h-4 w-4 rounded border-border accent-primary cursor-pointer"
        />
      </td>
      <td className="py-3 px-4">
        <div className="flex items-center gap-2 min-w-0">
          <FileIcon name={file.name} />
          <span className="font-mono text-xs truncate">{file.name}</span>
          {tooLarge && (
            <Badge variant="outline" className="text-[10px] py-0 shrink-0 text-orange-400 border-orange-400/40">
              grande
            </Badge>
          )}
        </div>
      </td>
      <td className="py-3 px-4 text-right tabular-nums text-muted-foreground text-xs whitespace-nowrap">
        {formatSize(file.size)}
      </td>
      <td className="py-3 px-4 text-right text-muted-foreground text-xs whitespace-nowrap hidden sm:table-cell">
        {new Date(file.modified).toLocaleString("pt-BR")}
      </td>
      <td className="py-3 px-4 text-right">
        <a
          href={`/api/files/download?name=${encodeURIComponent(file.name)}`}
          download={file.name}
          onClick={(e) => e.stopPropagation()}
        >
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0">
            <Download className="h-3.5 w-3.5" />
          </Button>
        </a>
      </td>
    </tr>
  )
}

function FilesPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["files"],
    queryFn: api.files,
    refetchInterval: 30_000,
  })

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [downloading, setDownloading] = useState(false)

  const toggleFile = useCallback((name: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }, [])

  const allNames = data?.map((f) => f.name) ?? []
  const allChecked = allNames.length > 0 && allNames.every((n) => selected.has(n))
  const someChecked = allNames.some((n) => selected.has(n)) && !allChecked

  const toggleAll = useCallback(() => {
    if (allChecked || someChecked) {
      setSelected(new Set())
    } else {
      setSelected(new Set(allNames))
    }
  }, [allChecked, someChecked, allNames])

  const downloadSelected = useCallback(async () => {
    if (selected.size === 0) return
    setDownloading(true)
    try {
      const res = await fetch("/api/files/zip-selected", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ names: Array.from(selected) }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `polymarket-logs-selected-${new Date().toISOString().slice(0, 10)}.zip`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } finally {
      setDownloading(false)
    }
  }, [selected])

  const included = data?.filter((f) => f.size <= ZIP_MAX_BYTES) ?? []
  const excluded = data?.filter((f) => f.size > ZIP_MAX_BYTES) ?? []
  const totalSize = data?.reduce((s, f) => s + f.size, 0) ?? 0
  const selectedSize = data?.filter((f) => selected.has(f.name)).reduce((s, f) => s + f.size, 0) ?? 0

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <FolderArchive className="h-5 w-5 shrink-0" />
          <h1 className="text-lg font-semibold">Arquivos de Log</h1>
          {data && (
            <span className="text-xs text-muted-foreground">
              {data.length} arquivo{data.length !== 1 ? "s" : ""} · {formatSize(totalSize)} total
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <ClearLogsButton />
          {selected.size > 0 && (
            <Button
              variant="secondary"
              size="sm"
              onClick={downloadSelected}
              disabled={downloading}
            >
              <Package className="h-4 w-4 mr-2" />
              {downloading ? "Gerando ZIP…" : "Baixar selecionados"}
              <span className="ml-1.5 text-xs opacity-70">
                · {selected.size} arquivo{selected.size !== 1 ? "s" : ""} · {formatSize(selectedSize)}
              </span>
            </Button>
          )}
          <a href="/api/files/zip" download={`polymarket-logs-${new Date().toISOString().slice(0, 10)}.zip`}>
            <Button variant="default" size="sm" disabled={included.length === 0}>
              <Download className="h-4 w-4 mr-2" />
              Baixar tudo (ZIP)
              {included.length > 0 && (
                <span className="ml-1.5 text-xs opacity-70">· {included.length} arquivo{included.length !== 1 ? "s" : ""}</span>
              )}
            </Button>
          </a>
        </div>
      </div>

      {excluded.length > 0 && (
        <div className="flex items-start gap-2 text-xs text-muted-foreground bg-muted/40 rounded-md px-3 py-2.5">
          <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-orange-400" />
          <span>
            {excluded.length} arquivo{excluded.length !== 1 ? "s" : ""} maior{excluded.length !== 1 ? "es" : ""} que 50 MB
            {" "}não {excluded.length !== 1 ? "são incluídos" : "é incluído"} no ZIP. Baixe-{excluded.length !== 1 ? "os" : "o"} individualmente.
          </span>
        </div>
      )}

      {isLoading && <p className="text-muted-foreground text-sm p-4">Carregando arquivos…</p>}
      {error && <p className="text-red-500 text-sm p-4">Falha ao carregar lista de arquivos.</p>}

      {data && data.length === 0 && (
        <p className="text-muted-foreground text-sm p-4">Nenhum arquivo encontrado na pasta de logs.</p>
      )}

      {data && data.length > 0 && (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-muted-foreground text-xs uppercase tracking-wide">
                    <th className="py-3 px-4 w-10">
                      <input
                        type="checkbox"
                        checked={allChecked}
                        ref={(el) => { if (el) el.indeterminate = someChecked }}
                        onChange={toggleAll}
                        className="h-4 w-4 rounded border-border accent-primary cursor-pointer"
                      />
                    </th>
                    <th className="text-left py-3 px-4 font-medium">Arquivo</th>
                    <th className="text-right py-3 px-4 font-medium">Tamanho</th>
                    <th className="text-right py-3 px-4 font-medium hidden sm:table-cell">Modificado</th>
                    <th className="py-3 px-4 w-12"></th>
                  </tr>
                </thead>
                <tbody>
                  {data.map((file) => (
                    <FileRow
                      key={file.name}
                      file={file}
                      selected={selected.has(file.name)}
                      onToggle={toggleFile}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
