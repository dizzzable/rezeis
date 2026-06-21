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
  Settings,
  Shield,
  Bell,
  Upload,
  ClipboardList,
  Puzzle,
  HelpCircle,
  ShieldAlert,
  BarChart3,
  Smartphone,
  Smile,
  Map as MapIcon,
} from 'lucide-react'

import type { SidebarGroupOrder } from '@/stores/sidebar-store'
import { RemnawaveIcon } from '@/features/remnawave/remnawave-icon'
import type { RbacAction } from '@/features/rbac'

export interface NavItem {
  /** i18n key under `adminNav.items.*` */
  readonly key: string
  readonly path: string
  readonly icon: ElementType
  readonly requiredPermission?: {
    readonly resource: string
    readonly action: RbacAction
  }
}

export interface NavGroup {
  /** i18n key under `adminNav.groups.*` */
  readonly key: string
  readonly items: ReadonlyArray<NavItem>
}

type PermissionChecker = (resource: string, action: RbacAction) => boolean

export function canShowNavItem(
  item: NavItem,
  permissionsLoaded: boolean,
  hasPermission: PermissionChecker,
): boolean {
  if (!permissionsLoaded || !item.requiredPermission) return true
  return hasPermission(item.requiredPermission.resource, item.requiredPermission.action)
}

export const navGroups: ReadonlyArray<NavGroup> = [
  {
    key: 'operations',
    items: [
      { key: 'dashboard', path: '/', icon: LayoutDashboard },
      { key: 'users', path: '/users', icon: Users },
      { key: 'subscriptions', path: '/subscriptions', icon: CreditCard },
      { key: 'payments', path: '/payments', icon: DollarSign, requiredPermission: { resource: 'payments', action: 'view' } },
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
      { key: 'emojiPacks', path: '/emoji-packs', icon: Smile },
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
      { key: 'webReiwa', path: '/web-reiwa', icon: Smartphone },
      { key: 'gateways', path: '/payments/gateways', icon: CreditCard, requiredPermission: { resource: 'payment_gateways', action: 'view' } },
      { key: 'botMap', path: '/bot-map', icon: MapIcon },
      { key: 'remnawave', path: '/remnawave', icon: RemnawaveIcon },
      { key: 'notifications', path: '/notifications', icon: Bell },
      { key: 'faq', path: '/faq', icon: HelpCircle },
    ],
  },
  {
    key: 'system',
    items: [
      { key: 'panelSettings', path: '/settings/panel', icon: Settings },
      { key: 'admins', path: '/admins', icon: Shield },
      { key: 'imports', path: '/imports', icon: Upload, requiredPermission: { resource: 'imports', action: 'view' } },
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
 *
 * Forward-compatibility: any nav item shipped in the default config but
 * absent from the persisted custom order (e.g. a feature added after the
 * operator last customised their sidebar) is appended to its default
 * group — or to the first group when its default group is gone — so newly
 * released pages never silently disappear from the sidebar.
 */
export function resolveNavOrder(
  customGroups: ReadonlyArray<SidebarGroupOrder> | null,
  customGroupOrder: ReadonlyArray<string> | null,
): ReadonlyArray<NavGroup> {
  if (!customGroups && !customGroupOrder) return navGroups

  const defaultGroupMap = new Map(navGroups.map((g) => [g.key, g]))
  const groupKeys = customGroupOrder ?? navGroups.map((g) => g.key)

  const resolved = groupKeys
    .map((gKey) => {
      const customGroup = customGroups?.find((cg) => cg.groupKey === gKey)
      const defaultGroup = defaultGroupMap.get(gKey)
      if (!defaultGroup && !customGroup) return null

      if (!customGroup) return defaultGroup ?? null

      const items = customGroup.itemKeys
        .map((key) => navItemMap.get(key))
        .filter((item): item is NavItem => item != null)

      return { key: gKey, items }
    })
    .filter((g): g is NavGroup => g != null)

  // Append any default items missing from the persisted order so newly
  // shipped pages still show up for operators with a customised sidebar.
  const seen = new Set(resolved.flatMap((g) => g.items.map((i) => i.key)))
  const mutableGroups = resolved.map((g) => ({ key: g.key, items: [...g.items] }))
  const groupByKey = new Map(mutableGroups.map((g) => [g.key, g]))

  for (const defaultGroup of navGroups) {
    for (const item of defaultGroup.items) {
      if (seen.has(item.key)) continue
      seen.add(item.key)
      const target =
        groupByKey.get(defaultGroup.key) ?? mutableGroups[0] ?? null
      if (target) {
        target.items.push(item)
      } else {
        const created = { key: defaultGroup.key, items: [item] }
        mutableGroups.push(created)
        groupByKey.set(defaultGroup.key, created)
      }
    }
  }

  return mutableGroups
}
