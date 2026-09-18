/**
 * The tab strips that did not fit a phone are allowed to wrap.
 *
 * Measured in Chromium against the running SPA, Russian and English, 375 px
 * wide: four page strips stayed on one row wider than the screen and the page
 * cut their last tabs off — the audit log (four tabs: 658 px in Russian, 447 in
 * English), Partners (four: 451 / 424), Referrals (five: 525 / 427) and, in
 * Russian, Users (three: 427 px; 314 in English, which fits). The partner card's strip,
 * six tabs with icons, came to 670 px in a 375 px sheet. Each now carries
 * `flex-wrap`, and `TabsList` lets a wrapping strip grow with its rows.
 *
 * On a desktop none of them wraps, and a strip on one row keeps its height: 40 px
 * for the plain ones (`h-auto` on one row is 40 px), 44 px for the partner card,
 * which is why that one says `min-h-11` rather than `h-11` — a fixed height would
 * cut its second row off again. The desktop boxes were compared before and after
 * and did not move.
 *
 * jsdom lays nothing out, so what is held here is the class each strip carries,
 * read off the strip its real page renders.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, screen } from '@testing-library/react'

import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import AuditPage from '@/features/audit/audit-page'
import PartnerDetailSheet from '@/features/partners/partner-detail-sheet'
import PartnersPage from '@/features/partners/partners-page'
import type { Partner } from '@/features/partners/partners-api'
import ReferralsPage from '@/features/referrals/referrals-page'
import UsersPage from '@/features/users/users-page'

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>
  proto['hasPointerCapture'] ??= () => false
  proto['setPointerCapture'] ??= () => {}
  proto['releasePointerCapture'] ??= () => {}
  proto['scrollIntoView'] ??= () => {}
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** Every request left unanswered: the pages draw their strips while they load. */
function loadingForever(): void {
  vi.spyOn(api, 'get').mockImplementation(() => new Promise(() => undefined))
}

/** The class list of the strip that holds the tab named `tabName`. */
async function stripHolding(tabName: RegExp): Promise<string[]> {
  const tab = await screen.findByRole('tab', { name: tabName })
  const strip = tab.closest('[role="tablist"]')
  expect(strip, `no strip holds the ${String(tabName)} tab`).not.toBeNull()
  return (strip as HTMLElement).className.split(/\s+/)
}

function partner(): Partner {
  const createdAt = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString()
  return {
    id: 'partner-1',
    user: { id: 'user-1', login: 'alice', username: 'alice', name: 'Alice', telegramId: '12345', createdAt },
    balance: 12500,
    totalEarned: 50000,
    totalWithdrawn: 10000,
    isActive: true,
    referralsCount: 3,
    useGlobalSettings: true,
    accrualStrategy: 'ON_EACH_PAYMENT',
    rewardType: 'PERCENT',
    level1Percent: '10',
    level2Percent: '5',
    level3Percent: '1',
    level1FixedAmount: null,
    level2FixedAmount: null,
    level3FixedAmount: null,
    level1AccrualStrategy: null,
    level2AccrualStrategy: null,
    level3AccrualStrategy: null,
    createdAt,
    updatedAt: createdAt,
  }
}

describe('tab strips that did not fit a phone', () => {
  it.each([
    ['the audit log', () => <AuditPage />, /^Log$/],
    ['partners', () => <PartnersPage />, /^Partners$/],
    ['referrals', () => <ReferralsPage />, /^Referrals$/],
    ['users', () => <UsersPage />, /^List$/],
  ])('%s: wraps instead of running off the screen', async (_page, page, firstTab) => {
    loadingForever()
    renderWithProviders(page())

    const tokens = await stripHolding(firstTab)

    expect(tokens).toContain('flex-wrap')
  })

  it('the partner card: wraps, and keeps its 44 px as a floor rather than a fixed height', async () => {
    loadingForever()
    renderWithProviders(<PartnerDetailSheet partner={partner()} open onOpenChange={() => {}} />)

    const tokens = await stripHolding(/^Overview$/)

    expect(tokens).toContain('flex-wrap')
    expect(tokens).toContain('min-h-11')
    expect(tokens).not.toContain('h-11')
  })
})
