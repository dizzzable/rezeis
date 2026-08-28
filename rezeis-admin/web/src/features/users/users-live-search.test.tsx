import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import UsersPage from './users-page'

/**
 * The user list follows the search box.
 *
 * ── The two complaints this answers ──────────────────────────────────────
 *
 * Typing a login showed the previous result until you reached for Enter, and
 * CLEARING the box did nothing at all — the full list came back only after
 * submitting an empty field, which is not an action anybody thinks to perform.
 * The second is the one that reads as broken: you delete what you searched for
 * and the screen keeps showing it.
 */

function listResponse(items: ReadonlyArray<Record<string, unknown>>) {
  return { data: { items, total: items.length } }
}

function user(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-1',
    telegramId: '111',
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

/** Every `search` value the list endpoint was asked for, in order. */
type ApiCall = readonly [string, { params?: { search?: string } } | undefined]

function searchTerms(get: { mock: { calls: unknown[][] } }): Array<string | undefined> {
  return (get.mock.calls as unknown as ApiCall[])
    .filter((call) => call[0] === '/admin/users')
    .map((call) => call[1]?.params?.search)
}

describe('searching the user list', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('follows what is typed, without pressing anything', async () => {
    const get = vi.spyOn(api, 'get').mockResolvedValue(listResponse([user()]))

    const userEvt = userEvent.setup()
    renderWithProviders(<UsersPage />)

    const box = await screen.findByRole('textbox', { name: /Reiwa ID/ })
    await userEvt.type(box, 'dizzable')

    await waitFor(() => expect(searchTerms(get)).toContain('dizzable'))
  })

  it('asks once for a word, not once per keystroke', async () => {
    // The search is an OR across five columns. A request per character turns
    // one lookup into eight on the busiest admin screen there is.
    const get = vi.spyOn(api, 'get').mockResolvedValue(listResponse([user()]))

    const userEvt = userEvent.setup()
    renderWithProviders(<UsersPage />)

    await userEvt.type(await screen.findByRole('textbox', { name: /Reiwa ID/ }), 'dizzable')
    await waitFor(() => expect(searchTerms(get)).toContain('dizzable'))

    const intermediate = searchTerms(get).filter(
      (term) => typeof term === 'string' && term.length > 0 && term !== 'dizzable',
    )
    expect(intermediate.length).toBeLessThan(3)
  })

  it('returns to the full list when the box is cleared', async () => {
    // The complaint that reads as broken: you delete what you searched for and
    // the screen keeps showing it until you submit an empty field.
    const get = vi.spyOn(api, 'get').mockResolvedValue(listResponse([user()]))

    const userEvt = userEvent.setup()
    renderWithProviders(<UsersPage />)

    const box = await screen.findByRole('textbox', { name: /Reiwa ID/ })
    await userEvt.type(box, 'dizzable')
    await waitFor(() => expect(searchTerms(get)).toContain('dizzable'))

    await userEvt.clear(box)

    // An unfiltered request — no `search` param at all, which is what the
    // initial load sends.
    await waitFor(() => {
      const terms = searchTerms(get)
      expect(terms[terms.length - 1]).toBeUndefined()
    })
  })

  it('still searches immediately on Enter', async () => {
    // The box is also a form. Somebody who types and hits Enter should not wait
    // out a timer they never knew about.
    const get = vi.spyOn(api, 'get').mockResolvedValue(listResponse([user()]))

    const userEvt = userEvent.setup()
    renderWithProviders(<UsersPage />)

    const box = await screen.findByRole('textbox', { name: /Reiwa ID/ })
    await userEvt.type(box, 'abc{Enter}')

    await waitFor(() => expect(searchTerms(get)).toContain('abc'))
  })
})
