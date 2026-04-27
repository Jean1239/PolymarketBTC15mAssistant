import { useState } from "react"
import { Trash2 } from "lucide-react"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { api } from "@/lib/api"

export function ClearLogsButton() {
  const queryClient = useQueryClient()
  const [clearing, setClearing] = useState(false)

  async function handleConfirm() {
    setClearing(true)
    try {
      const res = await api.clearLogs()
      await queryClient.invalidateQueries()
      toast.success(
        `${res.cleared.length} arquivo${res.cleared.length !== 1 ? "s" : ""} limpos com sucesso`,
        { description: `Backup salvo em ${res.archive}` }
      )
    } catch {
      toast.error("Erro ao limpar logs", {
        description: "Verifique se o servidor está rodando e tente novamente.",
      })
    } finally {
      setClearing(false)
    }
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="destructive" size="sm" disabled={clearing} className="gap-2">
          <Trash2 className="h-4 w-4" />
          {clearing ? "Limpando…" : "Limpar logs"}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Limpar todos os logs?</AlertDialogTitle>
          <AlertDialogDescription>
            Os arquivos CSV de trades e sinais serão zerados (somente o cabeçalho é mantido).
            Uma cópia de segurança será salva automaticamente em{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">logs/archive/</code>{" "}
            antes de limpar.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancelar</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            Sim, limpar
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
