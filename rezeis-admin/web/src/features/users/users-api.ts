import { z } from 'zod'
import { api } from '@/lib/api'
import { unwrapPayloadOrArray } from '@/lib/api-utils'

/**
 * The admin SPA's client for the THREE user-scoped routes it actually calls.
 *
 * It used to export forty. The other thirty-seven were a second, unreached
 * client for block/unblock, role changes, the commercial profile, plan
 * assignment, status changes, limits, device revocation and moderation
 * history — none of them wired to a screen, and most of them addressed to
 * paths this backend has never declared: `/admin/users/subscriptions/selected/*`,
 * `:id/role`, `:id/commercial-profile`, `:id/moderation-history`,
 * `:id/support-message-drafts`, `:id/web-account-readiness`,
 * `/admin/users/device-provisioning-challenges`,
 * `/admin/users/access-diagnostics`, and `/admin/users/session/*` — that last
 * group being the CABINET's real `internal/user/session/*` routes copied under
 * the admin prefix, where nothing serves them.
 *
 * `users-api.test.ts` had pinned that surface, which is what made the wrong
 * contract read as a verified one. Its moderation spec asserted
 * `PATCH /admin/users/:id/block` carrying `{ reason }`, while the panel's live
 * control sends `POST /admin/users/:id/:action` with no body at all and the
 * backend declares `@Post(':telegramId/block')` / `@Post(':telegramId/unblock')`
 * (`admin-user-management.controller.ts`), whose handlers take the path
 * parameter and the admin — and never read a reason.
 *
 * Two more were dropped that DID name a live route, because neither could
 * have worked: `searchUser` sent `referralCode` to `GET /admin/users/search`
 * and `listUsers` sent `queue`/`cursor` to `GET /admin/users`, and neither
 * parameter is on the query DTO — under the global
 * `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })` in
 * `main.ts` both are a 400. The screen that really lists users calls
 * `GET /admin/users` inline with `search`/`limit` (`users-page.tsx`).
 *
 * So: what is here is what `user-detail-panel.tsx` imports, and nothing else.
 * Before adding a function, name the `@Controller('admin/users')` route it
 * targets AND the screen that calls it. A function with neither is the thing
 * that was just removed.
 */

const unwrapPayload = unwrapPayloadOrArray

const accountMergeSummarySchema = z.object({
  userId: z.string(),
  login: z.string().nullable(),
  telegramId: z.string().nullable(),
  email: z.string().nullable(),
  name: z.string(),
  isBlocked: z.boolean(),
  hasWebAccount: z.boolean(),
  hasTrialGrant: z.boolean(),
  subscriptions: z.object({ total: z.number(), active: z.number(), trial: z.number() }),
  transactionsCount: z.number(),
  partner: z.object({ isPartner: z.boolean(), balanceMinor: z.number() }),
  createdAt: z.string(),
})

const operationSubscriptionSchema = z.object({
  id: z.string(),
  label: z.string().nullable(),
}).nullable()

const userOperationSchema = z.discriminatedUnion('kind', [
  z.object({
    id: z.string(),
    kind: z.literal('PAYMENT'),
    occurredAt: z.string(),
    payload: z.object({
      paymentId: z.string().nullable(),
      status: z.string(),
      purchaseType: z.string().nullable(),
      gatewayType: z.string().nullable(),
      currency: z.string(),
      amount: z.string(),
    }),
  }),
  z.object({
    id: z.string(),
    kind: z.literal('PROMOCODE_ACTIVATION'),
    occurredAt: z.string(),
    payload: z.object({
      codeMasked: z.string(),
      rewardType: z.string(),
      rewardValue: z.number(),
      targetSubscription: operationSubscriptionSchema,
    }),
  }),
  z.object({
    id: z.string(),
    kind: z.literal('POINTS_EXCHANGE'),
    occurredAt: z.string(),
    payload: z.object({
      type: z.enum(['SUBSCRIPTION_DAYS', 'GIFT_SUBSCRIPTION', 'DISCOUNT', 'TRAFFIC']),
      pointsSpent: z.number(),
      rewardValue: z.number(),
      expiresAtBefore: z.string().nullable(),
      expiresAtAfter: z.string().nullable(),
      trafficLimitBefore: z.number().nullable(),
      trafficLimitAfter: z.number().nullable(),
      personalDiscountBefore: z.number().nullable(),
      personalDiscountAfter: z.number().nullable(),
      targetSubscription: operationSubscriptionSchema,
      sync: z.object({ status: z.string(), lastError: z.string().nullable() }).nullable(),
    }),
  }),
])

const userOperationsSchema = z.object({
  items: z.array(userOperationSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
})

const accountMergePreviewSchema = z.object({
  current: accountMergeSummarySchema,
  counterpart: accountMergeSummarySchema,
  conflicts: z.array(z.string()),
})

const accountMergeResultSchema = z.object({
  mergedUserId: z.string(),
  movedCounts: z.object({
    subscriptions: z.number(),
    transactions: z.number(),
    partnerTransactions: z.number(),
  }),
  remnawaveSubscriptionIds: z.array(z.string()),
})

export type AccountMergePreview = z.infer<typeof accountMergePreviewSchema>
export type AccountMergeResult = z.infer<typeof accountMergeResultSchema>
export type UserOperation = z.infer<typeof userOperationSchema>
export type UserOperations = z.infer<typeof userOperationsSchema>

export interface AccountMergeChoices {
  readonly keepLogin?: 'source' | 'target'
  readonly keepTelegram?: 'source' | 'target'
  readonly keepEmail?: 'source' | 'target'
  readonly currentSubscriptionId?: string
}

async function getAccountMergePreview(input: {
  readonly userId: string
  readonly ref: string
}): Promise<AccountMergePreview> {
  const response = await api.get(`/admin/users/${encodeURIComponent(input.userId)}/merge-preview`, {
    params: { ref: input.ref },
  })
  return accountMergePreviewSchema.parse(unwrapPayload(response.data))
}

async function listUserOperations(input: {
  readonly userId: string
  readonly page?: number
  readonly limit?: number
}): Promise<UserOperations> {
  const response = await api.get(`/admin/users/${encodeURIComponent(input.userId)}/operations`, {
    params: { page: input.page, limit: input.limit },
  })
  return userOperationsSchema.parse(unwrapPayload(response.data))
}

async function mergeAccounts(input: {
  readonly sourceId: string
  readonly targetId: string
  readonly choices: AccountMergeChoices
  readonly confirm: boolean
}): Promise<AccountMergeResult> {
  const response = await api.post('/admin/users/merge', input)
  return accountMergeResultSchema.parse(unwrapPayload(response.data))
}

/**
 * One row of the points journal, as `GET /admin/users/:telegramId/points/ledger`
 * (`admin-user-management.controller.ts`) returns it for the user card's
 * "Points history" sheet. `details` is whatever the writer recorded — the
 * sheet reads it by `source` and never trusts a shape it does not know.
 */
export const POINTS_LEDGER_SOURCES = [
  'CASHBACK',
  'CASHBACK_REVERSED',
  'REFERRAL_REWARD',
  'REFERRAL_REWARD_REVOKED',
  'QUEST_REWARD',
  'WHEEL_PRIZE',
  'CONTEST_PRIZE',
  'EXCHANGE',
  'MANUAL_ADJUSTMENT',
  'ACCOUNT_MERGE',
  'IMPORT',
  'OPENING_BALANCE',
] as const

export type PointsLedgerSource = (typeof POINTS_LEDGER_SOURCES)[number]

const pointsLedgerEntrySchema = z.object({
  id: z.string(),
  delta: z.number().int(),
  balanceAfter: z.number().int(),
  /**
   * NOT an enum on purpose.
   *
   * The API grows sources faster than the panel is redeployed — `WHEEL_PRIZE`
   * and `CONTEST_PRIZE` arrived that way — and a `z.enum` here rejects the
   * whole PAGE on the first unknown value, not the row: the operator loses
   * the journal entirely because somebody won on the wheel. The sheet already
   * falls back to the raw source for a label it has no translation for, so a
   * source it has never heard of costs one untranslated line and nothing
   * else.
   */
  source: z.string(),
  referenceKey: z.string().nullable(),
  details: z.unknown(),
  createdAt: z.string(),
})

const pointsLedgerPageSchema = z.object({
  items: z.array(pointsLedgerEntrySchema),
  nextCursor: z.string().nullable(),
})

export type PointsLedgerEntry = z.infer<typeof pointsLedgerEntrySchema>
export type PointsLedgerPage = z.infer<typeof pointsLedgerPageSchema>

/**
 * Keyset-paged: pass back `nextCursor` to continue, `null`/absent for the
 * first page. The id travels in the PATH, encoded; the cursor and the page
 * size in the query, which is where the backend reads them.
 */
async function listPointsLedger(input: {
  readonly userId: string
  readonly cursor?: string | null
  readonly limit?: number
}): Promise<PointsLedgerPage> {
  const response = await api.get(
    `/admin/users/${encodeURIComponent(input.userId)}/points/ledger`,
    { params: { cursor: input.cursor ?? undefined, limit: input.limit } },
  )
  return pointsLedgerPageSchema.parse(unwrapPayload(response.data))
}

export const usersApi = {
  getAccountMergePreview,
  listPointsLedger,
  listUserOperations,
  mergeAccounts,
}
