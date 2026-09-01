import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { toast } from 'sonner'

import { usePermissionStore } from '@/features/rbac'
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


/**
 * These tests exercise the destructive affordances, so they must run as a role
 * that HOLDS `broadcasts:delete`. The screen now gates Recall and Delete on it:
 * the default `operator` role does not have it, and was being shown both
 * buttons only to collect a 403 — worst of all on Recall, which is reached for
 * exactly when a broadcast has gone out wrong and Telegram's 48-hour window is
 * running.
 */
function grantBroadcastPermissions(): void {
  usePermissionStore.setState({
    loaded: true,
    loading: false,
    granted: new Set([
      'broadcasts:view',
      'broadcasts:create',
      'broadcasts:edit',
      'broadcasts:run',
      'broadcasts:delete',
    ]),
  })
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
    grantBroadcastPermissions()
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
    grantBroadcastPermissions()
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

/**
 * Taking a broadcast back.
 *
 * The endpoint that deletes already-sent messages from recipients' chats has
 * existed from the start and nothing on this page called it. So the only way an
 * operator could react to a broadcast sent by mistake was the delete button —
 * which removes the RECORD, leaves every message where it is, and destroys the
 * ids that could have recalled them.
 */

const SENT_ROW = {
  id: 'b-9',
  audience: 'ALL',
  status: 'COMPLETED',
  successCount: 40,
  totalCount: 40,
  failedCount: 0,
  pendingCount: 0,
  canceledCount: 0,
  scheduledAt: null,
  createdAt: '2026-09-01T10:00:00.000Z',
}

describe('a sent broadcast can be taken back', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    grantBroadcastPermissions()
  })

  it('offers recall on a completed broadcast that reached somebody', async () => {
    stubList([SENT_ROW])
    await loadFeatureBundle('broadcast')

    renderWithProviders(<BroadcastPage />)

    await waitFor(() => {
      expect(screen.getByLabelText('Recall from recipients')).toBeTruthy()
    })
  })

  it('does not offer it where there is nothing to recall', async () => {
    // Mutation check: a button shown unconditionally would pass the test above.
    // On a draft there are no messages, and the endpoint 400s.
    stubList([{ ...SENT_ROW, status: 'DRAFT', successCount: 0 }])
    await loadFeatureBundle('broadcast')

    renderWithProviders(<BroadcastPage />)

    await waitFor(() => expect(screen.getByLabelText('Delete broadcast')).toBeTruthy())
    expect(screen.queryByLabelText('Recall from recipients')).toBeNull()
  })

  it('calls the recall endpoint, not the delete-the-record one', async () => {
    // The distinction is the entire point: one takes the message out of forty
    // chats, the other leaves it there and throws away the ability to.
    const user = userEvent.setup()
    stubList([SENT_ROW])
    const del = vi.spyOn(api, 'delete').mockResolvedValue({ data: { channel: 'no-post' } })
    await loadFeatureBundle('broadcast')

    renderWithProviders(<BroadcastPage />)
    await user.click(await screen.findByLabelText('Recall from recipients'))
    const dialog = await screen.findByRole('alertdialog', { name: 'Recall this broadcast?' })
    await user.click(within(dialog).getByRole('button', { name: 'Recall' }))

    await waitFor(() => {
      expect(del).toHaveBeenCalledWith('/admin/broadcast/b-9/messages')
    })
  })
})

describe('the row does not claim work that is not happening', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    grantBroadcastPermissions()
  })

  it('shows nothing pending on a recalled broadcast', async () => {
    // `total - success - failed` = 40 - 40 - 0 was 0 until the recall moved
    // rows to CANCELED and the counter was decremented; then it read 30 "still
    // delivering" for ever, on a broadcast that had finished and been withdrawn.
    stubList([{ ...SENT_ROW, pendingCount: 0, canceledCount: 30 }])
    await loadFeatureBundle('broadcast')

    renderWithProviders(<BroadcastPage />)

    // A regex, because the count renders inside its own parenthesised span.
    await waitFor(() => expect(screen.getByText(/30 recalled/)).toBeTruthy())
    expect(screen.queryByText(/still delivering/)).toBeNull()
  })

  it('still shows genuinely undispatched recipients', async () => {
    // Mutation check: hiding the number entirely would pass the test above and
    // lose the one signal that a send is stuck.
    stubList([{ ...SENT_ROW, status: 'PROCESSING', successCount: 10, pendingCount: 30 }])
    await loadFeatureBundle('broadcast')

    renderWithProviders(<BroadcastPage />)

    await waitFor(() => expect(screen.getByText(/30 still delivering/)).toBeTruthy())
  })
})

describe('the recall button disappears once there is nothing left to recall', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    grantBroadcastPermissions()
  })

  it('hides it after everything has been recalled', async () => {
    // `successCount` is how many the broadcast REACHED and a recall leaves it
    // alone on purpose — the send happened. Gating the button on it kept the
    // button lit on a fully recalled broadcast, and pressing it hit
    // "No sent messages found to delete": a red error for an action this screen
    // had just offered.
    stubList([{ ...SENT_ROW, canceledCount: 40 }])
    await loadFeatureBundle('broadcast')

    renderWithProviders(<BroadcastPage />)

    await waitFor(() => expect(screen.getByLabelText('Delete broadcast')).toBeTruthy())
    expect(screen.queryByLabelText('Recall from recipients')).toBeNull()
  })

  it('still offers it while some messages are standing', async () => {
    // Mutation check: hiding it whenever anything was recalled would strand the
    // remaining messages with no way to withdraw them.
    stubList([{ ...SENT_ROW, canceledCount: 30 }])
    await loadFeatureBundle('broadcast')

    renderWithProviders(<BroadcastPage />)

    await waitFor(() => expect(screen.getByLabelText('Recall from recipients')).toBeTruthy())
  })

  it('warns the operator when the public copy could not be taken down', async () => {
    // `unaddressable` is the likelier of the two bad outcomes: the channel post
    // exists and its message id was never recorded. Reported as a success, it
    // reproduced the whole problem — pulled from 40 private chats, still up in
    // public, green toast.
    const user = userEvent.setup()
    stubList([SENT_ROW])
    vi.spyOn(api, 'delete').mockResolvedValue({ data: { channel: 'unaddressable' } })
    const warning = vi.spyOn(toast, 'warning')
    await loadFeatureBundle('broadcast')

    renderWithProviders(<BroadcastPage />)
    await user.click(await screen.findByLabelText('Recall from recipients'))
    const dialog = await screen.findByRole('alertdialog', { name: 'Recall this broadcast?' })
    await user.click(within(dialog).getByRole('button', { name: 'Recall' }))

    await waitFor(() => expect(warning).toHaveBeenCalled())
  })
})

describe('editing a sent broadcast says what it will cost', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    grantBroadcastPermissions()
  })

  function stubDetail(promoCode: string | null) {
    return vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path === '/admin/broadcast/drafts') return { data: [SENT_ROW] }
      if (path === '/admin/broadcast/b-9') {
        return { data: { id: 'b-9', promoCode, payload: { text: 'hello', parseMode: 'HTML' } } }
      }
      return { data: {} }
    })
  }

  it('warns that the promo button will be removed', async () => {
    // Telegram treats an edit with no keyboard as "remove the keyboard", and
    // the panel cannot rebuild the promo button — the bot resolves it against a
    // Mini App url the panel does not have. The attempt to send the panel's own
    // version instead made Telegram refuse every call with a 400, so the
    // correction reached nobody. Between losing the button and losing the
    // correction, the operator gets to choose — which means being told.
    const user = userEvent.setup()
    stubDetail('SALE30')
    await loadFeatureBundle('broadcast')

    renderWithProviders(<BroadcastPage />)
    await user.click(await screen.findByLabelText('Edit broadcast'))

    await waitFor(() => {
      expect(screen.getByText(/SALE30/)).toBeTruthy()
    })
  })

  it('stays quiet on a broadcast with no promo', async () => {
    // Mutation check: a warning shown on every edit is a warning nobody reads.
    const user = userEvent.setup()
    stubDetail(null)
    await loadFeatureBundle('broadcast')

    renderWithProviders(<BroadcastPage />)
    await user.click(await screen.findByLabelText('Edit broadcast'))

    await waitFor(() => expect(screen.getByLabelText(/Message text|Текст/i)).toBeTruthy())
    expect(screen.queryByText(/Telegram drops the keyboard/)).toBeNull()
  })
})

describe('the screen offers only what this operator may actually do', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    // The DEFAULT role: view / create / edit / run, and NO delete.
    usePermissionStore.setState({
      loaded: true,
      loading: false,
      granted: new Set([
        'broadcasts:view',
        'broadcasts:create',
        'broadcasts:edit',
        'broadcasts:run',
      ]),
    })
  })

  it('hides Recall and Delete from a role without broadcasts:delete', async () => {
    // Both endpoints are gated on `broadcasts:delete` server-side and this
    // screen gated nothing, so the default role was shown both buttons and got
    // a 403 from each. Recall is the one that matters: it is bounded by
    // Telegram's 48-hour window, so it is pressed exactly when a broadcast has
    // gone out wrong and there is no time to discover the button was decorative.
    stubList([SENT_ROW])
    await loadFeatureBundle('broadcast')

    renderWithProviders(<BroadcastPage />)

    await waitFor(() => expect(screen.getByText('b-9')).toBeTruthy())
    expect(screen.queryByLabelText('Recall from recipients')).toBeNull()
    expect(screen.queryByLabelText('Delete broadcast')).toBeNull()
  })

  it('still offers what that role CAN do', async () => {
    // Mutation check: hiding everything would pass the test above and take the
    // screen away from the role that uses it most.
    stubList([{ ...SENT_ROW, failedCount: 3 }])
    await loadFeatureBundle('broadcast')

    renderWithProviders(<BroadcastPage />)

    await waitFor(() => expect(screen.getByLabelText('Edit broadcast')).toBeTruthy())
    expect(screen.getByLabelText(/Retry/)).toBeTruthy()
  })
})

describe('the recall count is what a recall can actually reach', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    grantBroadcastPermissions()
  })

  it('ignores recipients who have no Telegram message to delete', async () => {
    // A broadcast reaches web-only users through the cabinet feed: those rows
    // are SENT with no Telegram message id, and no `deleteMessage` can touch
    // them. Deriving the number from `successCount` offered to pull the message
    // from 100 chats when 60 existed — and after recalling those 60 the button
    // stayed lit over the remaining 40 for ever, 400-ing on every press.
    stubList([{ ...SENT_ROW, successCount: 100, totalCount: 100, recallableCount: 60 }])
    await loadFeatureBundle('broadcast')

    renderWithProviders(<BroadcastPage />)

    const user = userEvent.setup()
    await user.click(await screen.findByLabelText('Recall from recipients'))
    const dialog = await screen.findByRole('alertdialog', { name: 'Recall this broadcast?' })
    expect(within(dialog).getByText(/60 recipient chats/)).toBeTruthy()
  })

  it('hides the button when nothing recallable is left, even at 100 reached', async () => {
    stubList([{ ...SENT_ROW, successCount: 100, totalCount: 100, recallableCount: 0 }])
    await loadFeatureBundle('broadcast')

    renderWithProviders(<BroadcastPage />)

    await waitFor(() => expect(screen.getByLabelText('Delete broadcast')).toBeTruthy())
    expect(screen.queryByLabelText('Recall from recipients')).toBeNull()
  })
})

describe('a send in flight reports what it has actually delivered', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    grantBroadcastPermissions()
  })

  it('shows the live count, not the finaliser zero', async () => {
    // `successCount` is written once, at the end. Until then this cell showed a
    // green 0 for the whole run: half-way through 400 people it read
    // "0/400 (200 still delivering)" — 200 delivered, and nowhere on screen
    // saying so. This is the number an operator watches to decide whether a
    // send is going well, and it was the one that hid the incident.
    stubList([
      {
        ...SENT_ROW,
        status: 'PROCESSING',
        successCount: 0,
        totalCount: 400,
        deliveredCount: 200,
        pendingCount: 200,
      },
    ])
    await loadFeatureBundle('broadcast')

    renderWithProviders(<BroadcastPage />)

    await waitFor(() => expect(screen.getByText('200')).toBeTruthy())
  })

  it('falls back to the stored count when the API does not send one', async () => {
    // Mutation check: always preferring the live count would render a finished
    // broadcast as 0 against an API that predates the field.
    stubList([{ ...SENT_ROW, successCount: 40, totalCount: 40 }])
    await loadFeatureBundle('broadcast')

    renderWithProviders(<BroadcastPage />)

    await waitFor(() => expect(screen.getByText('40')).toBeTruthy())
  })
})

describe('a public channel copy keeps the recall reachable', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    grantBroadcastPermissions()
  })

  it('offers the recall when only the channel post is left', async () => {
    // A broadcast delivered only to web-only users has no Telegram message ids
    // at all, so every recipient-based count is zero — while the post anyone
    // can read is still up there. Gating on the recipient count alone left that
    // copy with no route in the panel.
    stubList([{ ...SENT_ROW, recallableCount: 0, channelPost: 'addressable' }])
    await loadFeatureBundle('broadcast')

    renderWithProviders(<BroadcastPage />)

    await waitFor(() => expect(screen.getByLabelText('Recall from recipients')).toBeTruthy())
  })

  it('does not offer it when there is nothing anywhere', async () => {
    // Mutation check: offering it whenever the broadcast is COMPLETED would put
    // the button back on rows where every press 400s.
    stubList([{ ...SENT_ROW, recallableCount: 0, channelPost: 'none' }])
    await loadFeatureBundle('broadcast')

    renderWithProviders(<BroadcastPage />)

    await waitFor(() => expect(screen.getByLabelText('Delete broadcast')).toBeTruthy())
    expect(screen.queryByLabelText('Recall from recipients')).toBeNull()
  })
})

describe('a channel copy nobody can address is still surfaced', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    grantBroadcastPermissions()
  })

  it('offers the recall so the operator learns the post has to go by hand', async () => {
    // `unaddressable` is the NORMAL state wherever the bot answers a bodiless
    // 204 and echoes no message id: the post exists and nothing here can reach
    // it. Folded into "no post", the button was hidden — so the warning that
    // says "remove it by hand" could only be reached by pressing a button that
    // was never rendered.
    stubList([{ ...SENT_ROW, recallableCount: 0, channelPost: 'unaddressable' }])
    await loadFeatureBundle('broadcast')

    renderWithProviders(<BroadcastPage />)

    await waitFor(() => expect(screen.getByLabelText('Recall from recipients')).toBeTruthy())
  })

  it('says what the action will actually touch', async () => {
    // With no recipient message left, "Deletes the message from 0 recipient
    // chats" describes nothing the press will do and never mentions the one
    // thing it will.
    const user = userEvent.setup()
    stubList([{ ...SENT_ROW, recallableCount: 0, channelPost: 'addressable' }])
    await loadFeatureBundle('broadcast')

    renderWithProviders(<BroadcastPage />)
    await user.click(await screen.findByLabelText('Recall from recipients'))
    const dialog = await screen.findByRole('alertdialog', { name: 'Recall this broadcast?' })

    expect(within(dialog).getByText(/operator channel/)).toBeTruthy()
    expect(within(dialog).queryByText(/0 recipient chats/)).toBeNull()
  })
})
