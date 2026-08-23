/**
 * Query keys for the payment-ops surfaces (reconciliation health, webhook
 * events), shared by the reader that fetches them and the mutation that
 * invalidates them.
 *
 * They live in their own module rather than being exported from a component
 * file (which trips `react-refresh/only-export-components`) or added to
 * `lib/admin-query-keys.ts` (which nothing else in this feature needs).
 *
 * Every key stays under the `['admin', 'payments', …]` prefix that
 * `adminQueryKeys.payments.all` names, so the realtime invalidation that
 * already exists for payments keeps reaching them.
 */
export const reconciliationHealthQueryKey = [
  'admin',
  'payments',
  'reconciliation',
  'health',
] as const
