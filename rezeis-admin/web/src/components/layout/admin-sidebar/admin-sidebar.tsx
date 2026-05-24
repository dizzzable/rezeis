import { ChevronLeft, Shield } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { useGlassStore } from '@/lib/theme/glass-store'

import { NavItems } from './nav-items'

interface AdminSidebarProps {
  readonly collapsed: boolean
  readonly onToggleCollapsed: () => void
}

/**
 * Desktop sidebar — logo + navigation + collapse toggle.
 * Hidden below md breakpoint; mobile uses the Sheet variant.
 */
export function AdminSidebar({ collapsed, onToggleCollapsed }: AdminSidebarProps) {
  const glassEnabled = useGlassStore((s) => s.glassEnabled)
  const sidebarGlassEnabled = useGlassStore((s) => s.sidebar.enabled)
  const sidebarGlassActive = glassEnabled && sidebarGlassEnabled

  return (
    <aside
      className={cn(
        'relative hidden md:flex flex-col text-sidebar-foreground transition-all duration-300',
        collapsed ? 'w-16' : 'w-64',
        sidebarGlassActive
          ? 'bg-sidebar/50 border-r border-sidebar-border/30'
          : 'bg-sidebar',
      )}
    >
      {/* Logo */}
      <div className="flex h-14 items-center px-4">
        {!collapsed && (
          <span className="text-lg font-bold text-sidebar-foreground">Rezeis Admin</span>
        )}
        {collapsed && <Shield className="h-6 w-6 text-sidebar-foreground" />}
      </div>

      {/* Nav */}
      <ScrollArea className="flex-1 py-2">
        <NavItems collapsed={collapsed} />
      </ScrollArea>

      {/* Collapse toggle */}
      <div className="p-2">
        <Button
          variant="ghost"
          size="icon"
          className="w-full text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          onClick={onToggleCollapsed}
        >
          <ChevronLeft
            className={cn(
              'h-4 w-4 transition-transform duration-200 ease-out',
              collapsed && 'rotate-180',
            )}
            aria-hidden
          />
        </Button>
      </div>
    </aside>
  )
}
