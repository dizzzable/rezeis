import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { SupportDropdown } from '@/components/layout/admin-topbar/support-dropdown'
import { renderWithProviders } from '@/test/test-utils'

/**
 * The support dropdown's donation link.
 *
 * Pinned by ADDRESS rather than by "a donate item exists", because the address
 * is the entire function of the item — and because the same destination is
 * duplicated in the reiwa bot's credits card
 * (`src/bot/lib/startup-notice.ts`). The two ship as separate images from
 * separate repositories with nothing linking them at build time, so the only
 * thing that can catch a half-finished change is each side asserting its own
 * copy. reiwa's counterpart lives in `test/bot/lib/startup-credits.test.ts`.
 */
describe('SupportDropdown', () => {
  afterEach(cleanup)

  async function openMenu(): Promise<void> {
    renderWithProviders(<SupportDropdown />)
    await userEvent.click(screen.getByRole('button'))
  }

  it('sends the donate item to the current donation link', async () => {
    await openMenu()

    const donate = screen.getByRole('menuitem', { name: /donat|поддерж/i })
    expect(donate).toHaveAttribute('href', 'https://dalink.to/dizzzable')
  })

  it('opens the link in a new tab without leaking the referrer', async () => {
    // `target="_blank"` without `rel="noreferrer"` hands the opened page a
    // reference back to the panel window. The panel is an authenticated
    // surface, so this is not merely hygiene.
    await openMenu()

    const donate = screen.getByRole('menuitem', { name: /donat|поддерж/i })
    expect(donate).toHaveAttribute('target', '_blank')
    expect(donate.getAttribute('rel') ?? '').toContain('noreferrer')
  })

  it('still offers the crypto address alongside it', async () => {
    // Guards the shape of the fix: swapping the donation link must not quietly
    // cost the other way to support the project.
    await openMenu()

    expect(screen.getByText('TNmxGN8iL5p2yfreNF1DtCEzpQCLuVZjeR')).toBeInTheDocument()
  })
})
