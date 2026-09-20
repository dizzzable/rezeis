/**
 * Where every i18n key lives in the panel.
 *
 * The search index is built from the translation dictionaries — that is what
 * makes it "the words that are on the page" rather than a hand-written list of
 * page names that goes stale the day after it is written. A dictionary key
 * knows its own text but not its address, so this module supplies the missing
 * half: key prefix → route (with the `#tab` when the surface is a tab).
 *
 * Two rules keep it honest:
 *
 *  1. Longest prefix wins. `settings.apiTokens.*` lives on a different tab from
 *     the rest of `settings.*`, and saying so costs one line.
 *  2. Every namespace is either mapped or listed in `IGNORED_NAMESPACES`.
 *     `search-pages.test.ts` walks the real dictionaries and fails on anything
 *     that is neither, so a namespace added next month cannot silently become
 *     unsearchable — which is exactly how a search index rots.
 *
 * Permissions are NOT repeated here. Every target resolves to a sidebar or
 * deep-link nav row, and that row's `requiredPermission` gates the search hit
 * exactly as it gates the menu entry: a result an operator cannot open is
 * worse than no result at all.
 */
import {
  HUB_TABS,
  deepLinkNavItems,
  navGroups,
  type NavItem,
} from '@/components/layout/admin-nav-config';

/**
 * Key prefix → route. The prefix is matched on dot boundaries, so
 * `settings` never swallows `settingsPage`.
 */
export const SEARCH_KEY_TARGETS: Readonly<Record<string, string>> = {
  // ── Operations ────────────────────────────────────────────────────────────
  dashboard: '/',
  dashboardPage: '/',
  usersPage: '/users',
  userDetailPage: '/users',
  // The user card is `/users/:telegramId`; there is no static route to send an
  // operator to, so its settings land on the list they open it from.
  userDetailPanel: '/users',
  bulkUsersPage: '/users#bulk',
  blockedIdentitiesPage: '/users#blocked-identities',
  subscriptionsPage: '/subscriptions',
  autoRenewPanel: '/subscriptions',
  duplicateMerge: '/subscriptions',
  panelLinkReconciliation: '/subscriptions',
  unknownSquads: '/subscriptions',
  paymentsPage: '/payments',
  paymentsAccess: '/payments',
  paymentsAnalytics: '/payments#analytics',
  paymentsReconciliation: '/payments#webhooks',
  paymentGateways: '/payments/gateways',
  supportTicketsPage: '/support-tickets',
  fraudPage: '/fraud',
  automationsPage: '/automations',
  userHints: '/automations#hints',
  analyticsPage: '/analytics',

  // ── Catalog ───────────────────────────────────────────────────────────────
  plansPage: '/plans',
  planForm: '/plans',
  addOnsPage: '/add-ons',
  promocodesIndex: '/promocodes',
  promocodeForm: '/promocodes',
  promocodeFormExtras: '/promocodes',
  broadcastPage: '/broadcast',
  emojiPacksPage: '/emoji-packs',
  emojiField: '/emoji-packs',

  // ── Growth ────────────────────────────────────────────────────────────────
  referrals: '/referrals',
  referralsPage: '/referrals',
  referralsActions: '/referrals',
  referralsAnalytics: '/referrals',
  referralSettingsPage: '/settings/referral',
  partners: '/partners',
  partnersPage: '/partners',
  partnersList: '/partners',
  partnersDetail: '/partners',
  partnersAnalytics: '/partners#analytics',
  withdrawalsPage: '/partners#withdrawals',
  partnerSettingsPage: '/settings/partner',
  pointsSettingsPage: '/settings/points',
  advertisingPage: '/advertising',
  questsAdminPage: '/quests',
  questPartnersSettings: '/settings/panel#security',
  wheelConfigPage: '/wheel',
  contestsPage: '/contests',
  wheelPrizesPage: '/wheel/prizes',
  wheelKeysPage: '/wheel/keys',

  // ── Configuration ─────────────────────────────────────────────────────────
  settingsPage: '/settings',
  accessModePage: '/settings',
  'settings.apiTokens': '/settings/panel#api-tokens',
  settings: '/settings',
  remnaWavePage: '/remnawave',
  remnaActions: '/remnawave',
  botMapPage: '/bot-map',
  botConfigPage: '/bot-map',
  botFlow: '/bot-map',
  botStudio: '/bot-map',
  botBanner: '/bot-map',
  notificationsPage: '/notifications',
  brandingPage: '/web-reiwa',
  subpageConfigPage: '/subpage-config',
  connectPageEditor: '/subpage-config',
  connectScreen: '/subpage-config',
  landingBuilderPage: '/landing-builder',
  legalDocumentsPage: '/legal-documents',
  externalAuthPage: '/external-auth',
  faqPage: '/faq',
  aiSupport: '/ai-support',

  // ── System ────────────────────────────────────────────────────────────────
  panelSettings: '/settings/panel',
  appearancePage: '/settings/panel#appearance',
  glassSettings: '/settings/panel#appearance',
  effectsSettings: '/settings/panel#appearance',
  twoFactorPage: '/settings/panel#security',
  pushNotifications: '/settings/panel#security',
  authProviders: '/settings/panel#security',
  panelBrandingTab: '/settings/panel#branding',
  panelIcons: '/settings/panel#branding',
  backupPage: '/settings/panel#backups',
  backupBadges: '/settings/panel#backups',
  configPortabilityPage: '/settings/panel#config',
  antiFraudTab: '/settings/panel#anti-fraud',
  adminsPage: '/admins',
  rolesPage: '/admins#roles',
  ipAllowlistPage: '/admins#ip-allowlist',
  webhooksPage: '/admins#webhooks',
  blockedIpsPage: '/admins#blocked-ips',
  importsPage: '/imports',
  auditPage: '/audit',
  systemLogsPage: '/audit#system-logs',
};

/**
 * Namespaces that are deliberately NOT indexed.
 *
 * Three kinds, and all three are about precision rather than size. Panel
 * chrome (`adminShell`, `savedFiltersBar`) belongs to no page, so a hit on it
 * can only point somewhere arbitrary. Failure copy (`errors`, `*Refusal`) is
 * read after something went wrong and searched for never. Generic verbs
 * (`common`: «Сохранить», «Отмена», «Удалить») appear on every page at once,
 * and a query that matches everything has told the operator nothing.
 *
 * `adminNav` is here for a different reason: page names already enter the
 * index through the nav rows themselves, and indexing them twice would show
 * every page twice.
 */
export const IGNORED_NAMESPACES: ReadonlySet<string> = new Set([
  'adminNav',
  'adminShell',
  'auth',
  'authProvider',
  'common',
  'copyableId',
  'emojiPicker',
  'errorBoundary',
  'errors',
  'exportDropdown',
  'forcePasswordChangePage',
  'iconPicker',
  'mediaViewer',
  'nav',
  'notFoundPage',
  'offlineBanner',
  'planWriteRefusal',
  'quickSearchOverlay',
  'realtime',
  'savedFiltersBar',
  'screen',
  'sections',
  'shell',
  'signInPage',
  'statsFilter',
  'updateBanner',
  // Two dictionary entries whose KEY is an English sentence — a server
  // validation message pasted in as a key. They translate nothing and address
  // no page; see the note in `search-pages.test.ts`.
  'chatId must be a valid integer string',
  'threadId must be a valid integer string',
]);

/**
 * Labels for targets the sidebar does not name: hub tabs and the two settings
 * sub-pages. The nav index names everything else, including every
 * `deepLinkNavItems` anchor.
 *
 * `parentPath` is what supplies the icon, the permission gate and the "which
 * page is this on" line under the result, so it must always be a real nav row.
 */
interface ExtraTargetInterface {
  readonly labelKey: string;
  readonly parentPath: string;
}
const EXTRA_TARGETS: Readonly<Record<string, ExtraTargetInterface>> = {
  '/settings/panel#api-tokens': {
    labelKey: 'panelSettings.tabs.apiTokens',
    parentPath: '/settings/panel',
  },
  '/settings/panel#appearance': {
    labelKey: 'panelSettings.tabs.appearance',
    parentPath: '/settings/panel',
  },
  '/settings/panel#branding': {
    labelKey: 'panelSettings.tabs.branding',
    parentPath: '/settings/panel',
  },
  '/settings/panel#anti-fraud': {
    labelKey: 'panelSettings.tabs.antiFraud',
    parentPath: '/settings/panel',
  },
  '/payments#analytics': { labelKey: 'paymentsPage.tabs.analytics', parentPath: '/payments' },
  '/payments#webhooks': { labelKey: 'paymentsPage.tabs.webhooks', parentPath: '/payments' },
  '/partners#analytics': { labelKey: 'partnersPage.tabs.analytics', parentPath: '/partners' },
  '/automations#hints': { labelKey: 'automationsPage.tabs.hints', parentPath: '/automations' },
  '/settings/referral': { labelKey: 'referralSettingsPage.title', parentPath: '/settings' },
  '/settings/partner': { labelKey: 'partnerSettingsPage.title', parentPath: '/settings' },
};

interface NavIndexEntryInterface {
  readonly item: NavItem;
  readonly groupKey: string;
}

/**
 * Sidebar rows plus the routable-but-hidden ones, flattened.
 *
 * Both halves on purpose — the same reasoning as the overlay's own index: a
 * surface folded into somebody else's tab is reachable only by an operator who
 * already knows the URL, which is the definition of not findable.
 */
export const NAV_INDEX: ReadonlyArray<NavIndexEntryInterface> = [
  ...navGroups.flatMap((group) => group.items.map((item) => ({ item, groupKey: group.key }))),
  ...deepLinkNavItems.map(({ groupKey, ...item }) => ({ item, groupKey })),
];

const NAV_BY_PATH: ReadonlyMap<string, NavIndexEntryInterface> = new Map(
  NAV_INDEX.map((entry) => [entry.item.path, entry]),
);

export interface ResolvedTargetInterface {
  /** Full route, `#tab` included. */
  readonly path: string;
  /** The nav row that owns this surface: icon, permission, and the page name. */
  readonly nav: NavItem;
  readonly groupKey: string;
  /** i18n key of the row's own name. */
  readonly labelKey: string;
  /**
   * i18n key of the page this surface sits on, when the row is a tab of a
   * bigger page. `null` when the row IS the page.
   */
  readonly parentLabelKey: string | null;
}

/** Cache: the same handful of paths resolve on every keystroke. */
const resolvedTargets = new Map<string, ResolvedTargetInterface | null>();

/**
 * Route → everything the overlay needs to draw and gate a row.
 *
 * Returns `null` for a path that names no nav row. That is a mapping bug, not
 * a runtime condition: `search-pages.test.ts` asserts every target resolves,
 * and the engine drops unresolved entries rather than rendering a row that
 * cannot say where it leads.
 */
export function resolveSearchTarget(path: string): ResolvedTargetInterface | null {
  const cached = resolvedTargets.get(path);
  if (cached !== undefined) return cached;

  const resolved = ((): ResolvedTargetInterface | null => {
    const direct = NAV_BY_PATH.get(path);
    if (direct) {
      return {
        path,
        nav: direct.item,
        groupKey: direct.groupKey,
        labelKey: `adminNav.items.${direct.item.key}`,
        parentLabelKey: null,
      };
    }
    const extra = EXTRA_TARGETS[path];
    if (extra) {
      const parent = NAV_BY_PATH.get(extra.parentPath);
      if (!parent) return null;
      return {
        path,
        nav: parent.item,
        groupKey: parent.groupKey,
        labelKey: extra.labelKey,
        parentLabelKey: `adminNav.items.${parent.item.key}`,
      };
    }
    // A `#tab` nobody named: fall back to the page it belongs to rather than
    // dropping the row — landing on the right page is still an answer.
    const hashAt = path.indexOf('#');
    if (hashAt > 0) {
      const parent = NAV_BY_PATH.get(path.slice(0, hashAt));
      if (parent) {
        return {
          path,
          nav: parent.item,
          groupKey: parent.groupKey,
          labelKey: `adminNav.items.${parent.item.key}`,
          parentLabelKey: null,
        };
      }
    }
    return null;
  })();

  resolvedTargets.set(path, resolved);
  return resolved;
}

/**
 * The route a dictionary key's text lives on, by longest matching prefix.
 *
 * Matching is on dot boundaries so `settings` cannot claim `settingsPage`,
 * which is a different page with a similar name — the kind of collision that
 * would send an operator to the wrong screen and look like a search that
 * "finds the wrong thing".
 */
export function targetPathForKey(key: string): string | null {
  const namespace = key.split('.')[0] ?? '';
  if (IGNORED_NAMESPACES.has(namespace)) return null;
  let bestPath: string | null = null;
  let bestLength = 0;
  for (const [prefix, path] of Object.entries(SEARCH_KEY_TARGETS)) {
    if (prefix.length <= bestLength) continue;
    if (key !== prefix && !key.startsWith(`${prefix}.`)) continue;
    bestPath = path;
    bestLength = prefix.length;
  }
  return bestPath === null ? null : withTabAnchor(key, bestPath);
}

const TAB_KEY_PATTERN = /(?:^|\.)tabs\.([A-Za-z0-9_]+)$/;
const hubTabs = HUB_TABS as Record<string, ReadonlyArray<string> | undefined>;

/** `blockedIdentities` → `blocked-identities`: key spelling → hash spelling. */
function kebabCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

/**
 * Sends `<page>.tabs.<name>` to the tab itself rather than to the page.
 *
 * A tab NAME is the one string an operator is most likely to remember and
 * search for, and landing them on the page's default tab after they typed the
 * name of a different one is the failure this whole change is about. The
 * rewrite only fires when the page really accepts that hash — `HUB_TABS` is
 * the list the page feeds to `useTabSync` — so a renamed tab stops being
 * deep-linked instead of silently pointing at a hash nothing reads.
 */
function withTabAnchor(key: string, path: string): string {
  const match = TAB_KEY_PATTERN.exec(key);
  if (!match) return path;
  const base = path.split('#')[0] ?? path;
  const candidate = kebabCase(match[1] ?? '');
  return hubTabs[base]?.includes(candidate) === true ? `${base}#${candidate}` : path;
}
