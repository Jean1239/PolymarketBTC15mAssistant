import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"
import { useQuery } from "@tanstack/react-query"
import { api } from "@/lib/api"

export type Bot = "15m" | "5m"

interface SelectedBotContextValue {
  selected: Bot
  setSelected: (bot: Bot) => void
  visibleBots: Bot[]
  isLoading: boolean
}

const SelectedBotContext = createContext<SelectedBotContextValue | null>(null)

export function SelectedBotProvider({ children }: { children: ReactNode }) {
  const { data, isLoading } = useQuery({
    queryKey: ["botsStatus"],
    queryFn: api.botsStatus,
    refetchInterval: 15_000,
  })

  // Before botsStatus arrives, assume both visible so tabs render without
  // an empty-state flash on first paint.
  const show15 = data ? data["15m"].active : true
  const show5 = data ? data["5m"].active : true
  const visibleBots = useMemo(
    () => [show15 && "15m", show5 && "5m"].filter(Boolean) as Bot[],
    [show15, show5]
  )

  const [selected, setSelected] = useState<Bot>("15m")

  // Auto-fallback: when the currently selected bot drops out of visibleBots
  // (e.g. its tick CSV went stale), jump to the first available one so the
  // page does not render a controlled Tabs pointing at a hidden trigger.
  useEffect(() => {
    if (visibleBots.length === 0) return
    if (!visibleBots.includes(selected)) {
      setSelected(visibleBots[0])
    }
  }, [visibleBots, selected])

  const value: SelectedBotContextValue = {
    selected,
    setSelected,
    visibleBots,
    isLoading,
  }

  return (
    <SelectedBotContext.Provider value={value}>
      {children}
    </SelectedBotContext.Provider>
  )
}

export function useSelectedBot(): SelectedBotContextValue {
  const ctx = useContext(SelectedBotContext)
  if (!ctx) {
    throw new Error("useSelectedBot must be used inside <SelectedBotProvider>")
  }
  return ctx
}
