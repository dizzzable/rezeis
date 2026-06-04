import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import FaqPage from './faq-page'

describe('FaqPage accessibility', () => {
  beforeEach(() => {
    vi.spyOn(api, 'get').mockResolvedValue({
      data: [
        {
          id: 'faq-1',
          question: 'How do I start?',
          answer: 'Open the app and sign in.',
          mediaUrls: [],
          orderIndex: 1,
          isActive: true,
          locale: null,
          createdAt: '2026-06-04T00:00:00.000Z',
          updatedAt: '2026-06-04T00:00:00.000Z',
        },
      ],
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('uses an accessible alert dialog before deleting an FAQ entry', async () => {
    const user = userEvent.setup()
    const deleteSpy = vi.spyOn(api, 'delete').mockResolvedValue({ data: {} })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)

    renderWithProviders(<FaqPage />)

    expect(await screen.findByText('How do I start?')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Delete entry' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete FAQ entry?' })
    expect(dialog).toHaveTextContent('Delete "How do I start?"?')

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(deleteSpy).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Delete entry' }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(deleteSpy).toHaveBeenCalledWith('/admin/faq/faq-1'))
    expect(confirmSpy).not.toHaveBeenCalled()
  })

  it('makes FAQ media upload and remove actions keyboard-operable and named', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockResolvedValue({
      data: [
        {
          id: 'faq-1',
          question: 'How do I start?',
          answer: 'Open the app and sign in.',
          mediaUrls: ['https://cdn.example.com/help.png'],
          orderIndex: 1,
          isActive: true,
          locale: null,
          createdAt: '2026-06-04T00:00:00.000Z',
          updatedAt: '2026-06-04T00:00:00.000Z',
        },
      ],
    })

    renderWithProviders(<FaqPage />)

    expect(await screen.findByText('How do I start?')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Edit entry' }))

    expect(screen.getByRole('button', { name: 'Choose FAQ media files' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove media attachment' })).toBeInTheDocument()
  })
})
