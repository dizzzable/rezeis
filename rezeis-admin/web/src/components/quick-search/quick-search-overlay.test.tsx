/**
 * The Cmd+K overlay's three "nothing is on screen" states.
 *
 * An operator cannot debug what the panel will not tell them, and this surface
 * had three different reasons to look blank — the query is too short, the
 * answer has not arrived, there is no answer — of which only one said anything.
 * The other two rendered an empty list or an empty message area, so "search is
 * broken" was the only available reading. These cases assert the three states
 * are DISTINGUISHABLE, not merely that the component renders.
 *
 * The two-character case is here for the same reason: the minimum is advertised
 * to the operator in `typeMore`, so it has to actually be two — an off-by-one
 * anywhere in the overlay / DTO / service chain turns a documented minimum into
 * a lie, and the overlay is where the chain starts.
 */
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { QuickSearchOverlay } from './quick-search-overlay'
import { api } from '@/lib/api'

// `t` returns the key, so the assertions name the STATE rather than a
// translated sentence that either locale is free to reword. Created ONCE:
// the overlay's `navResults` memo depends on `t`, and a fresh identity per
// render churns the `results` array into a setState-during-render loop. This
// file mocks the nav index empty, which happens to dodge that — but a stable
// `t` is what the real `useTranslation` returns, so the harness should not
// depend on the dodge.
vi.mock('react-i18next', () => {
  const translation = { t: (key: string) => key }
  return { useTranslation: () => translation }
})

// Navigation hits are computed locally and would fill the result list, hiding
// exactly the empty/loading states under test. Both index sources are emptied
// — `deepLinkNavItems` is the second one, covering routable surfaces with no
// sidebar entry; its real contents are exercised in
// `quick-search-deep-links.test.tsx`, which runs against the unmocked config.
vi.mock('@/components/layout/admin-nav-config', () => ({
  navGroups: [],
  deepLinkNavItems: [],
  canShowNavItem: () => true,
}))

vi.mock('@/features/rbac', () => ({
  usePermissionStore: (selector: (state: unknown) => unknown) =>
    selector({ loaded: true, hasPermission: () => true }),
}))

function renderOverlay() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <QuickSearchOverlay open onClose={() => {}} />
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

function typeQuery(value: string) {
  const input = screen.getByPlaceholderText('quickSearchOverlay.placeholder')
  fireEvent.change(input, { target: { value } })
}

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('QuickSearchOverlay states', () => {
  it('asks for more characters and issues no request below the minimum', async () => {
    const get = vi.spyOn(api, 'get').mockResolvedValue({ data: [] })
    renderOverlay()

    typeQuery('a')

    expect(await screen.findByText('quickSearchOverlay.typeMore')).toBeInTheDocument()
    expect(get).not.toHaveBeenCalled()
  })

  /**
   * Two spaces are two characters. The gate used to read raw `.length`, so this
   * fired a request, the backend trimmed it to nothing and answered `[]`, and
   * the overlay reported "no results for '  '" — a wasted round-trip AND the
   * wrong message.
   */
  it('treats whitespace-only input as too short rather than as no results', async () => {
    const get = vi.spyOn(api, 'get').mockResolvedValue({ data: [] })
    renderOverlay()

    typeQuery('   ')

    expect(await screen.findByText('quickSearchOverlay.typeMore')).toBeInTheDocument()
    expect(screen.queryByText('quickSearchOverlay.noResults')).not.toBeInTheDocument()
    expect(get).not.toHaveBeenCalled()
  })

  it('searches on exactly two characters', async () => {
    const get = vi.spyOn(api, 'get').mockResolvedValue({
      data: [{ type: 'promocode', id: 'promo-1', label: 'VP' }],
    })
    renderOverlay()

    typeQuery('vp')

    // Real timers and a debounced query: the default one-second wait is enough
    // on an idle machine and not enough inside the full suite, where 235 files
    // run in parallel. It failed roughly one run in three — a red build for a
    // timer, not for a defect.
    expect(await screen.findByText('VP', undefined, { timeout: 5000 })).toBeInTheDocument()
    expect(get).toHaveBeenCalledWith('/admin/quick-search', { params: { q: 'vp', limit: 12 } })
  })

  /** A pasted value keeps its padding; the request must not. */
  it('sends the trimmed query to the backend', async () => {
    const get = vi.spyOn(api, 'get').mockResolvedValue({ data: [] })
    renderOverlay()

    typeQuery('  ada  ')

    await waitFor(() => expect(get).toHaveBeenCalled())
    expect(get).toHaveBeenCalledWith('/admin/quick-search', { params: { q: 'ada', limit: 12 } })
  })

  /**
   * The state that had no render of its own. In flight with nothing to show, the
   * component fell through to the results branch and painted an empty `<ul>`:
   * a blank panel, indistinguishable from "no results" except by watching a 16px
   * spinner in the input row.
   */
  it('says it is searching while the request is in flight, then reports no results', async () => {
    let resolveRequest: ((value: { data: unknown[] }) => void) | undefined
    vi.spyOn(api, 'get').mockReturnValue(
      new Promise<{ data: unknown[] }>((resolve) => {
        resolveRequest = resolve
      }) as never,
    )
    renderOverlay()

    typeQuery('ada')

    expect(await screen.findByText('quickSearchOverlay.searching')).toBeInTheDocument()
    expect(screen.queryByText('quickSearchOverlay.noResults')).not.toBeInTheDocument()

    resolveRequest?.({ data: [] })

    expect(await screen.findByText('quickSearchOverlay.noResults')).toBeInTheDocument()
    expect(screen.queryByText('quickSearchOverlay.searching')).not.toBeInTheDocument()
  })
})
