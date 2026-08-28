import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'

import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import UsersPage from './users-page'

/**
 * The badge that says "a device on this account also belongs to a blocked one".
 *
 * ── Why this is worth a test of its own ───────────────────────────────────
 *
 * It is the only visible half of the whole device-signal feature. The panel can
 * record every observation and raise every flag correctly, and if the row does
 * not draw the mark, nobody ever looks — which is indistinguishable from not
 * having built it.
 *
 * The second test is the one that matters more: the mark must be visually
 * distinct from BLOCKED. A device match is a question for an operator, not a
 * verdict on the account, and an operator who reads it as a verdict bans a
 * family sharing a laptop.
 */

function listOf(items: ReadonlyArray<Record<string, unknown>>) {
  return { data: { items, total: items.length } }
}

function user(overrides: Record<string, unknown>) {
  return {
    id: 'user-1',
    telegramId: '123456789',
    username: 'someone',
    email: null,
    name: 'Some One',
    login: null,
    role: 'USER',
    language: 'EN',
    isBlocked: false,
    openReviewFlags: 0,
    createdAt: '2026-08-01T00:00:00.000Z',
    lastSeenAt: null,
    ...overrides,
  }
}

describe('review-flag badge on the users list', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('marks a flagged account', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(listOf([user({ openReviewFlags: 1 })]))

    renderWithProviders(<UsersPage />)

    expect(await screen.findByLabelText(/Flagged for review/)).toBeInTheDocument()
  })

  it('leaves an ordinary account unmarked', async () => {
    // The control. A badge that renders for everybody would satisfy the
    // assertion above and would make the mark meaningless.
    vi.spyOn(api, 'get').mockResolvedValue(listOf([user({ openReviewFlags: 0 })]))

    renderWithProviders(<UsersPage />)

    expect(await screen.findByText('Some One')).toBeInTheDocument()
    expect(screen.queryByLabelText(/Flagged for review/)).not.toBeInTheDocument()
  })

  it('does not mark a blocked account that has no flags', async () => {
    // The two states are different facts and must not share a marker: BLOCKED
    // is a decision already taken, FLAGGED is a decision waiting to be taken.
    vi.spyOn(api, 'get').mockResolvedValue(
      listOf([user({ isBlocked: true, openReviewFlags: 0 })]),
    )

    renderWithProviders(<UsersPage />)

    expect(await screen.findByText('Some One')).toBeInTheDocument()
    expect(screen.queryByLabelText(/Flagged for review/)).not.toBeInTheDocument()
  })

  it('shows the count only when more than one signal matched', async () => {
    // One matching signal is a lead; two independent ones is close to proof.
    // The number is what lets an operator choose which row to open first, and a
    // "1" beside every mark would be noise that hides it.
    vi.spyOn(api, 'get').mockResolvedValue(
      listOf([
        user({ id: 'user-1', name: 'One Signal', openReviewFlags: 1 }),
        user({ id: 'user-2', name: 'Two Signals', openReviewFlags: 2 }),
      ]),
    )

    renderWithProviders(<UsersPage />)

    expect(await screen.findByText('Two Signals')).toBeInTheDocument()
    expect(screen.getAllByLabelText(/Flagged for review/)).toHaveLength(2)
    expect(screen.getByText('2')).toBeInTheDocument()
  })

  it('renders against a panel build that does not send the field yet', async () => {
    // The cabinet and the panel are released separately. A list that throws on
    // a missing field would take the whole users screen down during the gap.
    const withoutField = user({})
    delete (withoutField as Record<string, unknown>).openReviewFlags
    vi.spyOn(api, 'get').mockResolvedValue(listOf([withoutField]))

    renderWithProviders(<UsersPage />)

    expect(await screen.findByText('Some One')).toBeInTheDocument()
    expect(screen.queryByLabelText(/Flagged for review/)).not.toBeInTheDocument()
  })
})
