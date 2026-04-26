import { createRootRoute, Link, Outlet } from "@tanstack/react-router"
import { TanStackRouterDevtools } from "@tanstack/router-devtools"
import { Activity, BarChart3, Table2, Wifi } from "lucide-react"
import { Separator } from "@/components/ui/separator"

export const Route = createRootRoute({
  component: RootLayout,
})

const navItems = [
  { to: "/", label: "Overview", icon: BarChart3, exact: true },
  { to: "/trades", label: "Trades", icon: Table2, exact: false },
  { to: "/signals", label: "Live Signals", icon: Wifi, exact: false },
]

function RootLayout() {
  return (
    <div className="dark min-h-screen bg-background text-foreground flex">
      <aside className="w-56 shrink-0 border-r border-border flex flex-col py-4 px-3 gap-1">
        <div className="flex items-center gap-2 px-2 py-3 mb-2">
          <Activity className="h-5 w-5 text-primary" />
          <span className="font-semibold text-sm tracking-tight">Polymarket BTC</span>
        </div>
        <Separator className="mb-2" />
        {navItems.map(({ to, label, icon: Icon, exact }) => (
          <Link
            key={to}
            to={to}
            activeOptions={{ exact }}
            className="flex items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground [&.active]:bg-accent [&.active]:text-accent-foreground [&.active]:font-medium"
          >
            <Icon className="h-4 w-4" />
            {label}
          </Link>
        ))}
      </aside>

      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>

      {import.meta.env.DEV && <TanStackRouterDevtools />}
    </div>
  )
}
