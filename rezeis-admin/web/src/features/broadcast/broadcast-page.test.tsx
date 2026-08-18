import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { api } from '@/lib/api'
import { loadFeatureBundle } from '@/i18n/i18n'
import { renderWithProviders } from '@/test/test-utils'
import BroadcastPage from './broadcast-page'

describe('BroadcastPage create form validation', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('blocks malformed media URLs before creating a broadcast draft', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path === '/admin/broadcast/drafts') return { data: [] }
      return { data: {} }
    })
    const postSpy = vi.spyOn(api, 'post').mockResolvedValue({ data: { id: 'broadcast-1' } })
    await loadFeatureBundle('broadcast')

    renderWithProviders(<BroadcastPage />)

    await user.click(screen.getByRole('button', { name: 'New broadcast' }))
    await user.type(screen.getByPlaceholderText(/Enter your message here/), 'Hello')
    await user.click(screen.getByRole('button', { name: /Photo/ }))
    await user.click(screen.getByRole('button', { name: 'URL' }))
    await user.type(screen.getByPlaceholderText('https://example.com/Photo.jpg'), 'ftp://example.com/image.jpg')
    await user.click(screen.getByRole('button', { name: 'Create and send' }))

    expect(await screen.findByText('Enter a valid HTTP(S) media URL.')).toBeInTheDocument()
    expect(postSpy).not.toHaveBeenCalled()
  })

  it('names the icon-only refresh action', async () => {
    vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path === '/admin/broadcast/drafts') return { data: [] }
      return { data: {} }
    })
    await loadFeatureBundle('broadcast')

    renderWithProviders(<BroadcastPage />)

    expect(await screen.findByRole('button', { name: 'Refresh broadcasts' })).toBeInTheDocument()
  })

  it('names broadcast compose audience and message controls', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path === '/admin/broadcast/drafts') return { data: [] }
      return { data: {} }
    })
    await loadFeatureBundle('broadcast')

    renderWithProviders(<BroadcastPage />)

    await user.click(screen.getByRole('button', { name: 'New broadcast' }))

    expect(await screen.findByRole('combobox', { name: 'Audience' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Message text' })).toBeInTheDocument()
  })

  it('makes the upload dropzone keyboard-operable and named', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path === '/admin/broadcast/drafts') return { data: [] }
      return { data: {} }
    })
    await loadFeatureBundle('broadcast')

    renderWithProviders(<BroadcastPage />)

    await user.click(screen.getByRole('button', { name: 'New broadcast' }))
    await user.click(screen.getByRole('button', { name: /Photo/ }))

    expect(screen.getByRole('button', { name: 'Choose media file' })).toBeInTheDocument()
  })

  it('submits normalized payload through the current draft and send endpoints', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path === '/admin/broadcast/drafts') return { data: [] }
      return { data: {} }
    })
    const postSpy = vi.spyOn(api, 'post').mockImplementation(async (path: string) => {
      if (path === '/admin/broadcast/drafts') return { data: { id: 'broadcast-1' } }
      if (path === '/admin/broadcast/broadcast-1/send') return { data: { jobId: 'job-1' } }
      return { data: {} }
    })
    await loadFeatureBundle('broadcast')

    renderWithProviders(<BroadcastPage />)

    await user.click(screen.getByRole('button', { name: 'New broadcast' }))
    await user.type(screen.getByPlaceholderText(/Enter your message here/), ' Hello subscribers ')
    await user.click(screen.getByRole('button', { name: /Photo/ }))
    await user.click(screen.getByRole('button', { name: 'URL' }))
    await user.type(screen.getByPlaceholderText('https://example.com/Photo.jpg'), ' https://cdn.example.com/banner.jpg ')
    await user.click(screen.getByRole('button', { name: 'Create and send' }))

    await waitFor(() => {
      expect(postSpy).toHaveBeenCalledWith('/admin/broadcast/drafts', {
        audience: 'ALL',
        payload: {
          text: 'Hello subscribers',
          mediaType: 'photo',
          mediaFileId: 'https://cdn.example.com/banner.jpg',
        },
      })
    })
    expect(postSpy).toHaveBeenCalledWith('/admin/broadcast/broadcast-1/send', {})
  })

  it('shows the recipients that are neither delivered nor failed yet', async () => {
    // `SENT` now means a delivery the reiwa relay proved, so a broadcast in
    // flight has three populations, not two: delivered, given up on, and still
    // being retried after a transport failure. Showing only the first two
    // renders the third as "not delivered" — an unknown displayed as one of
    // the extremes, which is the same kind of claim the status change removed
    // from the backend.
    vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path === '/admin/broadcast/drafts') {
        return {
          data: [
            {
              id: 'broadcast-1',
              audience: 'ALL',
              status: 'PROCESSING',
              successCount: 5,
              totalCount: 9,
              failedCount: 1,
              createdAt: '2026-06-04T10:00:00.000Z',
            },
          ],
        }
      }
      return { data: {} }
    })
    await loadFeatureBundle('broadcast')

    renderWithProviders(<BroadcastPage />)

    expect(await screen.findByText('(1 failed)')).toBeInTheDocument()
    expect(screen.getByText('(3 still delivering)')).toBeInTheDocument()
  })

  it('shows no in-flight count once every recipient is accounted for', async () => {
    // The counterpart: a finished broadcast must not grow a permanent
    // "still delivering" that never resolves.
    vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path === '/admin/broadcast/drafts') {
        return {
          data: [
            {
              id: 'broadcast-1',
              audience: 'ALL',
              status: 'COMPLETED',
              successCount: 6,
              totalCount: 9,
              failedCount: 3,
              createdAt: '2026-06-04T10:00:00.000Z',
            },
          ],
        }
      }
      return { data: {} }
    })
    await loadFeatureBundle('broadcast')

    renderWithProviders(<BroadcastPage />)

    expect(await screen.findByText('(3 failed)')).toBeInTheDocument()
    expect(screen.queryByText(/still delivering/)).not.toBeInTheDocument()
  })

  it('confirms before deleting a completed broadcast draft', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path === '/admin/broadcast/drafts') {
        return {
          data: [
            {
              id: 'broadcast-1',
              audience: 'ALL',
              status: 'COMPLETED',
              successCount: 8,
              totalCount: 8,
              failedCount: 0,
              createdAt: '2026-06-04T10:00:00.000Z',
            },
          ],
        }
      }
      return { data: {} }
    })
    const deleteSpy = vi.spyOn(api, 'delete').mockResolvedValue({ data: {} })
    await loadFeatureBundle('broadcast')

    renderWithProviders(<BroadcastPage />)

    await user.click(await screen.findByRole('button', { name: 'Delete broadcast' }))

    const dialog = await screen.findByRole('alertdialog', { name: 'Delete broadcast?' })
    expect(within(dialog).getByText('Delete this broadcast?')).toBeInTheDocument()
    expect(deleteSpy).not.toHaveBeenCalled()

    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))

    await waitFor(() => {
      expect(deleteSpy).toHaveBeenCalledWith('/admin/broadcast/broadcast-1')
    })
  })
})
