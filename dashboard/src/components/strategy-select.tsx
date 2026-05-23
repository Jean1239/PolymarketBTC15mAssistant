import { useQuery } from "@tanstack/react-query"
import { api } from "@/lib/api"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useSelectedStrategy, type Bot } from "@/lib/selected-strategy"

export function StrategySelect({ bot }: { bot: Bot }) {
  const { getStrategy, setStrategy } = useSelectedStrategy()
  const value = getStrategy(bot)

  const versionsQuery = useQuery({
    queryKey: ["strategies", bot],
    queryFn: bot === "15m" ? api.strategies15m : api.strategies5m,
  })

  const versions = versionsQuery.data?.versions ?? []

  return (
    <Select value={value} onValueChange={(v) => setStrategy(bot, v)}>
      <SelectTrigger size="sm" className="h-7 text-xs">
        <SelectValue placeholder="Strategy" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All strategies</SelectItem>
        {versions.map((v) => (
          <SelectItem key={v.hash} value={v.hash}>
            {v.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
