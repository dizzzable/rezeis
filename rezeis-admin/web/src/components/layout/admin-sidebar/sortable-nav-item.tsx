import { useTranslation } from 'react-i18next'
import { NavLink } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical } from 'lucide-react'
import type { ComponentType, SVGProps } from 'react'

import { api } from '@/lib/api'
import { motion } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

import type { NavItem } from '../admin-nav-config'

interface SortableNavItemProps {
  readonly item: NavItem
  readonly isCurrent: boolean
  readonly collapsed: boolean
  readonly editMode: boolean
  readonly onNavigate?: () => void
  readonly globalIndex: number
}

/**
 * One row in the sidebar. Behaves as a `<NavLink>` in normal mode and
 * as a draggable handle in edit mode (kept stable via dnd-kit's
 * `useSortable`).
 */
export function SortableNavItem({
  item,
  isCurrent,
  collapsed,
  editMode,
  onNavigate,
  globalIndex,
}: SortableNavItemProps) {
  const { t } = useTranslation()
  const ItemIcon = item.icon as ComponentType<SVGProps<SVGSVGElement>>
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.key, disabled: !editMode })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 50 : undefined,
  }

  const label = t(`adminNav.items.${item.key}`)

  // Support-tickets queue badge: show the count of OPEN tickets (a user wrote
  // and is awaiting an operator reply) so new conversations are noticed
  // without opening the page. The query only runs for this nav row; the item
  // itself is already permission-gated upstream, so reaching here implies the
  // operator may view support tickets.
  const isSupport = item.key === 'supportTickets'
  const { data: supportStats } = useQuery({
    queryKey: ['support-tickets', 'stats', 'nav-badge'],
    queryFn: async () =>
      (await api.get<{ open: number; waitingReply: number; closed: number; total: number }>(
        '/admin/support-tickets/stats',
      )).data,
    enabled: isSupport && !editMode,
    staleTime: 30_000,
    refetchInterval: isSupport ? 60_000 : false,
  })
  const badgeCount = isSupport ? (supportStats?.open ?? 0) : 0
  const showBadge = badgeCount > 0 && !editMode

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div ref={setNodeRef} style={style} className="relative">
          <NavLink
            to={item.path}
            end
            onClick={editMode ? (e) => e.preventDefault() : onNavigate}
            className={cn(
              'group relative flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
              isCurrent
                ? 'text-sidebar-primary-foreground'
                : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
              collapsed && 'justify-center px-2',
              editMode && 'cursor-grab active:cursor-grabbing',
              isDragging && 'bg-sidebar-accent rounded-md shadow-lg',
            )}
            {...(editMode ? { ...attributes, ...listeners } : {})}
          >
            <>
              {isCurrent && !editMode && (
                <motion.span
                  layoutId="sidebar-active-indicator"
                  className="absolute inset-0 rounded-md bg-sidebar-primary"
                  transition={{ type: 'spring', stiffness: 400, damping: 32 }}
                />
              )}
              <motion.span
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.22, delay: globalIndex * 0.015, ease: [0.16, 1, 0.3, 1] }}
                className="relative z-10 flex items-center gap-3 w-full"
              >
                {editMode && !collapsed && (
                  <GripVertical className="h-3.5 w-3.5 shrink-0 text-sidebar-foreground/40" />
                )}
                <ItemIcon className="h-4 w-4 shrink-0" />
                {!collapsed && <span>{label}</span>}
                {showBadge && !collapsed && (
                  <span
                    className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-rose-500 px-1.5 text-[10px] font-bold text-white"
                    aria-label={t('supportTicketsPage.navBadgeAria', { count: badgeCount })}
                  >
                    {badgeCount > 99 ? '99+' : badgeCount}
                  </span>
                )}
                {showBadge && collapsed && (
                  <span
                    className="absolute right-1 top-1 h-2 w-2 rounded-full bg-rose-500"
                    aria-label={t('supportTicketsPage.navBadgeAria', { count: badgeCount })}
                  />
                )}
              </motion.span>
            </>
          </NavLink>
        </div>
      </TooltipTrigger>
      {collapsed && <TooltipContent side="right">{label}</TooltipContent>}
    </Tooltip>
  )
}
