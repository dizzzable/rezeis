import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { api } from '@/lib/api'
import { loadFeatureBundle } from '@/i18n/i18n'
import { renderWithProviders } from '@/test/test-utils'
import BroadcastPage from './broadcast-page'

/**
 * The broadcast screen after scheduling and draft editing were added.
 *
 * Both features shipped with no test on this file, and both immediately
 * produced the same kind of defect: a control that looks right and does the
 * opposite. A scheduled send could not be stopped; opening one to fix a typo
 * fired it at the whole audience. These are about the controls telling the
 * truth.
 */

const SCHEDULED_ROW = {
  id: 'b-1',
  audience: 'ALL',
  status: 'SCHEDULED',
  successCount: 0,
  totalCount: 0,
  failedCount: 0,
  scheduledAt: '2099-01-01T20:00:00.000Z',
  createdAt: '2026-09-01T10:00:00.000Z',
}

function stubList(rows: readonly unknown[]) {
  return vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/admin/broadcast/drafts') return { data: rows }
    return { data: {} }
  })
}

describe('a pending scheduled send can be stopped', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('offers both cancel and delete on a scheduled row', async () => {
    // It had cancel only — and the backend refused it, so a scheduled
    // broadcast had no stop path of any kind.
    stubList([SCHEDULED_ROW])
    await loadFeatureBundle('broadcast')

    renderWithProviders(<BroadcastPage />)

    await waitFor(() => {
      expect(screen.getByLabelText('Cancel broadcast')).toBeTruthy()
    })
    expect(screen.getByLabelText('Delete broadcast')).toBeTruthy()
  })

  it('shows when it will go out, not when it was written', async () => {
    stubList([SCHEDULED_ROW])
    await loadFeatureBundle('broadcast')

    renderWithProviders(<BroadcastPage />)

    await waitFor(() => {
      expect(screen.getByText(/Goes out/)).toBeTruthy()
    })
  })
})

describe('opening a scheduled send does not fire it', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('loads the schedule back into the form so the button still says "schedule"', async () => {
    // The dialog used to open with the toggle off, so its one submit button
    // read "send now" and pressing it mailed everybody immediately while
    // clearing the stored time.
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path === '/admin/broadcast/drafts') return { data: [SCHEDULED_ROW] }
      if (path === '/admin/broadcast/b-1') {
        return {
          data: {
            id: 'b-1',
            audience: 'ALL',
            status: 'SCHEDULED',
            scheduledAt: '2099-01-01T20:00:00.000Z',
            promoCode: null,
            audienceFilter: null,
            payload: {
              title: 'Hi',
              text: 'body',
              mediaType: 'none',
              mediaFileId: null,
              emailEnabled: false,
              telegramChannelChatId: null,
            },
          },
        }
      }
      return { data: {} }
    })
    await loadFeatureBundle('broadcast')

    renderWithProviders(<BroadcastPage />)
    await waitFor(() => expect(screen.getByLabelText('Edit draft')).toBeTruthy())
    await user.click(screen.getByLabelText('Edit draft'))

    // The claim is about the SUBMIT button, and the whole defect is that it
    // used to read "Create and send" on a broadcast that was already scheduled
    // — one press and the audience was mailed immediately.
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /^Schedule$/ }).length).toBeGreaterThan(0)
    })
    expect(screen.queryByRole('button', { name: /^Create and send$/ })).toBeNull()
  })

  it('offers Save, so corrections can be kept without sending', async () => {
    // The footer was Cancel / Test / Send: closing the dialog threw the edits
    // away and the only way to keep them was to send the broadcast.
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path === '/admin/broadcast/drafts') return { data: [{ ...SCHEDULED_ROW, status: 'DRAFT' }] }
      if (path === '/admin/broadcast/b-1') {
        return {
          data: {
            id: 'b-1',
            audience: 'ALL',
            status: 'DRAFT',
            scheduledAt: null,
            promoCode: null,
            audienceFilter: null,
            payload: {
              title: null,
              text: 'body',
              mediaType: 'none',
              mediaFileId: null,
              emailEnabled: false,
              telegramChannelChatId: null,
            },
          },
        }
      }
      return { data: {} }
    })
    await loadFeatureBundle('broadcast')

    renderWithProviders(<BroadcastPage />)
    await waitFor(() => expect(screen.getByLabelText('Edit draft')).toBeTruthy())
    await user.click(screen.getByLabelText('Edit draft'))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Save$/ })).toBeTruthy()
    })
    // And no test send here: on a saved draft that endpoint deletes the row it
    // just previewed, which would take the operator's work with it.
    expect(screen.queryByRole('button', { name: /Test send/ })).toBeNull()
  })
})
