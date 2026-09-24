/**
 * HOW A «НАЗНАЧИТЬ ПЛАН» REFUSAL IS RECOGNISED — the code, and nothing else.
 *
 * `PATCH /admin/users/subscriptions/:subscriptionId` with a `planId` answers
 * HTTP 409 with `code: 'PLAN_ASSIGNMENT_BLOCKED_BY_QUEUED_RENEWAL'` when a paid
 * renewal period is queued with add-ons bought for it: moving the subscription
 * onto the plan now would cancel that paid period, so nothing was changed.
 * The body also carries an English sentence — a diagnostic, and what an older
 * build prints — and the operator used to read exactly that.
 *
 * Branch on the code, never on the sentence (`subscription-delete-refusals.ts`
 * has why). The literal is hand-written rather than imported from
 * `src/modules/users/controllers/plan-assignment-refusals.ts`: nothing the
 * production frontend compiles may reach into the backend tree
 * (`build-isolation.test.ts`). The link is held from the test side —
 * `plan-assignment-refusal.test.tsx` imports the backend's code and fails by
 * name if the two part.
 */

/** The one «Назначить план» refusal this build gives its own words to. */
export type PlanAssignmentRefusal = 'queuedRenewal'

/**
 * Mirrors `PLAN_ASSIGNMENT_REFUSAL_CODES.queuedRenewalWithAddOns`. Allowlisted
 * in `SAFE_PRODUCT_CODES`, so the safe exception filter lets it through as both
 * `code` and `errorCode`.
 */
export const PLAN_ASSIGNMENT_BLOCKED_BY_QUEUED_RENEWAL_CODE = 'PLAN_ASSIGNMENT_BLOCKED_BY_QUEUED_RENEWAL'

const REFUSAL_BY_CODE = new Map<string, PlanAssignmentRefusal>([
  [PLAN_ASSIGNMENT_BLOCKED_BY_QUEUED_RENEWAL_CODE, 'queuedRenewal'],
])

/** The product code off an axios-shaped rejection — `code` first, then `errorCode` — or `null`. */
function readProductCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null
  const body = (error as { response?: { data?: unknown } }).response?.data
  if (typeof body !== 'object' || body === null) return null
  const record = body as { code?: unknown; errorCode?: unknown }
  if (typeof record.code === 'string' && record.code.length > 0) return record.code
  if (typeof record.errorCode === 'string' && record.errorCode.length > 0) return record.errorCode
  return null
}

/**
 * Which refusal a failed plan assignment is, or `null` for anything this build
 * does not recognise — which keeps the generic path: the server's own words,
 * or «Не удалось назначить план».
 */
export function readPlanAssignmentRefusal(error: unknown): PlanAssignmentRefusal | null {
  const code = readProductCode(error)
  if (code === null) return null
  return REFUSAL_BY_CODE.get(code) ?? null
}
