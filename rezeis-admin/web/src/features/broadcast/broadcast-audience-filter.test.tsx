/**
 * The broadcast audience filter, driven the way an operator drives it.
 *
 * `AudienceFilterDto.planIds` is a fully working backend filter
 * (`broadcast-audience.util.ts` turns it into a `planSnapshot.id` match that
 * feeds BOTH `previewAudience` and `resolveRecipients`), and the compose form
 * never set it — so "target a plan" was unreachable from the panel.
 *
 * These specs assert the REQUEST that goes out, not that a prop was passed:
 * a plan chip is only wired if `planIds` appears in the body of the draft the
 * preview counts AND the body of the draft that gets sent. Wiring one of the
 * two is the half-fix that looks right on screen.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { MockInstance } from 'vitest'

import { api } from '@/lib/api'
import { loadFeatureBundle } from '@/i18n/i18n'
import { renderWithProviders } from '@/test/test-utils'
import BroadcastPage from './broadcast-page'

const PLANS = [
  { id: 'plan-pro', name: 'Pro', isActive: true, isArchived: false, durations: [] },
  { id: 'plan-basic', name: 'Basic', isActive: true, isArchived: false, durations: [] },
]

function mockGet(recipients = 42): MockInstance {
  return vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/admin/broadcast/drafts') return { data: [] }
    if (path === '/admin/plans') return { data: PLANS }
    if (path === '/admin/broadcast/broadcast-1/audience-preview') {
      return { data: { totalRecipients: recipients } }
    }
    return { data: {} }
  }) as unknown as MockInstance
}

function mockPost(): MockInstance {
  return vi.spyOn(api, 'post').mockImplementation(async (path: string) => {
    if (path === '/admin/broadcast/drafts') return { data: { id: 'broadcast-1' } }
    return { data: {} }
  }) as unknown as MockInstance
}

/** Body of the first request this spy made to `path`. */
function bodyOf(spy: MockInstance, path: string): Record<string, unknown> {
  const call = (spy.mock.calls as unknown[][]).find((args) => args[0] === path)
  if (call === undefined) throw new Error(`no request was made to ${path}`)
  return (call[1] ?? {}) as Record<string, unknown>
}

function callsTo(spy: MockInstance, path: string): number {
  return (spy.mock.calls as unknown[][]).filter((args) => args[0] === path).length
}

async function openCompose(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup()
  await loadFeatureBundle('broadcast')
  renderWithProviders(<BroadcastPage />)
  await user.click(screen.getByRole('button', { name: 'New broadcast' }))
  return user
}

describe('broadcast audience filter — plan targeting', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('sends the selected plan as planIds on the draft that is delivered', async () => {
    mockGet()
    const postSpy = mockPost()

    const user = await openCompose()
    await user.click(await screen.findByRole('button', { name: 'Pro' }))
    await user.type(screen.getByPlaceholderText(/Enter your message here/), 'Hello')
    await user.click(screen.getByRole('button', { name: 'Create and send' }))

    await waitFor(() => {
      expect(postSpy).toHaveBeenCalledWith('/admin/broadcast/broadcast-1/send', {})
    })
    const draftBody = bodyOf(postSpy, '/admin/broadcast/drafts')
    expect(draftBody.audienceFilter).toEqual({ planIds: ['plan-pro'] })
  })

  it('leaves an unselected plan out of the payload entirely', async () => {
    // Anti-vacuity control: a build that puts every plan id in the filter
    // ("send to everyone") would satisfy the assertion above and fail here.
    mockGet()
    const postSpy = mockPost()

    const user = await openCompose()
    await user.click(await screen.findByRole('button', { name: 'Basic' }))
    await user.type(screen.getByPlaceholderText(/Enter your message here/), 'Hello')
    await user.click(screen.getByRole('button', { name: 'Create and send' }))

    await waitFor(() => {
      expect(postSpy).toHaveBeenCalledWith('/admin/broadcast/broadcast-1/send', {})
    })
    const draftBody = bodyOf(postSpy, '/admin/broadcast/drafts')
    expect(draftBody.audienceFilter).toEqual({ planIds: ['plan-basic'] })
    expect(JSON.stringify(draftBody)).not.toContain('plan-pro')
  })

  it('omits audienceFilter when no chip is selected', async () => {
    // The other half of the anti-vacuity pair: an implementation that always
    // attaches a filter would send `{ planIds: [] }` or `{}` here, and the
    // backend would read that as "no preset either".
    mockGet()
    const postSpy = mockPost()

    const user = await openCompose()
    await user.type(screen.getByPlaceholderText(/Enter your message here/), 'Hello')
    await user.click(screen.getByRole('button', { name: 'Create and send' }))

    await waitFor(() => {
      expect(postSpy).toHaveBeenCalledWith('/admin/broadcast/broadcast-1/send', {})
    })
    expect(bodyOf(postSpy, '/admin/broadcast/drafts')).not.toHaveProperty('audienceFilter')
  })

  it('carries planIds into the audience preview AND into the send', async () => {
    // The preview counts a SAVED broadcast, so the plan has to be on the row
    // the count is computed from — otherwise the operator reads a number for
    // an audience nobody will receive the broadcast.
    const getSpy = mockGet(7)
    const postSpy = mockPost()
    const patchSpy = vi.spyOn(api, 'patch').mockResolvedValue({ data: { id: 'broadcast-1' } })

    const user = await openCompose()
    await user.click(await screen.findByRole('button', { name: 'Pro' }))
    await user.click(screen.getByRole('button', { name: 'Check audience' }))

    expect(await screen.findByText('7 recipients match')).toBeInTheDocument()
    expect(bodyOf(postSpy, '/admin/broadcast/drafts').audienceFilter).toEqual({
      planIds: ['plan-pro'],
    })
    expect(getSpy).toHaveBeenCalledWith('/admin/broadcast/broadcast-1/audience-preview')

    await user.type(screen.getByPlaceholderText(/Enter your message here/), 'Hello')
    await user.click(screen.getByRole('button', { name: 'Create and send' }))

    await waitFor(() => {
      expect(postSpy).toHaveBeenCalledWith('/admin/broadcast/broadcast-1/send', {})
    })
    expect(bodyOf(patchSpy, '/admin/broadcast/drafts/broadcast-1').audienceFilter).toEqual({
      planIds: ['plan-pro'],
    })
  })

  it('sends the very draft it previewed instead of creating a second one', async () => {
    mockGet(7)
    const postSpy = mockPost()
    vi.spyOn(api, 'patch').mockResolvedValue({ data: { id: 'broadcast-1' } })

    const user = await openCompose()
    await user.click(await screen.findByRole('button', { name: 'Pro' }))
    await user.click(screen.getByRole('button', { name: 'Check audience' }))
    expect(await screen.findByText('7 recipients match')).toBeInTheDocument()

    await user.type(screen.getByPlaceholderText(/Enter your message here/), 'Hello')
    await user.click(screen.getByRole('button', { name: 'Create and send' }))

    await waitFor(() => {
      expect(postSpy).toHaveBeenCalledWith('/admin/broadcast/broadcast-1/send', {})
    })
    expect(callsTo(postSpy, '/admin/broadcast/drafts')).toBe(1)
  })

  it('withdraws the count once the filter no longer matches it', async () => {
    mockGet(7)
    mockPost()
    vi.spyOn(api, 'patch').mockResolvedValue({ data: { id: 'broadcast-1' } })

    const user = await openCompose()
    await user.click(await screen.findByRole('button', { name: 'Pro' }))
    await user.click(screen.getByRole('button', { name: 'Check audience' }))
    expect(await screen.findByText('7 recipients match')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Basic' }))

    expect(screen.queryByText('7 recipients match')).not.toBeInTheDocument()
    expect(screen.getByText('Filters changed — check again')).toBeInTheDocument()
  })

  it('clears the stored filter on the PATCH when every chip is unselected', async () => {
    // An absent `audienceFilter` key leaves the stored one untouched, so a
    // draft previewed with a plan and then cleared would still be delivered to
    // that plan. `{}` normalises back to "no filter" server-side.
    mockGet(7)
    mockPost()
    const patchSpy = vi.spyOn(api, 'patch').mockResolvedValue({ data: { id: 'broadcast-1' } })

    const user = await openCompose()
    await user.click(await screen.findByRole('button', { name: 'Pro' }))
    await user.click(screen.getByRole('button', { name: 'Check audience' }))
    expect(await screen.findByText('7 recipients match')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Pro' }))
    await user.type(screen.getByPlaceholderText(/Enter your message here/), 'Hello')
    await user.click(screen.getByRole('button', { name: 'Create and send' }))

    await waitFor(() => {
      expect(patchSpy).toHaveBeenCalled()
    })
    expect(bodyOf(patchSpy, '/admin/broadcast/drafts/broadcast-1').audienceFilter).toEqual({})
  })
})
