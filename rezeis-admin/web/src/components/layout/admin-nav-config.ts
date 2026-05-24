/**
 * Sidebar navigation: data + resolution helpers.
 *
 * Pure module — no React, no hooks. Components in `admin-sidebar/`
 * import these constants and the `resolveNavOrder` helper.
 */
import type { ElementType } from 'react'
import {
  LayoutDashboard,
  Users,
  Package,
  CreditCard,
  DollarSign,
  Tag,
  Zap,
  Share2,
  Handshake,
  Megaphone,
  Server,
  Settings,
  Shield,
  Bot,
  Bell,
  Upload,
  ClipboardList,
  Puzzle,
  HelpCircle,
  ShieldAlert,
  BarChart3,
} from 'lucide-react'

import type { SidebarGroupOrder } from '@/stores/sidebar-store'

export interface NavItem {
  /** i18n key under `adminNav.items.*` */
  readonly key: string
  readonly path: string
  readonly icon: ElementType
}

export interface NavGroup {
  /** i18n key under `adminNav.groups.*` */
  readonly key: string
  readonly items: ReadonlyArray<NavItem>
}

export const navGroups: ReadonlyArray<NavGroup> = [
  {
    key: 'operations',
    items: [
      { key: 'dashboard', path: '/', icon: LayoutDashboard },
      { key: 'users', path: '/users', icon: Users },
      { key: 'subscriptions', path: '/subscriptions', icon: CreditCard },
      { key: 'payments', path: '/payments', icon: DollarSign },
      { key: 'supportTickets', path: '/support-tickets', icon: Bell },
      { key: 'fraudSignals', path: '/fraud', icon: ShieldAlert },
      { key: 'automations', path: '/automations', icon: Zap },
      { key: 'analytics', path: '/analytics', icon: BarChart3 },
    ],
  },
  {
    key: 'catalog',
    items: [
      { key: 'plans', path: '/plans', icon: Package },
      { key: 'addOns', path: '/add-ons', icon: Puzzle },
      { key: 'promocodes', path: '/promocodes', icon: Tag },
      { key: 'broadcast', path: '/broadcast', icon: Megaphone },
    ],
  },
  {
    key: 'growth',
    items: [
      { key: 'referrals', path: '/referrals', icon: Share2 },
      { key: 'partners', path: '/partners', icon: Handshake },
    ],
  },
  {
    key: 'configuration',
    items: [
      { key: 'platform', path: '/settings', icon: Settings },
      { key: 'gateways', path: '/payments/gateways', icon: CreditCard },
      { key: 'botConfig', path: '/bot-config', icon: Bot },
      { key: 'remnawave', path: '/remnawave', icon: Server },
      { key: 'notifications', path: '/notifications', icon: Bell },
      { key: 'faq', path: '/faq', icon: HelpCircle },
    ],
  },
  {
    key: 'system',
    items: [
      { key: 'panelSettings', path: '/settings/panel', icon: Settings },
      { key: 'admins', path: '/admins', icon: Shield },
      { key: 'imports', path: '/imports', icon: Upload },
      { key: 'audit', path: '/audit', icon: ClipboardList },
    ],
  },
]

/** Lookup map: item key → NavItem (for resolving custom orders). */
export const navItemMap: ReadonlyMap<string, NavItem> = new Map(
  navGroups.flatMap((g) => g.items.map((item) => [item.key, item])),
)

/**
 * Build the resolved nav structure from the user's persisted custom
 * order. Returns the default tree when nothing has been customised.
 */
export function resolveNavOrder(
  customGroups: ReadonlyArray<SidebarGroupOrder> | null,
  customGroupOrder: ReadonlyArray<string> | null,
): ReadonlyArray<NavGroup> {
  if (!customGroups && !customGroupOrder) return navGroups

  const defaultGroupMap = new Map(navGroups.map((g) => [g.key, g]))
  const groupKeys = customGroupOrder ?? navGroups.map((g) => g.key)

  return groupKeys
    .map((gKey) => {
      const customGroup = customGroups?.find((cg) => cg.groupKey === gKey)
      const defaultGroup = defaultGroupMap.get(gKey)
      if (!defaultGroup) return null

      if (!customGroup) return defaultGroup

      const items = customGroup.itemKeys
        .map((key) => navItemMap.get(key))
        .filter((item): item is NavItem => item != null)

      return { key: gKey, items }
    })
    .filter((g): g is NavGroup => g != null)
}
