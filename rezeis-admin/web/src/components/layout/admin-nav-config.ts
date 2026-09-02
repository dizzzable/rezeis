/**
 * Sidebar navigation: data + resolution helpers.
 *
 * Pure module — no React, no hooks. Components in `admin-sidebar/`
 * import these constants and the `resolveNavOrder` helper.
 */
import type { ElementType } from 'react';
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
  Trophy,
  Settings,
  Coins,
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
  LogIn,
  Map as MapIcon,
  Globe,
  LayoutTemplate,
  Bot,
  FileText,
  Archive,
  Banknote,
  FileCog,
  Key,
  Network,
  ScrollText,
  ShieldBan,
  ShieldCheck,
  UsersRound,
  UserX,
  Webhook,
} from 'lucide-react';

import type { SidebarGroupOrder } from '@/stores/sidebar-store';
import { RemnawaveIcon } from '@/features/remnawave/remnawave-icon';
import type { RbacAction } from '@/features/rbac';

export interface NavItem {
  /** i18n key under `adminNav.items.*` */
  readonly key: string;
  readonly path: string;
  readonly icon: ElementType;
  readonly requiredPermission?: {
    readonly resource: string;
    readonly action: RbacAction;
  };
}

export interface NavGroup {
  /** i18n key under `adminNav.groups.*` */
  readonly key: string;
  readonly items: ReadonlyArray<NavItem>;
}

type PermissionChecker = (resource: string, action: RbacAction) => boolean;

export function canShowNavItem(
  item: NavItem,
  permissionsLoaded: boolean,
  hasPermission: PermissionChecker,
): boolean {
  if (!permissionsLoaded || !item.requiredPermission) return true;
  return hasPermission(item.requiredPermission.resource, item.requiredPermission.action);
}

export const navGroups: ReadonlyArray<NavGroup> = [
  {
    key: 'operations',
    items: [
      { key: 'dashboard', path: '/', icon: LayoutDashboard },
      { key: 'users', path: '/users', icon: Users },
      { key: 'subscriptions', path: '/subscriptions', icon: CreditCard },
      {
        key: 'payments',
        path: '/payments',
        icon: DollarSign,
        requiredPermission: { resource: 'payments', action: 'view' },
      },
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
      {
        key: 'advertising',
        path: '/advertising',
        icon: Megaphone,
        requiredPermission: { resource: 'advertising', action: 'view' },
      },
      {
        key: 'quests',
        path: '/quests',
        icon: Trophy,
        requiredPermission: { resource: 'quests', action: 'view' },
      },
    ],
  },
  {
    key: 'configuration',
    items: [
      { key: 'platform', path: '/settings', icon: Settings },
      { key: 'webReiwa', path: '/web-reiwa', icon: Smartphone },
      {
        key: 'subpageConfig',
        path: '/subpage-config',
        icon: Globe,
        requiredPermission: { resource: 'subpage_config', action: 'view' },
      },
      {
        key: 'landingBuilder',
        path: '/landing-builder',
        icon: LayoutTemplate,
        requiredPermission: { resource: 'landing_config', action: 'view' },
      },
      {
        key: 'gateways',
        path: '/payments/gateways',
        icon: CreditCard,
        requiredPermission: { resource: 'payment_gateways', action: 'view' },
      },
      {
        key: 'externalAuth',
        path: '/external-auth',
        icon: LogIn,
        requiredPermission: { resource: 'external_auth', action: 'view' },
      },
      { key: 'botMap', path: '/bot-map', icon: MapIcon },
      { key: 'remnawave', path: '/remnawave', icon: RemnawaveIcon },
      { key: 'notifications', path: '/notifications', icon: Bell },
      {
        key: 'legalDocuments',
        path: '/legal-documents',
        icon: FileText,
        requiredPermission: { resource: 'settings', action: 'view' },
      },
      { key: 'faq', path: '/faq', icon: HelpCircle },
      { key: 'aiSupport', path: '/ai-support', icon: Bot },
    ],
  },
  {
    key: 'system',
    items: [
      { key: 'panelSettings', path: '/settings/panel', icon: Settings },
      { key: 'admins', path: '/admins', icon: Shield },
      {
        key: 'imports',
        path: '/imports',
        icon: Upload,
        requiredPermission: { resource: 'imports', action: 'view' },
      },
      { key: 'audit', path: '/audit', icon: ClipboardList },
    ],
  },
];

/**
 * Tab values each hub page will accept in a `#hash`, keyed by pathname.
 *
 * This lives here, in a pure module, rather than in the five page components,
 * because it is the ONLY thing that makes a deep link like
 * `/settings/panel#backups` more than a hopeful string. The pages feed these
 * arrays straight into `useTabSync`, and `deepLinkNavItems` below is checked
 * against them — so renaming a tab value breaks the page and the link together,
 * at compile time, instead of leaving a Cmd+K row that silently lands on the
 * wrong tab.
 *
 * Keep each array identical to that page's `TabsTrigger` / `TabsContent`
 * values. A value listed here that the page does not render shows an empty
 * panel; a value the page renders but omits here is unreachable by deep link.
 */
export const HUB_TABS = {
  '/users': ['list', 'bulk', 'blocked-identities'],
  '/partners': ['partners', 'withdrawals', 'analytics', 'settings'],
  // `blocked-identities` здесь больше нет: он закрывает вход КЛИЕНТУ и живёт
  // на странице пользователей. Здесь остаётся то, что закрывает доступ в саму
  // панель, включая бывшего администратора.
  '/admins': ['admins', 'roles', 'ip-allowlist', 'webhooks', 'blocked-ips'],
  '/audit': ['audit', 'system-events', 'user-events', 'system-logs'],
  '/settings/panel': [
    'api-tokens',
    'appearance',
    'security',
    'backups',
    'branding',
    'config',
    'anti-fraud',
  ],
} as const;

/**
 * Surfaces that exist and are routable but have NO sidebar entry, because they
 * were folded into a tab of another page (`/admins#roles`, `/partners#withdrawals`,
 * `/settings/panel#backups`, …) and `router.tsx` keeps the old standalone path
 * alive only as a redirect.
 *
 * They are deliberately NOT in `navGroups`. That array is the SIDEBAR: anything
 * added there shows up in the rail and in the drag-to-reorder editor, which is a
 * product decision about the sidebar's shape, not about findability. These
 * eleven are the other half of the problem — reachable by URL, invisible to
 * anyone who does not already know the URL. The Cmd+K overlay indexes both
 * lists, so they become findable without the sidebar growing by eleven rows.
 *
 * Every entry carries `requiredPermission`. That is not optional here even
 * though `canShowNavItem` treats it as optional: a page-jump row that lands an
 * operator on a surface their role cannot open converts "I cannot find it" into
 * "the panel is broken", and unlike a sidebar rail — which an operator learns
 * once and then ignores — a search result is something they act on immediately.
 *
 * Every `path` here is verified to actually land on its section: the three
 * hash-consuming pages read it through `useTabSync` (`admins-page.tsx`,
 * `partners-page.tsx`, `users-page.tsx`), and `panel-settings-hub.tsx` /
 * `audit-page.tsx` were converted to it for exactly this reason. A path whose
 * anchor is ignored belongs in neither list — it is a row that lies.
 */
export const deepLinkNavItems: ReadonlyArray<NavItem & { readonly groupKey: string }> = [
  // ── Growth ────────────────────────────────────────────────────────────────
  {
    key: 'withdrawals',
    path: '/partners#withdrawals',
    icon: Banknote,
    groupKey: 'growth',
    requiredPermission: { resource: 'withdrawals', action: 'view' },
  },
  // ── Configuration ─────────────────────────────────────────────────────────
  {
    // Settings → Points: the global cashback rule and what points buy. Reached
    // from the platform settings grid; listed here so ⌘K finds it by name.
    key: 'pointsSettings',
    path: '/settings/points',
    icon: Coins,
    groupKey: 'configuration',
    requiredPermission: { resource: 'settings', action: 'view' },
  },
  // ── Operations ────────────────────────────────────────────────────────────
  {
    key: 'bulkUsers',
    path: '/users#bulk',
    icon: UsersRound,
    groupKey: 'operations',
    requiredPermission: { resource: 'users', action: 'bulk_operations' },
  },
  {
    key: 'blockedIdentities',
    // Рядом с `bulkUsers`: это вторая вкладка ТОЙ ЖЕ страницы, и группы здесь
    // свои — `operations` / `catalog` / `growth` / `configuration` / `system`,
    // без `users`. Список отказывает в РЕГИСТРАЦИИ клиенту и к доступу в саму
    // панель отношения не имеет, поэтому он больше не живёт у администраторов.
    path: '/users#blocked-identities',
    icon: UserX,
    groupKey: 'operations',
    requiredPermission: { resource: 'blocked_identities', action: 'view' },
  },
  // ── System ────────────────────────────────────────────────────────────────
  {
    key: 'roles',
    path: '/admins#roles',
    icon: ShieldCheck,
    groupKey: 'system',
    requiredPermission: { resource: 'rbac_roles', action: 'view' },
  },
  {
    // No `ip_allowlist` resource exists in the RBAC catalog; the tab lives
    // inside the Admins page, so that is the permission that governs it.
    key: 'ipAllowlist',
    path: '/admins#ip-allowlist',
    icon: Network,
    groupKey: 'system',
    requiredPermission: { resource: 'admins', action: 'view' },
  },
  {
    key: 'webhooks',
    path: '/admins#webhooks',
    icon: Webhook,
    groupKey: 'system',
    requiredPermission: { resource: 'webhooks', action: 'view' },
  },
  {
    key: 'blockedIps',
    path: '/admins#blocked-ips',
    icon: ShieldBan,
    groupKey: 'system',
    requiredPermission: { resource: 'blocked_ips', action: 'view' },
  },
  {
    key: 'apiTokens',
    // The one entry here that is a real route rather than a hash anchor, so
    // there is no anchor to get wrong.
    path: '/settings/api-tokens',
    icon: Key,
    groupKey: 'system',
    requiredPermission: { resource: 'api_tokens', action: 'view' },
  },
  {
    key: 'backup',
    path: '/settings/panel#backups',
    icon: Archive,
    groupKey: 'system',
    requiredPermission: { resource: 'backups', action: 'view' },
  },
  {
    key: 'configPortability',
    path: '/settings/panel#config',
    icon: FileCog,
    groupKey: 'system',
    requiredPermission: { resource: 'config_portability', action: 'view' },
  },
  {
    key: 'systemLogs',
    path: '/audit#system-logs',
    icon: ScrollText,
    groupKey: 'system',
    requiredPermission: { resource: 'system_logs', action: 'view' },
  },
  {
    // Left ungated ON PURPOSE. The Security tab's trigger carries no
    // `PermissionGate` in `panel-settings-hub.tsx` — its headline block is the
    // admin's OWN TOTP enrolment, which every signed-in admin may reach.
    // Inventing a permission here would hide a row for a page the operator can
    // open, which is the same failure as showing one they cannot.
    key: 'twoFactor',
    path: '/settings/panel#security',
    icon: Shield,
    groupKey: 'system',
  },
];

/** Lookup map: item key → NavItem (for resolving custom orders). */
export const navItemMap: ReadonlyMap<string, NavItem> = new Map(
  navGroups.flatMap((g) => g.items.map((item) => [item.key, item])),
);

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
  if (!customGroups && !customGroupOrder) return navGroups;

  const defaultGroupMap = new Map(navGroups.map((g) => [g.key, g]));
  const groupKeys = customGroupOrder ?? navGroups.map((g) => g.key);

  const resolved = groupKeys
    .map((gKey) => {
      const customGroup = customGroups?.find((cg) => cg.groupKey === gKey);
      const defaultGroup = defaultGroupMap.get(gKey);
      if (!defaultGroup && !customGroup) return null;

      if (!customGroup) return defaultGroup ?? null;

      const items = customGroup.itemKeys
        .map((key) => navItemMap.get(key))
        .filter((item): item is NavItem => item != null);

      return { key: gKey, items };
    })
    .filter((g): g is NavGroup => g != null);

  // Append any default items missing from the persisted order so newly
  // shipped pages still show up for operators with a customised sidebar.
  const seen = new Set(resolved.flatMap((g) => g.items.map((i) => i.key)));
  const mutableGroups = resolved.map((g) => ({ key: g.key, items: [...g.items] }));
  const groupByKey = new Map(mutableGroups.map((g) => [g.key, g]));

  for (const defaultGroup of navGroups) {
    for (const item of defaultGroup.items) {
      if (seen.has(item.key)) continue;
      seen.add(item.key);
      const target = groupByKey.get(defaultGroup.key) ?? mutableGroups[0] ?? null;
      if (target) {
        target.items.push(item);
      } else {
        const created = { key: defaultGroup.key, items: [item] };
        mutableGroups.push(created);
        groupByKey.set(defaultGroup.key, created);
      }
    }
  }

  return mutableGroups;
}
