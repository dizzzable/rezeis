import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import BlockedIdentitiesPage from './blocked-identities-page'
import { splitPastedValues } from './blocked-identities-api'

/**
 * The blocklist screen exists for one operator action — "here is a list of ids
 * to keep out" — and the two things that make it usable are the paste and the
 * per-row report. Both are tested here; the table itself is the same shape as
 * the IP list beside it and needs no separate proof.
 */

const ENTRY = {
  id: 'entry-1',
  kind: 'TELEGRAM_ID' as const,
  value: '123456789',
  reason: 'spam',
  source: 'manual',
  createdById: 'admin-1',
  originUserId: null,
  expiresAt: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
}

describe('splitting a pasted list', () => {
  it('accepts every separator an operator is likely to paste', () => {
    // Their source decides the format, not us: a spreadsheet column arrives
    // newline-separated, a chat message comma-separated, a log line
    // space-separated. Picking one guarantees the other two arrive as a single
    // enormous entry.
    expect(splitPastedValues('111\n222')).toEqual(['111', '222'])
    expect(splitPastedValues('111, 222')).toEqual(['111', '222'])
    expect(splitPastedValues('111; 222')).toEqual(['111', '222'])
    expect(splitPastedValues('111 222')).toEqual(['111', '222'])
    expect(splitPastedValues('111,\n 222 ;333')).toEqual(['111', '222', '333'])
  })

  it('drops blanks rather than reporting them back', () => {
    // A trailing newline is not a typo worth telling somebody about.
    expect(splitPastedValues('111\n\n222\n')).toEqual(['111', '222'])
    expect(splitPastedValues('   ')).toEqual([])
  })
})

describe('the blocklist screen', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('lists an entry with its provenance', async () => {
    // `manual` and `cascade` behave differently on an unblock — only the second
    // is removed automatically — so an operator has to be able to tell them
    // apart before deleting anything.
    vi.spyOn(api, 'get').mockResolvedValue({ data: { items: [ENTRY] } })

    renderWithProviders(<BlockedIdentitiesPage />)

    expect(await screen.findByText('123456789')).toBeInTheDocument()
    expect(screen.getByText('Manual')).toBeInTheDocument()
  })

  it('keeps the per-row report on screen after a partial paste', async () => {
    // The whole reason a paste with typos is REPORTED instead of REFUSED. If
    // the dialog closed on success the operator would be told "some entries
    // were rejected" and never learn which.
    vi.spyOn(api, 'get').mockResolvedValue({ data: { items: [] } })
    const post = vi.spyOn(api, 'post').mockResolvedValue({
      data: {
        added: 2,
        duplicates: ['111'],
        rejected: [{ value: 'oops', reason: 'NOT_NUMERIC' }],
      },
    })

    const user = userEvent.setup()
    renderWithProviders(<BlockedIdentitiesPage />)

    await user.click(await screen.findByRole('button', { name: /Add entries/ }))
    await user.type(screen.getByRole('textbox', { name: /Values/ }), '111 222 oops')
    await user.click(screen.getByRole('button', { name: /Add 3 entries/ }))

    await waitFor(() => expect(post).toHaveBeenCalled())
    expect(post.mock.calls[0][1]).toMatchObject({
      kind: 'TELEGRAM_ID',
      values: ['111', '222', 'oops'],
    })

    // The rejected row is named, and the value that caused it is shown.
    expect(await screen.findByText('oops')).toBeInTheDocument()
    expect(screen.getByText(/not a numeric id/)).toBeInTheDocument()
    // Duplicates are reported neutrally — re-pasting an overlapping list is
    // ordinary behaviour, not a failure.
    expect(screen.getByText(/already listed/)).toBeInTheDocument()
  })

  it('does not offer a device kind to type', async () => {
    // Nobody has a hardware id or a browser fingerprint to hand — they are
    // captured when an account is blocked. Offering them would be offering a
    // field that cannot be filled in.
    vi.spyOn(api, 'get').mockResolvedValue({ data: { items: [] } })

    const user = userEvent.setup()
    renderWithProviders(<BlockedIdentitiesPage />)

    await user.click(await screen.findByRole('button', { name: /Add entries/ }))
    await user.click(screen.getByRole('combobox'))

    expect(await screen.findByRole('option', { name: 'Telegram ID' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /VPN device/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /Browser device/ })).not.toBeInTheDocument()
  })

  it('will not submit an empty paste', async () => {
    // The control for the submit button: enabled on an empty textarea it would
    // send `values: []`, which the server refuses with a validation error the
    // operator cannot act on.
    vi.spyOn(api, 'get').mockResolvedValue({ data: { items: [] } })

    const user = userEvent.setup()
    renderWithProviders(<BlockedIdentitiesPage />)

    await user.click(await screen.findByRole('button', { name: /Add entries/ }))
    expect(screen.getByRole('button', { name: /Add 0 entries/ })).toBeDisabled()
  })
})
