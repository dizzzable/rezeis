import type { MockedFunction } from 'vitest'
import { QueryClientProvider } from '@tanstack/react-query'
import { render, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { RouterProvider, createMemoryRouter } from 'react-router-dom'
import { appRoutes, getHeaderContextLabel } from '@/app/router'
import { useAuthSession } from '@/features/auth/auth-provider'
import { createQueryClient } from '@/lib/query-client'

vi.mock('@/features/auth/auth-provider', () => ({
  useAuthSession: vi.fn(),
}))

vi.mock('@/features/dashboard/dashboard-page', () => ({
  DashboardPage: () => <div>Dashboard page</div>,
}))

vi.mock('@/features/plans/plans-page', () => ({
  PlansPage: () => <div>Plans page</div>,
}))

vi.mock('@/features/subscription/subscription-page', () => ({
  SubscriptionPage: () => <div>Subscription page</div>,
}))

vi.mock('@/features/web-account/web-account-page', () => ({
  WebAccountPage: () => <div>Web account page</div>,
}))

function createAuthSession(overrides: Partial<ReturnType<typeof useAuthSession>> = {}): ReturnType<typeof useAuthSession> {
  return {
    status: 'authentication-required',
    sessionQuery: {
      data: undefined,
      error: null,
      isPending: false,
    },
    bootstrapError: null,
    hasSessionPersistenceIssue: false,
    telegramWebApp: null,
    hasTelegramLaunch: false,
    canBootstrapWithTelegram: false,
    ...overrides,
  } as ReturnType<typeof useAuthSession>
}

function renderRouter({ route = '/', authSession }: { readonly route?: string; readonly authSession: ReturnType<typeof useAuthSession> }) {
  const mockedUseAuthSession: MockedFunction<typeof useAuthSession> = vi.mocked(useAuthSession)
  mockedUseAuthSession.mockReturnValue(authSession)
  const router = createMemoryRouter(appRoutes, {
    initialEntries: [route],
  })
  const queryClient = createQueryClient({ isTest: true })
  const renderResult = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return {
    ...renderResult,
    router,
  }
}

describe('getHeaderContextLabel', () => {
  it('returns route and session labels for the remaining branches', () => {
    expect(getHeaderContextLabel({ authSession: createAuthSession(), pathname: '/plans' })).toBe('Public plan catalog')
    expect(
      getHeaderContextLabel({
        authSession: createAuthSession({
          status: 'authenticated',
          sessionQuery: {
            data: {
              id: 'session-id',
              webAccount: {
                login: 'linked-login',
              },
              username: 'ruid-user',
              email: 'user@rezeis.test',
            },
          },
        }),
        pathname: '/',
      }),
    ).toBe('linked-login')
    expect(getHeaderContextLabel({ authSession: createAuthSession({ status: 'loading', canBootstrapWithTelegram: true }), pathname: '/' })).toBe('Bootstrapping Telegram session')
    expect(getHeaderContextLabel({ authSession: createAuthSession({ status: 'loading', canBootstrapWithTelegram: false }), pathname: '/' })).toBe('Checking cookie session')
    expect(getHeaderContextLabel({ authSession: createAuthSession({ status: 'error' }), pathname: '/' })).toBe('Session error')
    expect(getHeaderContextLabel({ authSession: createAuthSession({ hasTelegramLaunch: true }), pathname: '/' })).toBe('Telegram launch detected')
    expect(getHeaderContextLabel({ authSession: createAuthSession({ hasTelegramLaunch: false }), pathname: '/' })).toBe('Authentication required')
  })
})

describe('router shell', () => {
  it('renders the production plans route and only marks Plans as active on /plans', () => {
    const { getByText, getByRole } = renderRouter({
      route: '/plans',
      authSession: createAuthSession(),
    })

    expect(getByText('Plans page')).toBeInTheDocument()
    expect(getByText('Public plan catalog')).toBeInTheDocument()
    expect(getByText('Route context')).toBeInTheDocument()
    expect(getByText('This web app reads the user API for account, plan, subscription, and platform policy data. Its live write paths now cover rules acceptance, linked web-account login and password follow-up, linked email-verification challenge issuance, and linked email-verification completion. The dedicated plans and subscription routes remain the primary read surfaces, while the dashboard may also show compact summaries and diagnostics.')).toBeInTheDocument()
    expect(getByRole('link', { name: /Dashboard/i })).not.toHaveClass('bg-primary')
    expect(getByRole('link', { name: /Plans/i })).toHaveClass('bg-primary')
  })

  it('renders the production subscription route and only marks Subscription as active on /subscription', () => {
    const { getByText, getByRole } = renderRouter({
      route: '/subscription',
      authSession: createAuthSession(),
    })

    expect(getByText('Subscription page')).toBeInTheDocument()
    expect(getByRole('link', { name: /Dashboard/i })).not.toHaveClass('bg-primary')
    expect(getByRole('link', { name: /Subscription/i })).toHaveClass('bg-primary')
  })

  it('renders the authenticated web-account route when navigated directly', () => {
    const { getByText } = renderRouter({
      route: '/web-account',
      authSession: createAuthSession(),
    })

    expect(getByText('Web account page')).toBeInTheDocument()
  })
})

describe('AppShell', () => {
  it('calls ready once and expands when the Telegram shell is not expanded yet', async () => {
    const ready = vi.fn()
    const expand = vi.fn()
    const telegramWebApp = {
      initData: 'telegram-init-data',
      isExpanded: false,
      ready,
      expand,
    }
    const { router } = renderRouter({
      route: '/',
      authSession: createAuthSession({ telegramWebApp }),
    })

    await router.navigate('/plans')
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/plans')
    })

    expect(ready).toHaveBeenCalledTimes(1)
    expect(expand).toHaveBeenCalledTimes(1)
  })

  it('does not expand an already expanded Telegram shell', () => {
    const ready = vi.fn()
    const expand = vi.fn()

    renderRouter({
      route: '/plans',
      authSession: createAuthSession({
        telegramWebApp: {
          initData: 'telegram-init-data',
          isExpanded: true,
          ready,
          expand,
        },
      }),
    })

    expect(ready).toHaveBeenCalledTimes(1)
    expect(expand).not.toHaveBeenCalled()
  })
})
