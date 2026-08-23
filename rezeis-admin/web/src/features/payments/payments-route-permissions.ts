/**
 * The permission each Payments route ACTUALLY demands.
 * ────────────────────────────────────────────────────
 * The Payments page renders three tabs behind one gate — `payments:view`, the
 * page-level `<PermissionGate>` in `payments-page.tsx` — but the tabs call
 * routes guarded by three different tokens. Two of the three disagreed with
 * the gate, and disagreed silently:
 *
 *   • Webhooks  → `GET /admin/payments/webhooks/events` needs
 *     `payment_webhooks:view`. An admin holding only `payments:view` reached
 *     the tab, the request 403'd, `data` stayed `undefined`, and
 *     `(data ?? []).map(…)` rendered a table with a header and no body. The
 *     operator could not tell "no webhook events" from "not allowed to look".
 *
 *   • Analytics → `GET /admin/analytics/payments/{providers,webhooks}` need
 *     `analytics:view`. Same gate, and the 403 landed in the sections'
 *     `isError` branch, which says "could not load the report" — a transient
 *     failure message for a permanent refusal. The operator retries forever.
 *
 * Only Transactions matched, and it matched by coincidence: its route happens
 * to require the same `payments:view` the page gate already checks.
 *
 * WHY A TABLE AND NOT THREE INLINE STRINGS.
 * The gate and the route requirement are declared in two repositories that
 * cannot import each other, so they drift, and the drift is invisible until
 * an operator with a narrow role opens the page. This module is the SPA's
 * single copy of that mapping: the same entry feeds the `enabled:` flag on the
 * query, the refusal the operator reads, and the token that refusal names. It
 * cannot say "ask for X" while checking Y, and grepping this file against the
 * controllers is a two-minute audit instead of a page-wide read.
 *
 * Verified against the backend on 2026-08-21 (backend is read-only here):
 *   admin-payment-transactions.controller.ts:30    payments / view
 *   admin-payment-webhooks.controller.ts:30        payment_webhooks / view
 *   admin-payment-webhooks.controller.ts:59        payment_webhooks / run
 *   admin-payment-reconciliation.controller.ts:17  payments / view
 *   admin-payment-analytics.controller.ts:27,40    analytics / view
 *   admin-payment-gateways.controller.ts:42        payment_gateways / view
 *
 * These are UX hints, exactly as `<PermissionGate>` is. `RbacGuard` remains
 * the authority; the point is that the panel should stop pretending it does
 * not know the answer in advance.
 */
import { useHasPermission, type RbacAction } from '@/features/rbac'

export interface RoutePermission {
  readonly resource: string
  readonly action: RbacAction
  /**
   * `resource:action` — the exact string an operator quotes to whoever
   * administers roles. Derived, never hand-written, so the refusal copy can
   * never name a token different from the one that was checked.
   */
  readonly token: string
}

function routePermission(resource: string, action: RbacAction): RoutePermission {
  return { resource, action, token: `${resource}:${action}` }
}

export const paymentsRoutePermissions = {
  /** `GET /admin/payments/transactions` */
  transactions: routePermission('payments', 'view'),
  /** `GET /admin/payments/webhooks/events` */
  webhookEvents: routePermission('payment_webhooks', 'view'),
  /** `GET /admin/payments/reconciliation/health` */
  reconciliationHealth: routePermission('payments', 'view'),
  /** `POST /admin/payments/webhooks/events/:eventId/replay` */
  webhookReplay: routePermission('payment_webhooks', 'run'),
  /** `GET /admin/analytics/payments/providers` and `…/webhooks` */
  paymentAnalytics: routePermission('analytics', 'view'),
} as const

/**
 * True when the current admin may call the route this permission describes.
 *
 * Pass the result to the query's `enabled:` as well as to the refusal branch.
 * Firing a request the panel already knows will 403 buys nothing and writes a
 * denial into the server's audit trail every time the tab is opened.
 */
export function useRouteAccess(permission: RoutePermission): boolean {
  return useHasPermission(permission.resource, permission.action)
}
