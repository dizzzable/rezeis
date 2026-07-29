import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import FaqPage from './faq-page'

function createDeferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (reason?: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

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
    const fileInput = screen.getByLabelText('Choose FAQ media files', { selector: 'input' })
    expect(fileInput.getAttribute('accept')).toContain('video/mp4')
    expect(fileInput.getAttribute('accept')).not.toContain('image/svg+xml')
  })

  it('keeps the form open and Save disabled until a pending media upload is included', async () => {
    const user = userEvent.setup()
    const upload = createDeferred<{
      data: {
        url: string
        originalName: string
        mimeType: string
        mediaType: 'video'
        size: number
      }
    }>()
    const postSpy = vi.spyOn(api, 'post').mockReturnValue(upload.promise as never)
    const patchSpy = vi.spyOn(api, 'patch').mockResolvedValue({ data: {} })

    renderWithProviders(<FaqPage />)

    expect(await screen.findByText('How do I start?')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Edit entry' }))

    const dialog = screen.getByRole('dialog', { name: 'Edit entry' })
    const fileInput = within(dialog).getByLabelText('Choose FAQ media files', {
      selector: 'input',
    })
    await user.upload(fileInput, new File(['video'], 'guide.mp4', { type: 'video/mp4' }))

    await waitFor(() => {
      expect(postSpy).toHaveBeenCalledWith(
        '/admin/faq/uploads',
        expect.any(FormData),
        expect.objectContaining({ headers: { 'Content-Type': 'multipart/form-data' } }),
      )
    })

    const saveButton = within(dialog).getByRole('button', { name: 'Save' })
    const cancelButton = within(dialog).getByRole('button', { name: 'Cancel' })
    expect(saveButton).toBeDisabled()
    expect(saveButton).toHaveAttribute('aria-busy', 'true')
    expect(cancelButton).toBeDisabled()

    await user.click(saveButton)
    await user.click(within(dialog).getByRole('button', { name: 'Close' }))
    expect(patchSpy).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Edit entry' })).toBeInTheDocument()

    upload.resolve({
      data: {
        url: '/uploads/faq/guide.mp4',
        originalName: 'guide.mp4',
        mimeType: 'video/mp4',
        mediaType: 'video',
        size: 5,
      },
    })

    await waitFor(() => expect(saveButton).toBeEnabled())
    expect(saveButton).toHaveAttribute('aria-busy', 'false')
    expect(cancelButton).toBeEnabled()

    await user.click(saveButton)
    await waitFor(() => {
      expect(patchSpy).toHaveBeenCalledWith(
        '/admin/faq/faq-1',
        expect.objectContaining({ mediaUrls: ['/uploads/faq/guide.mp4'] }),
      )
    })
  })

  it('restores form actions after a media upload error', async () => {
    const user = userEvent.setup()
    const upload = createDeferred<never>()
    vi.spyOn(api, 'post').mockReturnValue(upload.promise)

    renderWithProviders(<FaqPage />)

    expect(await screen.findByText('How do I start?')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Edit entry' }))

    const dialog = screen.getByRole('dialog', { name: 'Edit entry' })
    const fileInput = within(dialog).getByLabelText('Choose FAQ media files', {
      selector: 'input',
    })
    await user.upload(fileInput, new File(['video'], 'broken.mp4', { type: 'video/mp4' }))

    const saveButton = within(dialog).getByRole('button', { name: 'Save' })
    const cancelButton = within(dialog).getByRole('button', { name: 'Cancel' })
    await waitFor(() => expect(saveButton).toBeDisabled())

    upload.reject(new Error('upload failed'))

    await waitFor(() => expect(saveButton).toBeEnabled())
    expect(cancelButton).toBeEnabled()
  })
})
