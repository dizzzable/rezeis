/**
 * What happens when the operator picks a SETTING rather than a page.
 *
 * The engine's own answers are tested against the real dictionary in
 * `search-engine.test.ts`; this file tests the wiring around them, which is
 * where a setting row differs from a page row: it has to carry its `#tab` into
 * the address, and it has to ask for the control to be marked once the page
 * renders. The engine is stubbed here on purpose — a fixed hit is the only way
 * to assert "this exact row leads exactly there".
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { QuickSearchOverlay } from './quick-search-overlay'
import { api } from '@/lib/api'

vi.mock('react-i18next', () => {
  const translation = { t: (key: string) => key, i18n: { language: 'en' } }
  return { useTranslation: () => translation }
})

vi.mock('@/features/rbac', () => {
  const hasPermission = () => true
  const state = { loaded: true, hasPermission }
  return { usePermissionStore: (selector: (value: unknown) => unknown) => selector(state) }
})

const flashTextOnPage = vi.hoisted(() => vi.fn())
vi.mock('@/lib/flash-on-page', () => ({ flashTextOnPage }))

/** One hit, fixed: «Секретный ключ» on the Webhooks tab of Payments. */
const SETTING_HIT = {
  score: 1.4,
  entry: {
    key: 'paymentsReconciliation.fields.secret',
    text: 'Секретный ключ {{gateway}}',
    weight: 1,
    isPage: false,
    target: {
      path: '/payments#webhooks',
      nav: { key: 'payments', path: '/payments', icon: () => null },
      groupKey: 'operations',
      labelKey: 'paymentsPage.tabs.webhooks',
      parentLabelKey: 'adminNav.items.payments',
    },
  },
}

vi.mock('./search-engine', () => ({
  ensureSearchIndex: () =>
    Promise.resolve({
      locale: 'en',
      entries: [],
      entryText: [],
      wordToEntries: new Map(),
      sortedWords: [],
    }),
  queryIndex: () => [SETTING_HIT],
}))

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="location">{location.pathname + location.hash}</div>
}

function renderOverlay() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MemoryRouter initialEntries={['/']}>
      <QueryClientProvider client={queryClient}>
        <LocationProbe />
        <QuickSearchOverlay open onClose={() => {}} />
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

function typeQuery(value: string) {
  fireEvent.change(screen.getByPlaceholderText('quickSearchOverlay.placeholder'), {
    target: { value },
  })
}

beforeEach(() => {
  flashTextOnPage.mockClear()
  vi.spyOn(api, 'get').mockResolvedValue({ data: [] })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('a setting row', () => {
  it('says which page and which tab it lives on', async () => {
    renderOverlay()
    typeQuery('ключ')

    // «Платежи → Вебхуки», so the operator knows where they are being sent
    // before they go.
    expect(
      await screen.findByTitle('adminNav.items.payments → paymentsPage.tabs.webhooks'),
    ).toBeInTheDocument()
  })

  it('shows the text without its interpolation machinery', async () => {
    renderOverlay()
    typeQuery('ключ')

    expect(await screen.findByTitle('Секретный ключ …')).toBeInTheDocument()
  })

  it('opens the tab it lives on, not just the page', async () => {
    renderOverlay()
    typeQuery('ключ')
    fireEvent.click(await screen.findByTitle('Секретный ключ …'))

    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent('/payments#webhooks'),
    )
  })

  /**
   * The placeholder is where a NUMBER or a name will be, so the page never
   * contains the string as the dictionary wrote it. What is looked for is the
   * longest literal run — the part the page does render.
   */
  it('asks for the control to be marked, by the words the page will show', async () => {
    renderOverlay()
    typeQuery('ключ')
    fireEvent.click(await screen.findByTitle('Секретный ключ …'))

    expect(flashTextOnPage).toHaveBeenCalledWith('Секретный ключ')
  })
})
