/**
 * «Подписки» → «Инструменты»: which tabs exist, who may see each, and how a
 * link opens one.
 *
 * Pure on purpose — no React, no i18n — so the three decisions that can go
 * wrong silently are each one function a test can call directly:
 *
 *  • WHO SEES A TAB. Each tab keeps the permission its own endpoint demands.
 *    Four of them edit subscriptions (`subscriptions:edit`); the squads report
 *    reads plans (`plans:view`). A tab shown without its permission is a tab
 *    whose every request answers 403, which reads as "the tool is broken".
 *  • WHETHER THE BUTTON EXISTS. Hidden when the admin may see no tab at all:
 *    a sheet with nothing in it is a dead end.
 *  • WHICH TAB A LINK OPENS. `/subscriptions?tools=<tab>` is written by other
 *    screens (the user card's delete refusal) and pasted by operators. A value
 *    this build does not know, or a tab the admin may not see, opens the FIRST
 *    tab they may see — never an empty sheet, never a tab that 403s.
 */
import type { RbacAction } from '@/features/rbac'

/** The query parameter that opens the sheet, and its value the tab. */
export const SUBSCRIPTION_TOOLS_PARAM = 'tools'

/**
 * The tabs, in the order the sheet shows them. The values are the deep-link
 * vocabulary — `/subscriptions?tools=unlinked` — so renaming one breaks every
 * link another screen has written.
 */
export const SUBSCRIPTION_TOOL_TABS = [
  'merge',
  'squads',
  'unlinked',
  'extraProfiles',
  'lifetime',
] as const

export type SubscriptionToolTab = (typeof SUBSCRIPTION_TOOL_TABS)[number]

export interface ToolPermission {
  readonly resource: string
  readonly action: RbacAction
}

/** Each tab's own permission: the one its endpoint's guard demands. */
export const SUBSCRIPTION_TOOL_PERMISSIONS: Readonly<Record<SubscriptionToolTab, ToolPermission>> = {
  merge: { resource: 'subscriptions', action: 'edit' },
  squads: { resource: 'plans', action: 'view' },
  unlinked: { resource: 'subscriptions', action: 'edit' },
  extraProfiles: { resource: 'subscriptions', action: 'edit' },
  lifetime: { resource: 'subscriptions', action: 'edit' },
}

/** The tabs this admin may see, in sheet order. Empty means: no button. */
export function allowedToolTabs(
  holds: (resource: string, action: RbacAction) => boolean,
): SubscriptionToolTab[] {
  return SUBSCRIPTION_TOOL_TABS.filter((tab) => {
    const permission = SUBSCRIPTION_TOOL_PERMISSIONS[tab]
    return holds(permission.resource, permission.action)
  })
}

function isToolTab(value: string): value is SubscriptionToolTab {
  return (SUBSCRIPTION_TOOL_TABS as readonly string[]).includes(value)
}

/**
 * The tab a `?tools=` value opens, or `null` when the admin may see none.
 *
 * `requested` is whatever the address says — possibly nothing, possibly a
 * word from a newer or older build, possibly a tab this admin may not open.
 * Only a known tab that is also ALLOWED is honoured; everything else falls to
 * the first allowed tab.
 */
export function resolveToolTab(
  requested: string | null,
  allowed: readonly SubscriptionToolTab[],
): SubscriptionToolTab | null {
  if (requested !== null && isToolTab(requested) && allowed.includes(requested)) return requested
  return allowed[0] ?? null
}

/** The address that opens the sheet on `tab`. */
export function subscriptionToolsHref(tab: SubscriptionToolTab): string {
  return `/subscriptions?${SUBSCRIPTION_TOOLS_PARAM}=${tab}`
}
