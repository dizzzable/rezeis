/**
 * Authoritative source of every (resource, action) pair the admin panel
 * understands. The RBAC service refuses to persist a permission that does
 * not appear here, and the frontend's role editor consumes this list via
 * `GET /admin/rbac/resources`.
 *
 * Adding a new resource
 * ─────────────────────
 *   1. Append it here.
 *   2. Add `@RequirePermission('newResource', 'view')` (or whatever
 *      action) to the relevant controllers.
 *   3. Run the seed script — `superadmin` system role auto-receives the
 *      new entries on the next backend boot.
 *
 * Removing a resource is intentionally NOT exposed: the database stores
 * granted permissions and removal would silently revoke access. Mark a
 * resource as legacy in comments and stop guarding new endpoints with it.
 */

export const RBAC_ACTIONS = [
  'view',
  'create',
  'edit',
  'delete',
  'bulk_operations',
  'resolve',
  'run',
  'export',
  /// Phase 8 — separate from `create` because import-style writes can
  /// touch many rows and are higher-risk (a misconfigured payload can
  /// overwrite live operator settings).
  'import',
  /// Anonymous support — reading CLOSED (archived) conversations and their
  /// attachments. Separated from `view` so archived (often identity-bearing)
  /// guest threads can be restricted to a subset of agents.
  'archive',
  /// Anti-fraud — dropping a flagged user's live connections via Remnawave
  /// `ip-control`. Separated from `resolve` because it is a destructive,
  /// session-killing action distinct from triaging the signal row.
  'enforce',
  /// Advertising cabinet — approving / countering / rejecting partner-submitted
  /// advertising requests. Separated from `edit` because it gates the partner
  /// moderation queue specifically.
  'moderate',
  /// Account consolidation — merging two `User` accounts into one
  /// (irreversible: moves subscriptions/transactions, sums partner balances).
  /// Separated from `edit` because of its destructive, cross-account blast
  /// radius.
  'merge',
  /// User registration telemetry (IP / UA / Referer / UTM) on the Analytics
  /// tab. Separated from `view` so PII can be granted via custom roles without
  /// opening full user edit rights.
  'view_registration',
  /// Bulk raw registration PII export (CSV). Elevated vs `view_registration`
  /// because exports are high-blast-radius (full IP/UA/Referer/UTM dumps).
  'export_registration',
] as const;

export type RbacAction = (typeof RBAC_ACTIONS)[number];

/**
 * Resource catalog. Keys are stable identifiers used in `@RequirePermission`
 * decorators; values are the actions a role can hold for that resource.
 *
 * Naming convention: lower_snake_case for compound names (`api_keys`,
 * `payment_gateways`), single noun otherwise.
 */
export const RBAC_RESOURCES: Readonly<Record<string, readonly RbacAction[]>> = {
  // Operations
  dashboard: ['view'],
  users: [
    'view',
    'create',
    'edit',
    'delete',
    'bulk_operations',
    'merge',
    'view_registration',
    'export_registration',
  ],
  subscriptions: ['view', 'create', 'edit', 'delete'],
  payments: ['view', 'create', 'edit', 'delete', 'export'],
  payment_gateways: ['view', 'edit'],
  payment_webhooks: ['view', 'resolve', 'run'],
  support_tickets: ['view', 'create', 'edit', 'delete', 'resolve', 'archive'],
  analytics: ['view', 'export'],
  /// Auto-renewal pipeline operator surface: `view` reads the last cron
  /// tick/schedule, `run` triggers an out-of-band cycle.
  auto_renew: ['view', 'run'],

  // Catalog
  plans: ['view', 'create', 'edit', 'delete'],
  promocodes: ['view', 'create', 'edit', 'delete'],
  broadcasts: ['view', 'create', 'edit', 'delete', 'run'],
  /// Paid add-ons (extra traffic / devices) catalog CRUD.
  add_ons: ['view', 'create', 'edit', 'delete'],
  /// Durable add-on entitlement remediation surface (T-013). Separate,
  /// least-privilege actions over the ledger/projection/device saga:
  ///   view    — inspect ledger, projection, incidents, delivery metrics;
  ///   run     — retry a stalled profile-sync push;
  ///   resolve — force reconcile / acknowledge an incident;
  ///   enforce — schedule a compensating reversal / waiver (money-affecting);
  ///   moderate— approve a BLOCKED device-reduction plan (destructive HWID).
  /// NOT granted to any default non-superadmin role — high-risk money/
  /// destructive surface; operators receive it only via a custom role.
  add_on_entitlements: ['view', 'run', 'resolve', 'enforce', 'moderate'],
  /// Operator-managed FAQ entries (+ media uploads).
  faq: ['view', 'create', 'edit', 'delete'],

  // Growth
  referrals: ['view', 'edit'],
  referral_settings: ['view', 'edit'],
  partners: ['view', 'edit', 'bulk_operations'],
  partner_settings: ['view', 'edit'],
  withdrawals: ['view', 'resolve'],
  /// Gamification quests catalog + settings (reward-granting tasks).
  quests: ['view', 'create', 'edit', 'delete'],

  // Configuration
  settings: ['view', 'edit'],
  bot_config: ['view', 'edit'],
  remnawave: ['view', 'edit'],
  notifications: ['view', 'edit'],
  /// Subscription-page config (branding / app catalog / baseSettings /
  /// translations) consumed by rezeis-subpage.
  subpage_config: ['view', 'edit'],
  /// Web landing-page builder — the operator-authored marketing page shown to
  /// unauthenticated web visitors before sign-in (consumed by reiwa). `edit`
  /// covers save-draft, publish and rollback.
  landing_config: ['view', 'edit'],
  /// SMTP email settings + connection test / test-send.
  email: ['view', 'edit'],

  // System
  admins: ['view', 'create', 'edit', 'delete'],
  rbac_roles: ['view', 'create', 'edit', 'delete'],
  api_tokens: ['view', 'create', 'delete'],
  auth_providers: ['view', 'edit'],
  external_auth: ['view', 'edit'],
  appearance: ['view', 'edit'],
  branding: ['view', 'edit'],
  backups: ['view', 'create', 'delete', 'run'],
  // `create` is legacy-valid for persisted/custom roles. New file/live import
  // endpoints use the stricter `import` action below.
  imports: ['view', 'create', 'import', 'run'],
  audit: ['view', 'export'],
  blocked_ips: ['view', 'create', 'delete'],

  // Realtime / events (future fraud signals + automations)
  fraud_signals: ['view', 'resolve', 'enforce'],
  automations: ['view', 'create', 'edit', 'delete', 'run'],
  /// Advertising cabinet — campaigns/placements CRUD (`view`/`create`/`edit`,
  /// `delete` archives when used) and partner-request moderation (`moderate`).
  advertising: ['view', 'create', 'edit', 'delete', 'moderate'],
  /// Phase 6 — outgoing webhook subscriptions and their delivery history.
  /// `view` covers reading subscriptions + deliveries; `edit` includes
  /// updating, regenerating secrets, testing, and replaying a delivery;
  /// `delete` is a separate action because the cascade drops history.
  webhooks: ['view', 'create', 'edit', 'delete'],
  /// Phase 8 — configuration export/import.
  /// `view` lists the available sections; `export` returns the JSON
  /// payload (which contains webhook secrets — restrict carefully);
  /// `import` applies a payload with a strategy + dry-run flag.
  config_portability: ['view', 'export', 'import'],
  /// Phase 8 — in-memory log viewer + runtime log-level control.
  /// `view` reads from the ring buffer; `edit` changes the floor level;
  /// `delete` clears the buffer.
  system_logs: ['view', 'edit', 'delete'],
} as const;

export type RbacResource = keyof typeof RBAC_RESOURCES;

/**
 * Returns the full set of (resource, action) pairs as a flat list. Useful
 * for seeding the `superadmin` role and validating role mutations.
 */
export function getAllPermissions(): ReadonlyArray<{ resource: string; action: RbacAction }> {
  const result: Array<{ resource: string; action: RbacAction }> = [];
  for (const [resource, actions] of Object.entries(RBAC_RESOURCES)) {
    for (const action of actions) {
      result.push({ resource, action });
    }
  }
  return result;
}

/**
 * Validates a (resource, action) pair against the catalog.
 * Returns `false` for unknown resources or actions not declared on the
 * resource.
 */
export function isValidPermission(resource: string, action: string): boolean {
  const actions = (RBAC_RESOURCES as Record<string, readonly RbacAction[] | undefined>)[resource];
  if (!actions) return false;
  return (actions as readonly string[]).includes(action);
}

/**
 * System roles provisioned automatically on startup. The seed service is
 * idempotent: it only inserts missing roles / permissions and never
 * deletes operator-tweaked rows.
 */
export interface SystemRoleSeed {
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  readonly permissions: ReadonlyArray<{ resource: string; action: RbacAction }>;
}

export const SYSTEM_ROLES: readonly SystemRoleSeed[] = [
  {
    name: 'superadmin',
    displayName: 'Superadmin',
    description: 'Полный доступ ко всем разделам панели.',
    // `permissions` is filled at runtime from `getAllPermissions()` so the
    // role automatically picks up new resources without a manual edit.
    permissions: [],
  },
  {
    name: 'operator',
    displayName: 'Operator',
    description: 'Повседневные операции: пользователи, подписки, платежи, поддержка, рассылки.',
    permissions: [
      { resource: 'dashboard', action: 'view' },
      { resource: 'users', action: 'view' },
      { resource: 'users', action: 'view_registration' },
      { resource: 'users', action: 'edit' },
      { resource: 'users', action: 'create' },
      { resource: 'users', action: 'bulk_operations' },
      { resource: 'subscriptions', action: 'view' },
      { resource: 'subscriptions', action: 'edit' },
      { resource: 'subscriptions', action: 'create' },
      { resource: 'payments', action: 'view' },
      { resource: 'payments', action: 'export' },
      { resource: 'payment_webhooks', action: 'view' },
      { resource: 'payment_webhooks', action: 'resolve' },
      { resource: 'plans', action: 'view' },
      { resource: 'promocodes', action: 'view' },
      { resource: 'promocodes', action: 'create' },
      { resource: 'promocodes', action: 'edit' },
      { resource: 'broadcasts', action: 'view' },
      { resource: 'broadcasts', action: 'create' },
      { resource: 'broadcasts', action: 'edit' },
      { resource: 'broadcasts', action: 'run' },
      { resource: 'add_ons', action: 'view' },
      { resource: 'faq', action: 'view' },
      { resource: 'faq', action: 'edit' },
      { resource: 'auto_renew', action: 'view' },
      { resource: 'support_tickets', action: 'view' },
      { resource: 'support_tickets', action: 'edit' },
      { resource: 'support_tickets', action: 'resolve' },
      { resource: 'support_tickets', action: 'archive' },
      { resource: 'referrals', action: 'view' },
      { resource: 'partners', action: 'view' },
      { resource: 'quests', action: 'view' },
      { resource: 'quests', action: 'create' },
      { resource: 'quests', action: 'edit' },
      { resource: 'withdrawals', action: 'view' },
      { resource: 'analytics', action: 'view' },
      { resource: 'audit', action: 'view' },
      { resource: 'fraud_signals', action: 'view' },
    ],
  },
  {
    name: 'support',
    displayName: 'Support',
    description: 'Только просмотр и работа с тикетами / поиск пользователей.',
    permissions: [
      { resource: 'dashboard', action: 'view' },
      { resource: 'users', action: 'view' },
      { resource: 'users', action: 'view_registration' },
      { resource: 'subscriptions', action: 'view' },
      { resource: 'payments', action: 'view' },
      { resource: 'support_tickets', action: 'view' },
      { resource: 'support_tickets', action: 'edit' },
      { resource: 'support_tickets', action: 'resolve' },
      { resource: 'support_tickets', action: 'archive' },
      { resource: 'referrals', action: 'view' },
      { resource: 'analytics', action: 'view' },
    ],
  },
  {
    name: 'finance',
    displayName: 'Finance',
    description: 'Платежи, выводы, тарифы и финансовая аналитика.',
    permissions: [
      { resource: 'dashboard', action: 'view' },
      { resource: 'payments', action: 'view' },
      { resource: 'payments', action: 'edit' },
      { resource: 'payments', action: 'export' },
      { resource: 'payment_gateways', action: 'view' },
      { resource: 'payment_gateways', action: 'edit' },
      { resource: 'payment_webhooks', action: 'view' },
      { resource: 'payment_webhooks', action: 'resolve' },
      { resource: 'payment_webhooks', action: 'run' },
      { resource: 'plans', action: 'view' },
      { resource: 'plans', action: 'create' },
      { resource: 'plans', action: 'edit' },
      { resource: 'partners', action: 'view' },
      { resource: 'withdrawals', action: 'view' },
      { resource: 'withdrawals', action: 'resolve' },
      { resource: 'analytics', action: 'view' },
      { resource: 'analytics', action: 'export' },
      { resource: 'audit', action: 'view' },
    ],
  },
] as const;
