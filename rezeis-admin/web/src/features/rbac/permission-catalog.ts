/**
 * How the role editor arranges and flags the permission catalog.
 *
 * The catalog itself — which resources exist and which actions each offers —
 * is the server's (`GET /admin/rbac/resources`, from `RBAC_RESOURCES` in
 * `src/modules/rbac/rbac.resources.ts`). What the server does not carry is
 * everything an owner needs to tick a box knowingly: which area of the panel a
 * resource belongs to, what it is called in plain words, and whether handing
 * it out can lock people out, expose secrets or move money. The words live in
 * the dictionaries under `rolesPage.resources` / `rolesPage.actions`; the
 * arrangement and the warnings live here.
 *
 * `permission-catalog.test.ts` holds all three against the backend catalog in
 * both directions: a resource the server gained without a group, a name or a
 * description fails it by name, and so does an entry here that names a
 * resource or action the server no longer has.
 */
import type { RbacAction } from './rbac-types'

/**
 * The areas of the panel, in the order the matrix shows them. Derived from the
 * backend catalog's own section comments and regrouped by what an owner is
 * looking for — "who can touch money", "who can touch access" — rather than by
 * where the code happens to live.
 */
export const PERMISSION_GROUPS = [
  { id: 'overview', resources: ['dashboard', 'analytics'] },
  { id: 'customers', resources: ['users', 'blocked_identities', 'fraud_signals'] },
  {
    id: 'subscriptions',
    resources: ['subscriptions', 'plans', 'add_ons', 'add_on_entitlements', 'auto_renew'],
  },
  { id: 'payments', resources: ['payments', 'payment_gateways', 'payment_webhooks'] },
  { id: 'support', resources: ['support_tickets', 'faq', 'user_hints'] },
  {
    id: 'marketing',
    resources: [
      'promocodes',
      'broadcasts',
      'referrals',
      'referral_settings',
      'partners',
      'partner_settings',
      'withdrawals',
      'quests',
      'wheel',
      'advertising',
    ],
  },
  {
    id: 'content',
    resources: ['bot_config', 'notifications', 'subpage_config', 'landing_config', 'branding', 'appearance'],
  },
  { id: 'remnawave', resources: ['remnawave', 'imports'] },
  { id: 'integrations', resources: ['automations', 'webhooks', 'email', 'api_tokens'] },
  {
    id: 'access',
    resources: ['admins', 'rbac_roles', 'auth_providers', 'external_auth', 'blocked_ips', 'audit'],
  },
  { id: 'system', resources: ['settings', 'backups', 'config_portability', 'system_logs'] },
] as const satisfies ReadonlyArray<{ readonly id: string; readonly resources: readonly string[] }>

export type PermissionGroupId = (typeof PERMISSION_GROUPS)[number]['id']

/**
 * Where a resource the panel has no group for is shown: at the end, under its
 * raw key. Only reachable when the server is newer than this bundle — the
 * catalog test keeps the two in step for every build shipped from this tree.
 */
export const OTHER_GROUP_ID = 'other'

/**
 * Permissions that carry a visible warning in the matrix, each with a one-line
 * reason under `rolesPage.resources.<resource>.danger.<action>`.
 *
 * ── The rule ─────────────────────────────────────────────────────────────────
 *
 * A permission is dangerous when a single use of it can do one of these:
 *
 *   MONEY    move real money, or a balance that can be withdrawn as money:
 *            refunds, partner balances and their payouts, the credentials
 *            customers pay through, reversing a purchase with compensation.
 *            Points, free days and discounts are not money: they are only ever
 *            spent inside the service.
 *   LOSS     destroy, with no way back, a customer account, a subscription a
 *            customer paid for, or data in bulk (the database, its backups,
 *            every customer an import brought in).
 *   ACCESS   shut people out wholesale: admins from the panel (accounts, roles,
 *            sign-in methods, IP lists, API tokens), customers from the cabinet
 *            or a server, everyone from sign-up or purchases.
 *   SECRETS  hand over, or redirect, what must stay private: keys and tokens,
 *            the channels secrets travel through (mail server, webhooks, backup
 *            delivery), or everyone's personal data in one file.
 *
 * What does NOT earn a warning is spelled out so the rule is not re-argued box
 * by box: acting on ONE customer as support does every day (blocking them,
 * disabling a subscription, resetting a password — each reversible), handing
 * out points, days or discounts, and running by hand what a schedule already
 * runs (`auto_renew:run` charges exactly whom the next tick would). A warning
 * on every other box teaches the reader to ignore all of them.
 *
 * What earns a place is what the code guarding the permission does, not how
 * the action is named: `backups:create` because the route that takes a dump
 * also rewrites the Telegram chat dumps are delivered to
 * (`admin-backup.controller.ts`); `partners:view` because the withdrawal list
 * and its CSV carry every payout's requisites (`partner-csv-export.service.ts`);
 * `automations:create`/`edit`/`run` because a rule's `block_ip` and
 * `webhook_post` actions (`automations/actions/action-registry.ts`) write the
 * IP blocklist and call any URL without asking for `blocked_ips` or `webhooks`,
 * and a manual run chooses the address a rule without one blocks.
 *
 * `permission-catalog.test.ts` pins the whole list, so adding or dropping a
 * warning is a decision somebody makes on purpose.
 */
export const DANGEROUS_PERMISSIONS: Readonly<Record<string, readonly RbacAction[]>> = {
  users: ['delete', 'merge', 'export', 'export_registration'],
  subscriptions: ['delete'],
  add_on_entitlements: ['enforce'],
  payments: ['refund'],
  payment_gateways: ['view_secrets', 'edit'],
  partners: ['view', 'edit'],
  withdrawals: ['resolve'],
  wheel: ['view_secrets'],
  remnawave: ['edit'],
  imports: ['run'],
  automations: ['create', 'edit', 'run'],
  webhooks: ['create', 'edit'],
  email: ['edit'],
  api_tokens: ['create', 'delete'],
  admins: ['create', 'edit', 'delete'],
  rbac_roles: ['create', 'edit'],
  auth_providers: ['edit'],
  external_auth: ['edit'],
  blocked_ips: ['create'],
  settings: ['edit'],
  backups: ['create', 'delete', 'run', 'export'],
  config_portability: ['export', 'import'],
}

/**
 * Permissions nothing checks: no route, no in-handler check, no notification
 * or realtime gate, and no screen of the panel. Their line in the dictionary
 * says so ("Has no effect yet" / «Пока ни на что не влияет»), and
 * `permission-catalog.test.ts` scans both the backend and this SPA for any use
 * of them — the day one of them starts guarding something, that sentence turns
 * false and the test says which.
 */
export const INERT_PERMISSIONS: Readonly<Record<string, readonly RbacAction[]>> = {
  payments: ['edit', 'delete', 'export'],
  analytics: ['export'],
  referral_settings: ['edit'],
  partners: ['bulk_operations'],
  partner_settings: ['view', 'edit'],
  appearance: ['view', 'edit'],
  branding: ['view', 'edit'],
  imports: ['create'],
}

export function isDangerousPermission(resource: string, action: string): boolean {
  const actions = Object.hasOwn(DANGEROUS_PERMISSIONS, resource) ? DANGEROUS_PERMISSIONS[resource] : undefined
  return actions !== undefined && (actions as readonly string[]).includes(action)
}

export interface CatalogGroup {
  readonly id: PermissionGroupId | typeof OTHER_GROUP_ID
  /** `[resource, actions it offers]`, in the group's own order. */
  readonly resources: ReadonlyArray<readonly [string, readonly RbacAction[]]>
}

/**
 * The server's catalog arranged into {@link PERMISSION_GROUPS}.
 *
 * Only resources the server actually offers are shown: a grouped resource the
 * server does not list is skipped rather than drawn as a row nobody can tick.
 * A resource no group names goes to a trailing "other" group instead of being
 * dropped — a permission that exists must stay grantable even when this
 * bundle does not know what to call it. Empty groups are left out.
 */
export function groupCatalog(
  resources: Readonly<Record<string, readonly RbacAction[]>>,
): readonly CatalogGroup[] {
  const placed = new Set<string>()
  const groups: CatalogGroup[] = []
  for (const group of PERMISSION_GROUPS) {
    const rows: Array<readonly [string, readonly RbacAction[]]> = []
    for (const resource of group.resources) {
      if (!Object.hasOwn(resources, resource)) continue
      rows.push([resource, resources[resource]])
      placed.add(resource)
    }
    if (rows.length > 0) groups.push({ id: group.id, resources: rows })
  }
  const unplaced = Object.entries(resources).filter(([resource]) => !placed.has(resource))
  if (unplaced.length > 0) groups.push({ id: OTHER_GROUP_ID, resources: unplaced })
  return groups
}
