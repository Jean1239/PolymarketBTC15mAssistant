import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react"

export type Bot = "15m" | "5m"

interface SelectedStrategyContextValue {
  strategy15m: string
  strategy5m: string
  setStrategy: (bot: Bot, hash: string) => void
  getStrategy: (bot: Bot) => string
}

const SelectedStrategyContext = createContext<SelectedStrategyContextValue | null>(null)

const STORAGE_KEY = "selected-strategy-v1"

function readInitial(): { strategy15m: string; strategy5m: string } {
  if (typeof window === "undefined") return { strategy15m: "all", strategy5m: "all" }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return { strategy15m: "all", strategy5m: "all" }
    const parsed = JSON.parse(raw) as { strategy15m?: string; strategy5m?: string }
    return {
      strategy15m: parsed.strategy15m ?? "all",
      strategy5m: parsed.strategy5m ?? "all",
    }
  } catch {
    return { strategy15m: "all", strategy5m: "all" }
  }
}

export function SelectedStrategyProvider({ children }: { children: ReactNode }) {
  const initial = readInitial()
  const [strategy15m, setS15] = useState<string>(initial.strategy15m)
  const [strategy5m, setS5] = useState<string>(initial.strategy5m)

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ strategy15m, strategy5m }))
    } catch {
      // ignore quota / privacy mode failures
    }
  }, [strategy15m, strategy5m])

  const setStrategy = (bot: Bot, hash: string) => {
    if (bot === "15m") setS15(hash)
    else setS5(hash)
  }

  const getStrategy = (bot: Bot) => (bot === "15m" ? strategy15m : strategy5m)

  return (
    <SelectedStrategyContext.Provider value={{ strategy15m, strategy5m, setStrategy, getStrategy }}>
      {children}
    </SelectedStrategyContext.Provider>
  )
}

export function useSelectedStrategy(): SelectedStrategyContextValue {
  const ctx = useContext(SelectedStrategyContext)
  if (!ctx) {
    throw new Error("useSelectedStrategy must be used inside <SelectedStrategyProvider>")
  }
  return ctx
}
