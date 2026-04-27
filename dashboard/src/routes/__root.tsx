import { useState } from "react"
import { createRootRoute, Link, Outlet } from "@tanstack/react-router"
import { TanStackRouterDevtools } from "@tanstack/router-devtools"
import { Activity, BarChart3, FolderArchive, Menu, Table2, Wifi } from "lucide-react"
import { Separator } from "@/components/ui/separator"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Toaster } from "@/components/ui/sonner"

export const Route = createRootRoute({
  component: RootLayout,
})

const navItems = [
  { to: "/", label: "Overview", icon: BarChart3, exact: true },
  { to: "/trades", label: "Trades", icon: Table2, exact: false },
  { to: "/signals", label: "Live Signals", icon: Wifi, exact: false },
  { to: "/files", label: "Files", icon: FolderArchive, exact: false },
]

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <>
      {navItems.map(({ to, label, icon: Icon, exact }) => (
        <Link
          key={to}
          to={to}
          activeOptions={{ exact }}
          onClick={onNavigate}
          className="flex items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground [&.active]:bg-accent [&.active]:text-accent-foreground [&.active]:font-medium"
        >
          <Icon className="h-4 w-4 shrink-0" />
          {label}
        </Link>
      ))}
    </>
  )
}

function RootLayout() {
  const [mobileOpen, setMobileOpen] = useState(false)

  return (
    <div className="dark min-h-screen bg-background text-foreground flex flex-col md:flex-row">
      {/* Mobile top bar */}
      <header className="md:hidden flex items-center gap-3 px-4 py-3 border-b border-border shrink-0">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={() => setMobileOpen(true)}
          aria-label="Open menu"
        >
          <Menu className="h-5 w-5" />
        </Button>
        <Activity className="h-5 w-5 text-primary" />
        <span className="font-semibold text-sm tracking-tight">Polymarket BTC</span>
      </header>

      {/* Mobile nav drawer */}
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="dark w-64 p-0">
          <SheetHeader className="px-4 py-4 border-b border-border">
            <SheetTitle className="flex items-center gap-2 text-sm">
              <Activity className="h-5 w-5 text-primary" />
              Polymarket BTC
            </SheetTitle>
          </SheetHeader>
          <nav className="flex flex-col gap-1 p-3">
            <NavLinks onNavigate={() => setMobileOpen(false)} />
          </nav>
        </SheetContent>
      </Sheet>

      {/* Desktop sidebar */}
      <aside className="hidden md:flex w-56 shrink-0 border-r border-border flex-col py-4 px-3 gap-1">
        <div className="flex items-center gap-2 px-2 py-3 mb-2">
          <Activity className="h-5 w-5 text-primary" />
          <span className="font-semibold text-sm tracking-tight">Polymarket BTC</span>
        </div>
        <Separator className="mb-2" />
        <NavLinks />
      </aside>

      <main className="flex-1 overflow-auto min-w-0">
        <Outlet />
      </main>

      {import.meta.env.DEV && <TanStackRouterDevtools />}
      <Toaster position="bottom-right" />
    </div>
  )
}
