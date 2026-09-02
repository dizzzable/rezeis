/**
 * THE THREE REQUESTS THIS MODULE IS ALLOWED TO MAKE — verb, path and body.
 *
 * What stood here before was thirteen specs over a client that no screen
 * called. That is worse than no coverage: the block/unblock spec asserted
 * `PATCH /admin/users/:id/block` with a `{ reason }` body, so a client
 * disagreeing with the server on the HTTP VERB read as a verified one. The
 * live control posts (`user-detail-panel.tsx`), the backend declares
 * `@Post(':telegramId/block')` / `@Post(':telegramId/unblock')`
 * (`admin-user-management.controller.ts`), and those handlers read no reason
 * at all. The client and its specs went together.
 *
 * So every assertion below names the verb it expects AND asserts the other
 * verbs stayed untouched. A second client re-grown under a different method —
 * exactly the shape that was just removed — fails here rather than passing.
 *
 * Each of the three targets a route that exists, quoted at the assertion:
 *   • GET  /admin/users/:telegramId/operations     (admin-user-management.controller.ts)
 *   • GET  /admin/users/:id/merge-preview          (admin-account-merge.controller.ts)
 *   • POST /admin/users/merge                      (admin-account-merge.controller.ts)
 *
 * Payload shape: this backend installs no global response interceptor, so its
 * handlers return the payload bare. `unwrapPayloadOrArray` also accepts a
 * `{ data: … }` wrapper, and one spec covers that branch so the tolerance is
 * deliberate rather than untested.
 *
 * No absolute date literal appears here — every timestamp is derived from the
 * clock this file runs on.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { usersApi } from '@/features/users/users-api'
import { api } from '@/lib/api'

vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}))

const mockedGet = vi.mocked(api.get)
const mockedPost = vi.mocked(api.post)
const mockedPatch = vi.mocked(api.patch)
const mockedDelete = vi.mocked(api.delete)

/** Fixed literals here would be claims about a calendar; these are not. */
const HOURS_AGO = (hours: number): string =>
  new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()
const DAYS_AGO = (days: number): string => HOURS_AGO(days * 24)

/** One page of the merged operations timeline, in the server's own shape. */
function operationsPayload() {
  return {
    items: [
      {
        id: 'tx-1',
        kind: 'PAYMENT',
        occurredAt: HOURS_AGO(3),
        payload: {
          paymentId: 'pay-1',
          status: 'COMPLETED',
          purchaseType: 'RENEW',
          gatewayType: 'YOOKASSA',
          currency: 'RUB',
          amount: '1490.00',
        },
      },
      {
        id: 'exch-1',
        kind: 'POINTS_EXCHANGE',
        occurredAt: HOURS_AGO(9),
        payload: {
          type: 'SUBSCRIPTION_DAYS',
          pointsSpent: 300,
          rewardValue: 30,
          expiresAtBefore: DAYS_AGO(-2),
          expiresAtAfter: DAYS_AGO(-32),
          trafficLimitBefore: null,
          trafficLimitAfter: null,
          personalDiscountBefore: null,
          personalDiscountAfter: null,
          targetSubscription: { id: 'sub-1', label: 'Pro' },
          sync: { status: 'SYNCED', lastError: null },
        },
      },
    ],
    total: 2,
    page: 2,
    limit: 25,
  }
}

/** One side of a merge preview, in the server's own shape. */
function accountSummary(overrides: Record<string, unknown>) {
  return {
    userId: 'user-1',
    login: 'alice',
    telegramId: '12345',
    email: 'alice@example.com',
    name: 'Alice',
    isBlocked: false,
    hasWebAccount: true,
    hasTrialGrant: false,
    subscriptions: { total: 2, active: 1, trial: 0 },
    transactionsCount: 7,
    partner: { isPartner: false, balanceMinor: 0 },
    createdAt: DAYS_AGO(200),
    ...overrides,
  }
}

describe('usersApi — the surface itself', () => {
  it('exports the four functions the panel imports, and nothing else', () => {
    // THE anti-shadow assertion. `users-api.ts` once exported forty functions
    // and `user-detail-panel.tsx` imported three; the other thirty-seven were
    // a second client for routes this backend never declared. Names, not a
    // count: the failure has to say WHICH function grew back.
    expect(Object.keys(usersApi).sort()).toEqual([
      'getAccountMergePreview',
      'listPointsLedger',
      'listUserOperations',
      'mergeAccounts',
    ])
  })

  it('carries no moderation client beside the panel’s inline POST', () => {
    // Named, because this is the one that shipped a method the server does not
    // implement. Blocking lives at `user-detail-panel.tsx`'s own
    // `api.post('/admin/users/:telegramId/:action')`, and must have exactly one
    // implementation.
    expect(usersApi).not.toHaveProperty('setUserBlockedState')
    expect(usersApi).not.toHaveProperty('listUserModerationHistory')
  })
})

describe('usersApi.listPointsLedger', () => {
  // GET /admin/users/:telegramId/points/ledger (admin-user-management.controller.ts)
  beforeEach(() => {
    vi.mocked(api.get).mockReset()
    vi.mocked(api.post).mockReset()
    vi.mocked(api.patch).mockReset()
  })

  it('GETs /admin/users/:telegramId/points/ledger with the cursor and page size in the query', async () => {
    vi.mocked(api.get).mockResolvedValue({
      data: {
        items: [
          {
            id: 'ledger-2',
            delta: 13,
            balanceAfter: 18,
            source: 'CASHBACK',
            referenceKey: 'tx-1',
            details: { lines: [] },
            createdAt: new Date().toISOString(),
          },
        ],
        nextCursor: 'ledger-2',
      },
    })

    const page = await usersApi.listPointsLedger({ userId: '12345', cursor: 'ledger-9', limit: 25 })

    expect(api.get).toHaveBeenCalledWith('/admin/users/12345/points/ledger', {
      params: { cursor: 'ledger-9', limit: 25 },
    })
    expect(api.post).not.toHaveBeenCalled()
    expect(api.patch).not.toHaveBeenCalled()
    expect(page.nextCursor).toBe('ledger-2')
    expect(page.items[0]).toMatchObject({ id: 'ledger-2', delta: 13, source: 'CASHBACK' })
  })

  it('sends no cursor for the first page and encodes the identifier in the path', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { items: [], nextCursor: null } })

    await usersApi.listPointsLedger({ userId: 'cm/odd id', cursor: null })

    expect(api.get).toHaveBeenCalledWith('/admin/users/cm%2Fodd%20id/points/ledger', {
      params: { cursor: undefined, limit: undefined },
    })
  })

  it('refuses a row whose source the panel does not know', async () => {
    vi.mocked(api.get).mockResolvedValue({
      data: {
        items: [{ id: 'x', delta: 1, balanceAfter: 1, source: 'LOTTERY', referenceKey: null, details: null, createdAt: new Date().toISOString() }],
        nextCursor: null,
      },
    })

    await expect(usersApi.listPointsLedger({ userId: '12345' })).rejects.toThrow()
  })
})

describe('usersApi.listUserOperations', () => {
  beforeEach(() => {
    mockedGet.mockReset()
    mockedPost.mockReset()
    mockedPatch.mockReset()
    mockedDelete.mockReset()
  })

  it('GETs /admin/users/:telegramId/operations with bounded paging', async () => {
    mockedGet.mockResolvedValue({ data: operationsPayload() })

    const result = await usersApi.listUserOperations({ userId: '12345', page: 2, limit: 25 })

    // The VERB is the assertion, not an implementation detail: `@Get(...)`.
    expect(mockedGet).toHaveBeenCalledWith('/admin/users/12345/operations', {
      params: { page: 2, limit: 25 },
    })
    // …and no other verb was reached for. A PATCH-shaped copy fails here.
    expect(mockedPost).not.toHaveBeenCalled()
    expect(mockedPatch).not.toHaveBeenCalled()
    expect(mockedDelete).not.toHaveBeenCalled()

    // Parsed VALUES, not a call count: the discriminated union has to survive.
    expect(result.total).toBe(2)
    expect(result.page).toBe(2)
    expect(result.items.map((item) => item.kind)).toEqual(['PAYMENT', 'POINTS_EXCHANGE'])
    const payment = result.items[0]
    if (payment.kind !== 'PAYMENT') throw new Error('expected the first item to be a PAYMENT')
    expect(payment.payload.amount).toBe('1490.00')
    expect(payment.payload.currency).toBe('RUB')
    const exchange = result.items[1]
    if (exchange.kind !== 'POINTS_EXCHANGE') throw new Error('expected a POINTS_EXCHANGE')
    expect(exchange.payload.pointsSpent).toBe(300)
    expect(exchange.payload.targetSubscription?.label).toBe('Pro')
  })

  it('puts the identifier in the PATH, encoded, and never in the query', async () => {
    mockedGet.mockResolvedValue({ data: { ...operationsPayload(), page: 1 } })

    await usersApi.listUserOperations({ userId: 'user/1 +2' })

    const [path, config] = mockedGet.mock.calls[0] as [string, { params: unknown }]
    expect(path).toBe('/admin/users/user%2F1%20%2B2/operations')
    // `:telegramId` is a path parameter — a copy that moved it to the query
    // string would hit `@Get()` (the LIST route) with an unknown param and 400.
    expect(config.params).toEqual({ page: undefined, limit: undefined })
  })

  it('accepts the { data: … } wrapper too', async () => {
    mockedGet.mockResolvedValue({ data: { data: operationsPayload() } })

    const result = await usersApi.listUserOperations({ userId: '12345' })

    expect(result.items).toHaveLength(2)
    expect(result.limit).toBe(25)
  })

  it('refuses a timeline item of an unknown kind', async () => {
    // ANTI-VACUITY for every "parsed values" assertion above: without this, a
    // `parse` quietly replaced by a cast would satisfy all of them.
    mockedGet.mockResolvedValue({
      data: {
        items: [{ id: 'x-1', kind: 'REFUND', occurredAt: HOURS_AGO(1), payload: {} }],
        total: 1,
        page: 1,
        limit: 25,
      },
    })

    await expect(usersApi.listUserOperations({ userId: '12345' })).rejects.toThrow()
  })
})

describe('usersApi.getAccountMergePreview', () => {
  beforeEach(() => {
    mockedGet.mockReset()
    mockedPost.mockReset()
    mockedPatch.mockReset()
    mockedDelete.mockReset()
  })

  it('GETs /admin/users/:id/merge-preview with the counterpart ref in the query', async () => {
    mockedGet.mockResolvedValue({
      data: {
        current: accountSummary({}),
        counterpart: accountSummary({
          userId: 'user-2',
          login: null,
          telegramId: '67890',
          email: null,
          name: 'Alice (Telegram)',
          hasWebAccount: false,
        }),
        conflicts: ['telegram'],
      },
    })

    const preview = await usersApi.getAccountMergePreview({ userId: 'user-1', ref: '67890' })

    expect(mockedGet).toHaveBeenCalledWith('/admin/users/user-1/merge-preview', {
      params: { ref: '67890' },
    })
    expect(mockedPost).not.toHaveBeenCalled()
    expect(mockedPatch).not.toHaveBeenCalled()
    expect(mockedDelete).not.toHaveBeenCalled()

    expect(preview.current.userId).toBe('user-1')
    expect(preview.counterpart.userId).toBe('user-2')
    expect(preview.counterpart.login).toBeNull()
    expect(preview.counterpart.hasWebAccount).toBe(false)
    expect(preview.conflicts).toEqual(['telegram'])
    expect(preview.current.subscriptions.active).toBe(1)
  })
})

describe('usersApi.mergeAccounts', () => {
  beforeEach(() => {
    mockedGet.mockReset()
    mockedPost.mockReset()
    mockedPatch.mockReset()
    mockedDelete.mockReset()
  })

  it('POSTs /admin/users/merge with the whole decision, confirm included', async () => {
    mockedPost.mockResolvedValue({
      data: {
        mergedUserId: 'user-1',
        movedCounts: { subscriptions: 2, transactions: 7, partnerTransactions: 0 },
        remnawaveSubscriptionIds: ['rw-1', 'rw-2'],
      },
    })

    const result = await usersApi.mergeAccounts({
      sourceId: 'user-2',
      targetId: 'user-1',
      choices: { keepLogin: 'target', keepTelegram: 'source', currentSubscriptionId: 'sub-1' },
      confirm: true,
    })

    // The BODY, in full. `confirm` is what makes this irreversible act
    // deliberate; a copy that dropped it would still "call POST /merge".
    expect(mockedPost).toHaveBeenCalledWith('/admin/users/merge', {
      sourceId: 'user-2',
      targetId: 'user-1',
      choices: { keepLogin: 'target', keepTelegram: 'source', currentSubscriptionId: 'sub-1' },
      confirm: true,
    })
    expect(mockedGet).not.toHaveBeenCalled()
    expect(mockedPatch).not.toHaveBeenCalled()
    expect(mockedDelete).not.toHaveBeenCalled()

    expect(result.mergedUserId).toBe('user-1')
    expect(result.movedCounts.transactions).toBe(7)
    expect(result.remnawaveSubscriptionIds).toEqual(['rw-1', 'rw-2'])
  })

  it('refuses a result missing the moved counts', async () => {
    // ANTI-VACUITY: the panel reports these numbers to the operator after an
    // irreversible act. A silently un-parsed response would render `undefined`.
    mockedPost.mockResolvedValue({
      data: { mergedUserId: 'user-1', remnawaveSubscriptionIds: [] },
    })

    await expect(
      usersApi.mergeAccounts({
        sourceId: 'user-2',
        targetId: 'user-1',
        choices: {},
        confirm: true,
      }),
    ).rejects.toThrow()
  })
})
