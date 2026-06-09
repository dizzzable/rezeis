/**
 * Canonical admin notification categories and their RBAC gating.
 *
 * A category is delivered to an admin only when the admin holds the gating
 * permission (role-controlled) AND has the category enabled in preferences
 * (default enabled). Shared by the dispatcher (delivery) and the preferences
 * service/controller (what's tunable per admin).
 */
export type AdminNotificationCategory =
  | 'support'
  | 'payment'
  | 'fraud'
  | 'withdrawal'
  | 'system';

export interface AdminNotificationCategoryDef {
  readonly category: AdminNotificationCategory;
  /** Existing RBAC permission that gates the category. */
  readonly resource: string;
  readonly action: string;
}

export const ADMIN_NOTIFICATION_CATEGORIES: readonly AdminNotificationCategoryDef[] = [
  { category: 'support', resource: 'support_tickets', action: 'view' },
  { category: 'payment', resource: 'payments', action: 'view' },
  { category: 'fraud', resource: 'fraud_signals', action: 'view' },
  { category: 'withdrawal', resource: 'withdrawals', action: 'view' },
  { category: 'system', resource: 'dashboard', action: 'view' },
];

const BY_CATEGORY: Readonly<Record<AdminNotificationCategory, AdminNotificationCategoryDef>> =
  Object.fromEntries(ADMIN_NOTIFICATION_CATEGORIES.map((c) => [c.category, c])) as Record<
    AdminNotificationCategory,
    AdminNotificationCategoryDef
  >;

export function getCategoryGate(category: AdminNotificationCategory): AdminNotificationCategoryDef {
  return BY_CATEGORY[category];
}

export function isAdminNotificationCategory(value: string): value is AdminNotificationCategory {
  return value in BY_CATEGORY;
}
