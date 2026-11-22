/**
 * The three traffic-status slots in the Emoji Studio must read as commands.
 *
 * `TRAFFIC_OK` / `TRAFFIC_WARN` / `TRAFFIC_FULL` are not one-screen icons like
 * the other slots: the bot picks one per traffic line, so a premium emoji bound
 * here shows up in EVERY traffic indicator — the leading «Трафик» line of a
 * plan and each «Трафик доп.» line of a merged tariff. The registry keys alone
 * do not say that, so the Studio names the three slots in owner language and
 * says once, above them, that they change all traffic lines at once.
 */
import { describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import CustomEmojiPage from './custom-emoji-page'

const TRAFFIC_SLOTS = [
  { id: 'e1', key: 'TRAFFIC_OK', unicode: '🟢' },
  { id: 'e2', key: 'TRAFFIC_WARN', unicode: '🟠' },
  { id: 'e3', key: 'TRAFFIC_FULL', unicode: '🔴' },
] as const

function mockStudio(): void {
  vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/admin/bot-config/emoji-studio') {
      return {
        data: {
          ownerHasPremium: true,
          slots: TRAFFIC_SLOTS.map((slot) => ({
            ...slot,
            tgEmojiId: null,
            premiumPreview: null,
            usedIn: ['welcome.traffic-dot'],
          })),
        },
      }
    }
    // The packs tab (the page's default tab) reads this on mount.
    return { data: [] }
  })
}

async function openSlotsTab(): Promise<void> {
  const user = userEvent.setup()
  renderWithProviders(<CustomEmojiPage />)
  await user.click(await screen.findByRole('tab', { name: 'Emoji slots' }))
}

describe('emoji studio traffic slots', () => {
  it('names the three slots and says they change every traffic line at once', async () => {
    mockStudio()
    await openSlotsTab()

    expect(await screen.findByText('Traffic: fine / unlimited')).toBeInTheDocument()
    expect(screen.getByText('Traffic: running low')).toBeInTheDocument()
    expect(screen.getByText('Traffic: exhausted')).toBeInTheDocument()
    // The hint is what turns three rows into one command: "ALL traffic lines".
    expect(screen.getByText(/change EVERY traffic indicator at once/)).toBeInTheDocument()

    // …and the rows are one group under it, not three scattered registry rows.
    const hint = document.querySelector<HTMLTableRowElement>('[data-emoji-traffic-group="hint"]')
    const grouped = document.querySelectorAll<HTMLTableRowElement>(
      '[data-emoji-traffic-group="slot"]',
    )
    expect(hint).not.toBeNull()
    expect(grouped).toHaveLength(3)
    const rows = [...document.querySelectorAll<HTMLTableRowElement>('tr')]
    expect(rows.indexOf(hint as HTMLTableRowElement)).toBeLessThan(rows.indexOf(grouped[0] as HTMLTableRowElement))
  })
})
