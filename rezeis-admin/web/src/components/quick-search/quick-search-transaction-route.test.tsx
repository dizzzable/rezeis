/**
 * A Cmd+K payment hit opens THAT payment.
 *
 * The overlay routed every `transaction` hit to a bare `/payments`: the operator
 * searched for one payment by its id, pressed Enter, and landed on the full
 * ledger with nothing selected — to search for it a second time. The hit's id
 * is the payment's `paymentId` (`quick-search.service.ts`, `searchTransactions`),
 * and the Payments page opens a payment's details from `?payment=`.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { describe, expect, it, vi } from 'vitest'

import { QuickSearchOverlay } from './quick-search-overlay'

vi.mock('react-i18next', () => {
  const translation = { t: (key: string) => key }
  return { useTranslation: () => translation }
})

// Page-jump hits are computed locally and would sit above the data hit under test.
vi.mock('@/components/layout/admin-nav-config', () => ({
  navGroups: [],
  deepLinkNavItems: [],
  canShowNavItem: () => true,
}))

vi.mock('@/features/rbac', () => ({
  usePermissionStore: (selector: (state: unknown) => unknown) =>
    selector({ loaded: true, hasPermission: () => true }),
}))

const PAYMENT_ID = 'cmfk2x9pq0011abcd1234efgh'

function Destination() {
  const location = useLocation()
  return <output data-testid="destination">{`${location.pathname}${location.search}`}</output>
}

function renderOverlayWith(results: unknown[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(['quick-search', 'cmfk2x'], results)
  const onClose = vi.fn()
  render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <QueryClientProvider client={queryClient}>
        <Routes>
          <Route path="*" element={<Destination />} />
        </Routes>
        <QuickSearchOverlay open onClose={onClose} />
      </QueryClientProvider>
    </MemoryRouter>,
  )
  fireEvent.change(screen.getByPlaceholderText('quickSearchOverlay.placeholder'), {
    target: { value: 'cmfk2x' },
  })
  return { onClose }
}

describe('QuickSearchOverlay payment hits', () => {
  it('opens the payment it found, not the whole Payments page', async () => {
    const { onClose } = renderOverlayWith([
      { type: 'transaction', id: PAYMENT_ID, label: 'YOOKASSA · 299 RUB', subtitle: 'COMPLETED' },
    ])

    fireEvent.click(await screen.findByText('YOOKASSA · 299 RUB'))

    await waitFor(() =>
      expect(screen.getByTestId('destination')).toHaveTextContent(`/payments?payment=${PAYMENT_ID}`),
    )
    expect(onClose).toHaveBeenCalled()
  })

  it('opens it from the keyboard too', async () => {
    renderOverlayWith([{ type: 'transaction', id: PAYMENT_ID, label: 'YOOKASSA · 299 RUB' }])
    await screen.findByText('YOOKASSA · 299 RUB')

    fireEvent.keyDown(screen.getByPlaceholderText('quickSearchOverlay.placeholder'), { key: 'Enter' })

    await waitFor(() =>
      expect(screen.getByTestId('destination')).toHaveTextContent(`/payments?payment=${PAYMENT_ID}`),
    )
  })

  it('leaves the other hit types where they went', async () => {
    renderOverlayWith([{ type: 'user', id: 'cmfk2x9pq0000abcd1234efgh', label: 'Alice' }])

    fireEvent.click(await screen.findByText('Alice'))

    await waitFor(() =>
      expect(screen.getByTestId('destination')).toHaveTextContent('/users/cmfk2x9pq0000abcd1234efgh'),
    )
  })
})
