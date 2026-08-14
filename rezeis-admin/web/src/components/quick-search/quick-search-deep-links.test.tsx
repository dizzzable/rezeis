/**
 * Deep-link page jumps in the Cmd+K overlay, end to end against the REAL nav
 * config (no `admin-nav-config` mock — the data is the thing under test).
 *
 * These eleven surfaces are routable but have no sidebar entry, so before they
 * were indexed here the only way to reach `/admins#webhooks` was to already
 * know the URL. The three things that have to hold: the row appears, it is
 * hidden from a role that cannot use it, and clicking it lands on the ANCHOR
 * rather than on the parent page.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { QuickSearchOverlay } from './quick-search-overlay'
import { api } from '@/lib/api'

/**
 * `t` is created once, like the real `useTranslation` — react-i18next memoises
 * it per namespace/language, so it does not change identity between renders.
 * The overlay's `navResults` memo lists `t` as a dependency, so a fresh `t` per
 * render recomputes the memo every render, gives `results` a new array identity
 * every render, and drives the `prevResults` check into setState-during-render:
 * "Too many re-renders", the React #301 loop the overlay's comments describe.
 * Purely a harness artefact, but an expensive one to misread as a real bug.
 */
vi.mock('react-i18next', () => {
  const translation = { t: (key: string) => key }
  return { useTranslation: () => translation }
})

const permissionState = vi.hoisted(() => ({
  loaded: true,
  granted: new Set<string>(),
}))

/**
 * `hasPermission` and the state object are created ONCE, not per render.
 *
 * This mirrors the real store, where `hasPermission` is defined in the zustand
 * creator and reads current state through `get()` — its identity never changes
 * (`use-permission-store.ts:115`). A mock that returned a fresh closure per
 * render would make the overlay's `navResults` memo recompute every render,
 * hand `results` a new array identity every render, and trip the
 * `prevResults` check into setState-during-render — "Too many re-renders",
 * which is the React error #301 the overlay's own comments describe. That
 * failure would be entirely an artefact of the harness and would say nothing
 * about the component.
 */
vi.mock('@/features/rbac', () => {
  const hasPermission = (resource: string, action: string) =>
    permissionState.granted.has(`${resource}:${action}`)
  const state = { loaded: permissionState.loaded, hasPermission }
  return {
    usePermissionStore: (selector: (value: unknown) => unknown) => {
      state.loaded = permissionState.loaded
      return selector(state)
    },
  }
})

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
  permissionState.loaded = true
  permissionState.granted = new Set()
  vi.spyOn(api, 'get').mockResolvedValue({ data: [] })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Cmd+K deep-link page jumps', () => {
  it('offers a tab-only surface that has no sidebar entry', async () => {
    permissionState.granted = new Set(['webhooks:view'])
    renderOverlay()

    typeQuery('webhooks')

    expect(await screen.findByText('adminNav.items.webhooks')).toBeInTheDocument()
  })

  /**
   * The whole point of the anchor. Navigating to `/admins` alone drops the
   * operator on the Admins list and makes them hunt for the tab — which is the
   * state this change exists to end.
   */
  it('navigates to the anchor, not just the parent page', async () => {
    permissionState.granted = new Set(['webhooks:view'])
    renderOverlay()

    typeQuery('webhooks')
    fireEvent.click(await screen.findByText('adminNav.items.webhooks'))

    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent('/admins#webhooks'),
    )
  })

  /**
   * Written as a differential — same query, two roles — because the absence of
   * a row proves nothing on its own: it is equally satisfied by an overlay that
   * rendered nothing at all. The granted half establishes the row exists and is
   * findable; the denied half is then a real statement about the gate.
   *
   * Both halves are deliberately synchronous. Page jumps are computed locally
   * from the nav index and never wait on the network, so asserting through
   * `findByText('…noResults')` would hang this on an unrelated request settling
   * inside a 1s default timeout — a race that reads as a flaky gate.
   */
  it('hides a deep link from an admin without its permission', async () => {
    permissionState.granted = new Set(['webhooks:view'])
    const granted = renderOverlay()
    typeQuery('webhooks')
    expect(await screen.findByText('adminNav.items.webhooks')).toBeInTheDocument()
    granted.unmount()

    permissionState.granted = new Set()
    renderOverlay()
    typeQuery('webhooks')
    expect(screen.queryByText('adminNav.items.webhooks')).not.toBeInTheDocument()
  })

  /**
   * The documented exception: the Security tab carries no `PermissionGate` in
   * `panel-settings-hub.tsx`, so gating its row would hide a page every admin
   * can open.
   */
  it('shows the ungated two-factor jump to an admin holding nothing', async () => {
    permissionState.granted = new Set()
    renderOverlay()

    typeQuery('twofactor')

    expect(await screen.findByText('adminNav.items.twoFactor')).toBeInTheDocument()
  })

  /** A real route rather than a hash anchor — it must still be offered. */
  it('offers the API tokens page, which is a route rather than an anchor', async () => {
    permissionState.granted = new Set(['api_tokens:view'])
    renderOverlay()

    typeQuery('apitokens')

    expect(await screen.findByText('adminNav.items.apiTokens')).toBeInTheDocument()
  })

  /** Sidebar pages must keep working — the second index is additive. */
  it('still offers ordinary sidebar pages', async () => {
    renderOverlay()

    typeQuery('promocodes')

    expect(await screen.findByText('adminNav.items.promocodes')).toBeInTheDocument()
  })
})
