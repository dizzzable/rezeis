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
