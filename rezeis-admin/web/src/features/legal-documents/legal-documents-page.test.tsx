import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { loadFeatureBundle } from '@/i18n/i18n'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import LegalDocumentsPage from './legal-documents-page'

/**
 * The two guards on this page are about the ways it fails, not the way it
 * works.
 *
 * Switching a document on before writing it would be refused by the server —
 * and a refused save on a settings page reads as "saving is broken", far from
 * the empty textarea that caused it. So the control is disabled until the text
 * exists, and it says why.
 *
 * An active document with no English text still works: an English reader is
 * served the Russian wording rather than a blank page. That is the right
 * fallback and the wrong thing to do silently.
 */

function document(overrides: Record<string, unknown> = {}) {
  return {
    key: 'USER_AGREEMENT',
    isActive: false,
    titleRu: '',
    titleEn: '',
    bodyRu: '',
    bodyEn: '',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function mockList(documents: Array<Record<string, unknown>>) {
  vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/admin/legal-documents') return { data: documents }
    return { data: {} }
  })
}

describe('LegalDocumentsPage', () => {
  beforeEach(async () => {
    vi.restoreAllMocks()
    // The router loads this bundle through `withFeatureBundle` before the page
    // renders; without it every assertion below would match a raw key instead
    // of the copy an operator actually reads.
    await loadFeatureBundle('legalDocuments')
  })

  it('will not let an operator require a document that has no text yet', async () => {
    mockList([document()])

    renderWithProviders(<LegalDocumentsPage />)

    const toggle = await screen.findByRole('switch', { name: 'Require at sign-up' })
    expect(toggle).toBeDisabled()
    expect(screen.getByText('Fill in the Russian title and text first')).toBeInTheDocument()
  })

  /**
   * The title is the checkbox label a visitor reads at sign-up. A document with
   * text but no name would ask them to accept something unnamed, so the body
   * alone does not unlock the switch.
   */
  it('will not let an operator require a document that has text but no title', async () => {
    mockList([document({ bodyRu: 'Условия использования.' })])

    renderWithProviders(<LegalDocumentsPage />)

    expect(await screen.findByRole('switch', { name: 'Require at sign-up' })).toBeDisabled()
  })

  it('shows a retry instead of an empty page when the list fails to load', async () => {
    // An empty page reads as "no documents configured" — the one thing this
    // page must never imply, since it decides whether sign-up asks for consent.
    vi.spyOn(api, 'get').mockRejectedValue(new Error('boom'))

    renderWithProviders(<LegalDocumentsPage />)

    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('enables the requirement toggle once Russian text is typed', async () => {
    const user = userEvent.setup()
    mockList([document()])

    renderWithProviders(<LegalDocumentsPage />)

    const bodyRu = await screen.findByLabelText('Text', { selector: '#body-ru-USER_AGREEMENT' })
    await user.type(bodyRu, 'Условия использования.')
    await user.type(
      screen.getByLabelText('Title', { selector: '#title-ru-USER_AGREEMENT' }),
      'Соглашение',
    )

    expect(screen.getByRole('switch', { name: 'Require at sign-up' })).toBeEnabled()
  })

  it('warns that an active document with no English text falls back to Russian', async () => {
    mockList([document({ isActive: true, titleRu: 'Соглашение', bodyRu: 'Условия использования.' })])

    renderWithProviders(<LegalDocumentsPage />)

    expect(
      await screen.findByText(/the English text is empty/i),
    ).toBeInTheDocument()
  })

  it('stays quiet when both translations are filled in', async () => {
    mockList([
      document({
        isActive: true,
        titleRu: 'Соглашение',
        bodyRu: 'Условия использования.',
        bodyEn: 'Terms of use.',
      }),
    ])

    renderWithProviders(<LegalDocumentsPage />)

    await screen.findByRole('switch', { name: 'Require at sign-up' })
    expect(screen.queryByText(/the English text is empty/i)).not.toBeInTheDocument()
  })

  it('keeps saving disabled until something actually changes', async () => {
    const user = userEvent.setup()
    mockList([document({ titleRu: 'Соглашение', bodyRu: 'Условия использования.' })])

    renderWithProviders(<LegalDocumentsPage />)

    const save = await screen.findByRole('button', { name: 'Save' })
    expect(save).toBeDisabled()

    await user.type(
      screen.getByLabelText('Title', { selector: '#title-ru-USER_AGREEMENT' }),
      'Соглашение',
    )

    expect(save).toBeEnabled()
  })
})
