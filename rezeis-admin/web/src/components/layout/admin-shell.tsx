/**
 * AdminShell — routed layout used by every authenticated admin page.
 *
 * This file used to be 965 LOC with five embedded sub-components,
 * three SVG inlined icons, and the entire DnD logic for the sidebar
 * inside one file. The shell is now a thin orchestrator that wires up:
 *
 *  - <QuickSearchOverlay/> (Cmd+K palette) — toggled here so the
 *    keyboard handler is co-located with the state.
 *  - <Sheet/> sidebar for mobile + <AdminSidebar/> for desktop,
 *    sharing the same <NavItems/> implementation.
 *  - <AdminTopbar/> — search trigger, brand links, theme/locale
 *    pickers, profile dropdown.
 *  - <AnimatedOutlet/> — fades routed page content on every render.
 *
 * Each child subscribes to the slice of state it actually needs (theme,
 * locale, glass), so a route change only re-mounts the outlet. The
 * topbar and sidebar do not re-render on route navigation.
 */
import { useEffect, useState } from 'react'

import { OfflineIndicator } from '@/components/layout/offline-indicator'
import { QuickSearchOverlay } from '@/components/quick-search/quick-search-overlay'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { TooltipProvider } from '@/components/ui/tooltip'
import { UpdateBanner } from '@/features/update-checker/update-banner'
import { useGlassStore } from '@/lib/theme/glass-store'
import { cn } from '@/lib/utils'
import { useRealtimeUpdates } from '@/lib/realtime/use-realtime-updates'

import { AdminSidebar } from './admin-sidebar/admin-sidebar'
import { NavItems } from './admin-sidebar/nav-items'
import { AdminTopbar } from './admin-topbar/admin-topbar'
import { AnimatedOutlet } from './animated-outlet'

export default function AdminShell() {
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)

  const glassEnabled = useGlassStore((s) => s.glassEnabled)

  // Subscribe to admin realtime updates as soon as the shell is rendered
  // (i.e. the admin is authenticated). Toasts are limited to WARNING/ERROR
  // events inside the hook itself.
  useRealtimeUpdates()

  // Cmd+K / Ctrl+K shortcut to toggle the quick-search palette.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setSearchOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  return (
    <TooltipProvider delayDuration={0}>
      <div className="flex h-screen overflow-hidden relative z-10">
        {/* Quick Search Overlay */}
        <QuickSearchOverlay open={searchOpen} onClose={() => setSearchOpen(false)} />

        {/* Mobile Sheet sidebar */}
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetContent side="left" className="w-64 bg-sidebar p-0 text-sidebar-foreground">
            <SheetHeader className="flex h-14 flex-row items-center px-4">
              <SheetTitle className="text-lg font-bold text-sidebar-foreground">
                Rezeis Admin
              </SheetTitle>
            </SheetHeader>
            <ScrollArea className="flex-1 py-2">
              <NavItems onNavigate={() => setMobileOpen(false)} />
            </ScrollArea>
          </SheetContent>
        </Sheet>

        {/* Desktop sidebar */}
        <AdminSidebar
          collapsed={collapsed}
          onToggleCollapsed={() => setCollapsed((v) => !v)}
        />

        {/* Main content */}
        <div className="flex flex-1 flex-col overflow-hidden">
          <AdminTopbar
            onOpenMobileSidebar={() => setMobileOpen(true)}
            onOpenSearch={() => setSearchOpen(true)}
          />

          {/* Page content */}
          <main
            className={cn(
              'flex-1 overflow-auto relative',
              glassEnabled ? 'bg-transparent' : 'bg-muted/20',
            )}
          >
            <OfflineIndicator />
            <UpdateBanner />
            <div className="p-4 md:p-6">
              <AnimatedOutlet />
            </div>
          </main>
        </div>
      </div>
    </TooltipProvider>
  )
}
