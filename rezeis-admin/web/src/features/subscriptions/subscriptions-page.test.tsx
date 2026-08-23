import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, within } from '@testing-library/react'

import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import SubscriptionsPage from './subscriptions-page'

const DAY_MS = 24 * 60 * 60 * 1000

/** Column order of the table under test: the expiry is the seventh cell. */
const EXPIRES_CELL = 6

/**
 * Every instant this file uses is derived from the moment the suite runs.
 *
 * The fixture here was a literal `2026-06-04T10:00:00.000Z`, written while it
 * was still in the future. Nothing marks the day such a literal slips into the
 * past, and on that day the row silently stops describing a live subscription
 * and starts describing an expired one — the assertion keeps passing over a
 * case it no longer names. Noon local, so no timezone offset can move the
 * rendered calendar day away from the one asserted.
 */
function isoDaysFromNow(days: number): string {
  const d = new Date(Date.now() + days * DAY_MS)
  d.setHours(12, 0, 0, 0)
  return d.toISOString()
}

/**
 * `dd.mm.yyyy`, spelled out from the date's own parts rather than borrowed
 * from `toLocaleDateString` — the call the component makes is the thing under
 * test, so re-running it here would assert only that it equals itself.
 */
function expectedRuDate(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`
}

const datedExpiry = isoDaysFromNow(30)

function expiresCellOf(rowText: string): HTMLElement {
  const row = screen.getByText(rowText).closest('tr')
  if (row === null) throw new Error(`no row for ${rowText}`)
  return within(row).getAllByRole('cell')[EXPIRES_CELL]
}

describe('SubscriptionsPage accessibility', () => {
  beforeEach(() => {
    vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path.startsWith('/admin/subscriptions?')) {
        return {
          data: {
            items: [
              {
                id: 'subscription-1',
                user: { id: 'cluseralice0000000000001', name: 'Alice' },
                userTelegramId: '12345',
                status: 'ACTIVE',
                isTrial: false,
                plan: { name: 'Premium' },
                trafficLimit: null,
                deviceLimit: null,
                expireAt: datedExpiry,
              },
              {
                // `expiresAt` is `DateTime?` on the model and the list mapper
                // sends `?.toISOString() ?? null`, so this is exactly what an
                // UNLIMITED subscription looks like on the wire — not an
                // absent field, not an empty string.
                id: 'subscription-2',
                user: { id: 'cluserboris00000000000002', name: 'Boris' },
                userTelegramId: '67890',
                status: 'ACTIVE',
                isTrial: false,
                plan: { name: 'Lifetime' },
                trafficLimit: null,
                deviceLimit: null,
                expireAt: null,
              },
            ],
            total: 2,
          },
        }
      }

      if (path === '/admin/subscriptions/stats') {
        return {
          data: {
            total: 2,
            byStatus: { ACTIVE: 2 },
            trialCount: 0,
            expiringIn7d: 0,
          },
        }
      }

      return { data: {} }
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('names icon-only subscription actions', async () => {
    renderWithProviders(<SubscriptionsPage />)

    expect(await screen.findByRole('button', { name: 'Refresh subscriptions' })).toBeInTheDocument()
    // Open-user aria prefers reiwa user id (works for web-only / no Telegram).
    expect(
      await screen.findByRole('button', { name: 'Open user cluseralice0000000000001' }),
    ).toBeInTheDocument()
  })

  it('names the status filter select', async () => {
    renderWithProviders(<SubscriptionsPage />)

    expect(await screen.findByRole('combobox', { name: 'Status' })).toBeInTheDocument()
  })

  it('makes the whole row open the user profile (incl. web-only via user.id)', async () => {
    renderWithProviders(<SubscriptionsPage />)

    const userCell = await screen.findByText('Alice')
    const row = userCell.closest('tr')
    expect(row).toHaveClass('cursor-pointer')
    // Keyboard parity without nested interactive roles: focusable row + named ↗ button.
    expect(row).toHaveAttribute('tabindex', '0')
    expect(
      screen.getByRole('button', { name: 'Open user cluseralice0000000000001' }),
    ).toBeInTheDocument()
  })

  it('renders an unlimited subscription as unlimited — not 1970, not blank, not a dash', async () => {
    // `expireAt: null` means the subscription never expires. Typed as a bare
    // `string`, it reached `new Date(null)`, which coerces to 0 and printed a
    // confident `01.01.1970` on every unlimited row.
    //
    // A dash would be no better and is asserted against on purpose: "—" says
    // "we do not know", and we do know. Three distinct wrong answers are
    // rejected here so that swapping the fix for `?? 0`, `?? ''` or a fallback
    // em dash cannot leave this test green.
    renderWithProviders(<SubscriptionsPage />)

    await screen.findByText('Boris')
    const cell = expiresCellOf('Boris')

    expect(cell).toHaveTextContent('Unlimited')
    expect(cell.textContent?.trim()).toBe('Unlimited')
    expect(cell).not.toHaveTextContent('1970')
    expect(cell.textContent?.trim()).not.toBe('')
    expect(cell.textContent?.trim()).not.toBe('—')
    expect(cell.textContent?.trim()).not.toBe('-')
  })

  it('renders a real expiry as that date', async () => {
    // The other half of the same statement: the null branch must not swallow
    // rows that DO have an expiry, or "unlimited" would become the panel's
    // answer to everything.
    renderWithProviders(<SubscriptionsPage />)

    await screen.findByText('Alice')
    const cell = expiresCellOf('Alice')

    expect(cell.textContent?.trim()).toBe(expectedRuDate(datedExpiry))
    expect(cell).not.toHaveTextContent('Unlimited')
  })
})
