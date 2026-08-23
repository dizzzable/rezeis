import { afterEach, describe, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'
import { CANDIDATE_HOLD_KINDS, getPendingFraudCandidates } from './fraud-api'

/**
 * The type boundary of `GET /admin/fraud/pending`, driven through the real
 * fetcher rather than a mocked module.
 *
 * `expectArray` proved the container and nothing about its elements, so a
 * `heldBy` this module had never heard of travelled all the way to render and
 * came out wearing the wrong badge. The schema is what makes that a failure
 * with a name instead of a confident wrong answer, and these are the two
 * statements it has to keep: the third hold kind survives the trip, and a
 * fourth one does not sneak through.
 */

/** Derived, never literal — a hard-coded instant rots into a different case. */
function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString()
}

function pendingRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'pend-1',
    code: 'SUBSCRIPTION_SHARING_HWID',
    conditionKey: 'uuid-1',
    observations: 3,
    requiredObservations: 3,
    severity: 'MEDIUM',
    lastSeverity: 'MEDIUM',
    score: 60,
    title: 'Subscription sharing — device limit exceeded',
    affectedUserIds: ['user-1'],
    heldBy: 'verdict',
    exemptionId: null,
    firstSeenAt: minutesAgo(15),
    lastSeenAt: minutesAgo(5),
    ...overrides,
  }
}

describe('getPendingFraudCandidates', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('carries a verdict hold through unchanged', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ data: [pendingRow()] } as never)

    const [row] = await getPendingFraudCandidates()

    expect(row.heldBy).toBe('verdict')
  })

  it('accepts every kind the union declares', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({
      data: CANDIDATE_HOLD_KINDS.map((kind, index) =>
        pendingRow({ id: `pend-${index}`, heldBy: kind }),
      ),
    } as never)

    const rows = await getPendingFraudCandidates()

    expect(rows.map((row) => row.heldBy)).toEqual([...CANDIDATE_HOLD_KINDS])
  })

  it('refuses a hold kind it does not know instead of passing it on', async () => {
    // A throw reaches the card's error branch, which says out loud that it
    // could not read the list. The alternative — coercing the unknown value to
    // a known one — is how `'verdict'` spent its life rendering as a streak.
    vi.spyOn(api, 'get').mockResolvedValue({
      data: [pendingRow({ heldBy: 'quarantine' })],
    } as never)

    await expect(getPendingFraudCandidates()).rejects.toThrow()
  })
})
