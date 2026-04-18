import { QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, waitFor, type RenderResult } from '@testing-library/react'
import { MemoryRouter, RouterProvider, createMemoryRouter } from 'react-router-dom'
import { AxiosError } from 'axios'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { appRoutes } from '@/app/router'
import { AuthProvider } from '@/features/auth/auth-provider'
import { sessionApi } from '@/features/session/session-api'
import { DashboardPage } from '@/features/dashboard/dashboard-page'
import * as authProvider from '@/features/auth/auth-provider'
import { usePlansQuery } from '@/features/plans/use-plans-query'
import { usePlatformPolicyQuery } from '@/features/platform-policy/use-platform-policy-query'
import { useSubscriptionQuery } from '@/features/subscription/use-subscription-query'
import { createQueryClient } from '@/lib/query-client'
import { renderWithProviders } from '@/test/render-app'

vi.mock('@/features/auth/telegram-web-app', () => ({
  getTelegramBootstrapInitData: () => null,
  getTelegramLaunchInitData: () => null,
  getTelegramWebApp: () => null,
  loadTelegramWebAppScript: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/features/plans/use-plans-query', () => ({
  usePlansQuery: vi.fn(),
}))

vi.mock('@/features/platform-policy/use-platform-policy-query', () => ({
  usePlatformPolicyQuery: vi.fn(),
}))

vi.mock('@/features/subscription/use-subscription-query', () => ({
  useSubscriptionQuery: vi.fn(),
}))

function createUnauthorizedError(): AxiosError {
  const unauthorizedError = new AxiosError('Unauthorized')
  Object.defineProperty(unauthorizedError, 'response', {
    value: {
      data: { detail: 'Unauthorized' },
      status: 401,
      statusText: 'Unauthorized',
      headers: {},
      config: {},
    },
  })
  return unauthorizedError
}

function createApiError({ message, status = 400 }: { readonly message: string; readonly status?: number }): AxiosError {
  const apiError = new AxiosError(message)
  Object.defineProperty(apiError, 'response', {
    value: {
      data: { detail: message },
      status,
      statusText: message,
      headers: {},
      config: {},
    },
  })
  return apiError
}

function createAuthSession(overrides: Partial<ReturnType<typeof authProvider.useAuthSession>> = {}): ReturnType<typeof authProvider.useAuthSession> {
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
  } as ReturnType<typeof authProvider.useAuthSession>
}

function createPlansQuery(overrides: Partial<ReturnType<typeof usePlansQuery>> = {}): ReturnType<typeof usePlansQuery> {
  return {
    data: [],
    error: null,
    isPending: false,
    ...overrides,
  } as ReturnType<typeof usePlansQuery>
}

function createSubscriptionQuery(overrides: Partial<ReturnType<typeof useSubscriptionQuery>> = {}): ReturnType<typeof useSubscriptionQuery> {
  return {
    data: undefined,
    error: null,
    isPending: false,
    ...overrides,
  } as ReturnType<typeof useSubscriptionQuery>
}

function createPlatformPolicyQuery(overrides: Partial<ReturnType<typeof usePlatformPolicyQuery>> = {}): ReturnType<typeof usePlatformPolicyQuery> {
  return {
    data: undefined,
    error: null,
    isPending: false,
    ...overrides,
  } as ReturnType<typeof usePlatformPolicyQuery>
}

function createSessionData(overrides: Partial<Awaited<ReturnType<typeof sessionApi.getSession>>> = {}): Awaited<ReturnType<typeof sessionApi.getSession>> {
  return {
    id: 'session-1',
    telegramId: '123',
    username: 'rezeis-user',
    name: 'Rezeis User',
    email: 'user@rezeis.test',
    role: 'USER',
    language: 'EN',
    personalDiscount: 0,
    purchaseDiscount: 0,
    points: 42,
    maxSubscriptions: 2,
    isBlocked: false,
    isBotBlocked: false,
    isRulesAccepted: true,
    createdAt: '2026-04-01T12:00:00.000Z',
    updatedAt: '2026-04-10T12:00:00.000Z',
    webAccount: null,
    ...overrides,
  }
}

function createSessionWebAccount(overrides: Partial<NonNullable<Awaited<ReturnType<typeof sessionApi.getSession>>['webAccount']>> = {}): NonNullable<Awaited<ReturnType<typeof sessionApi.getSession>>['webAccount']> {
  return {
    id: 'web-account-1',
    login: 'rezeis-user',
    loginNormalized: 'rezeis-user',
    email: 'user@rezeis.test',
    emailNormalized: 'user@rezeis.test',
    emailVerifiedAt: '2026-04-01T12:00:00.000Z',
    requiresPasswordChange: false,
    linkPromptSnoozeUntil: null,
    credentialsBootstrappedAt: '2026-04-01T12:00:00.000Z',
    createdAt: '2026-04-01T12:00:00.000Z',
    updatedAt: '2026-04-10T12:00:00.000Z',
    ...overrides,
  }
}

function createPlatformPolicyData(overrides: Partial<NonNullable<ReturnType<typeof createPlatformPolicyQuery>['data']>> = {}) {
  return {
    rulesRequired: true,
    rulesLink: 'https://docs.rezeis.test/rules',
    channelRequired: false,
    channelLink: null,
    accessMode: 'PUBLIC' as const,
    inviteModeStartedAt: null,
    defaultCurrency: 'USD',
    ...overrides,
  }
}

function createEmailVerificationChallenge(overrides: Partial<Awaited<ReturnType<typeof sessionApi.issueWebAccountEmailVerificationChallenge>>> = {}): Awaited<ReturnType<typeof sessionApi.issueWebAccountEmailVerificationChallenge>> {
  return {
    webAccountId: 'web-account-1',
    email: 'user@rezeis.test',
    challengeExpiresAt: '2026-04-20T12:00:00.000Z',
    emailVerifiedAt: null,
    ...overrides,
  }
}

function createPlansData() {
  return [
    {
      id: 'plan-1',
      orderIndex: 1,
      name: 'Starter',
      description: 'Starter plan',
      tag: null,
      type: 'BOTH',
      trafficLimit: 1073741824,
      deviceLimit: 1,
      durations: [
        {
          id: 'duration-1',
          days: 30,
          prices: [{ currency: 'USD', price: '9.99' }],
        },
      ],
    },
  ]
}

function renderDashboard(): ReturnType<typeof renderWithProviders> {
  return renderWithProviders(<DashboardPage />)
}

function renderDashboardWithAuthProvider({
  initialChallenge = null,
}: {
  readonly initialChallenge?: Awaited<ReturnType<typeof sessionApi.issueWebAccountEmailVerificationChallenge>> | null
} = {}): RenderResult {
  const queryClient = createQueryClient({ isTest: true })
  queryClient.setQueryData(['session', 'web-account-email-verification-challenge'], initialChallenge)
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AuthProvider>
          <DashboardPage />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function renderShellRouterWithAuth(route: string = '/'): RenderResult & { readonly router: ReturnType<typeof createMemoryRouter> } {
  const router = createMemoryRouter(appRoutes, {
    initialEntries: [route],
  })
  const queryClient = createQueryClient({ isTest: true })
  const renderResult = render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>,
  )
  return {
    ...renderResult,
    router,
  }
}

describe('DashboardPage', () => {
  beforeEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('describes all five live authenticated write paths in the shell copy', () => {
    vi.spyOn(authProvider, 'useAuthSession').mockReturnValue(createAuthSession())
    vi.mocked(usePlansQuery).mockReturnValue(createPlansQuery({ data: createPlansData() }))
    vi.mocked(useSubscriptionQuery).mockReturnValue(createSubscriptionQuery())
    vi.mocked(usePlatformPolicyQuery).mockReturnValue(createPlatformPolicyQuery())

    const { getByText } = renderDashboard()

    expect(getByText(/Five narrow write paths are now live/)).toBeInTheDocument()
    expect(getByText(/linked email-verification challenge issuance/)).toBeInTheDocument()
    expect(getByText(/linked email-verification completion/)).toBeInTheDocument()
  })

  it('hides unauthorized panel errors when authentication is required', () => {
    vi.spyOn(authProvider, 'useAuthSession').mockReturnValue(
      createAuthSession({
        sessionQuery: {
          data: undefined,
          error: createUnauthorizedError(),
          isPending: false,
        },
      }),
    )
    vi.mocked(usePlansQuery).mockReturnValue(createPlansQuery({ data: createPlansData() }))
    vi.mocked(useSubscriptionQuery).mockReturnValue(createSubscriptionQuery({ error: createUnauthorizedError() }))
    vi.mocked(usePlatformPolicyQuery).mockReturnValue(createPlatformPolicyQuery())

    const { getAllByText, queryByText } = renderDashboard()

    expect(getAllByText('Authentication required')).toHaveLength(3)
    expect(queryByText('Unauthorized')).not.toBeInTheDocument()
    expect(queryByText('No session payload loaded yet.')).not.toBeInTheDocument()
  })

  it('renders the loading shell summary while session bootstrap is pending', () => {
    vi.spyOn(authProvider, 'useAuthSession').mockReturnValue(
      createAuthSession({
        status: 'loading',
        canBootstrapWithTelegram: true,
        sessionQuery: {
          data: undefined,
          error: null,
          isPending: true,
        },
      }),
    )
    vi.mocked(usePlansQuery).mockReturnValue(createPlansQuery({ data: undefined, isPending: true }))
    vi.mocked(useSubscriptionQuery).mockReturnValue(createSubscriptionQuery({ isPending: true }))
    vi.mocked(usePlatformPolicyQuery).mockReturnValue(createPlatformPolicyQuery({ isPending: true }))

    const { getByText, getAllByText } = renderDashboard()

    expect(getByText('Bootstrapping session')).toBeInTheDocument()
    expect(getByText('Telegram launch data detected. Waiting for session bootstrap to complete.')).toBeInTheDocument()
    expect(getByText('Checking account session.')).toBeInTheDocument()
    expect(getAllByText('Waiting for authenticated session.').length).toBeGreaterThanOrEqual(2)
    expect(getByText('Loading plan catalog.')).toBeInTheDocument()
    expect(getAllByText('Loading...').length).toBeGreaterThanOrEqual(3)
  })

  it('renders the authenticated empty state when no subscription exists', () => {
    vi.spyOn(authProvider, 'useAuthSession').mockReturnValue(
      createAuthSession({
        status: 'authenticated',
        sessionQuery: {
          data: createSessionData(),
          error: null,
          isPending: false,
        },
      }),
    )
    vi.mocked(usePlansQuery).mockReturnValue(createPlansQuery({ data: createPlansData() }))
    vi.mocked(useSubscriptionQuery).mockReturnValue(createSubscriptionQuery({ data: null }))
    vi.mocked(usePlatformPolicyQuery).mockReturnValue(createPlatformPolicyQuery())

    const { getAllByText, getByText } = renderDashboard()

    expect(getAllByText('Rezeis User').length).toBeGreaterThanOrEqual(1)
    expect(getByText('USER')).toBeInTheDocument()
    expect(getAllByText('user@rezeis.test').length).toBeGreaterThanOrEqual(1)
    expect(getByText('None')).toBeInTheDocument()
    expect(getByText('No current subscription on record.')).toBeInTheDocument()
    expect(getByText('This user does not currently have a subscription.')).toBeInTheDocument()
  })

  it('handles partial platform policy data and invalid links safely', () => {
    vi.spyOn(authProvider, 'useAuthSession').mockReturnValue(
      createAuthSession({
        status: 'authenticated',
        sessionQuery: {
          data: createSessionData(),
          error: null,
          isPending: false,
        },
      }),
    )
    vi.mocked(usePlansQuery).mockReturnValue(createPlansQuery({ data: createPlansData() }))
    vi.mocked(useSubscriptionQuery).mockReturnValue(createSubscriptionQuery({ data: null }))
    vi.mocked(usePlatformPolicyQuery).mockReturnValue(
      createPlatformPolicyQuery({
        data: {
          rulesRequired: true,
          rulesLink: 'javascript:alert(1)',
          channelRequired: false,
          channelLink: 'not-a-valid-link',
          accessMode: 'INVITED',
          inviteModeStartedAt: 'not-a-date',
          defaultCurrency: 'USD',
        },
      }),
    )

    const { getAllByText, queryByRole, getByText } = renderDashboard()

    expect(getByText('Invalid timestamp')).toBeInTheDocument()
    expect(getAllByText('Not set').length).toBeGreaterThanOrEqual(2)
    expect(queryByRole('link', { name: 'javascript:alert(1)' })).not.toBeInTheDocument()
    expect(queryByRole('link', { name: 'not-a-valid-link' })).not.toBeInTheDocument()
    expect(getByText('The payload marks the platform access mode as invite-only.')).toBeInTheDocument()
  })

  it('shows the rules acceptance CTA only when acceptance is still required', () => {
    vi.spyOn(authProvider, 'useAuthSession').mockReturnValue(
      createAuthSession({
        status: 'authenticated',
        sessionQuery: {
          data: createSessionData({ isRulesAccepted: false }),
          error: null,
          isPending: false,
        },
      }),
    )
    vi.mocked(usePlansQuery).mockReturnValue(createPlansQuery({ data: createPlansData() }))
    vi.mocked(useSubscriptionQuery).mockReturnValue(createSubscriptionQuery({ data: null }))
    vi.mocked(usePlatformPolicyQuery).mockReturnValue(
      createPlatformPolicyQuery({
        data: createPlatformPolicyData(),
      }),
    )

    const { getByRole, rerender, queryByRole } = renderDashboard()

    expect(getByRole('button', { name: 'Accept rules' })).toBeInTheDocument()
    expect(getByRole('link', { name: 'Read rules' })).toHaveAttribute('href', 'https://docs.rezeis.test/rules')

    vi.spyOn(authProvider, 'useAuthSession').mockReturnValue(
      createAuthSession({
        status: 'authenticated',
        sessionQuery: {
          data: createSessionData({ isRulesAccepted: true }),
          error: null,
          isPending: false,
        },
      }),
    )

    rerender(<DashboardPage />)

    expect(queryByRole('button', { name: 'Accept rules' })).not.toBeInTheDocument()
    expect(queryByRole('link', { name: 'Read rules' })).not.toBeInTheDocument()
  })

  it('shows the web-account readiness CTA when linked-account follow-up is still required', () => {
    vi.spyOn(authProvider, 'useAuthSession').mockReturnValue(
      createAuthSession({
        status: 'authenticated',
        sessionQuery: {
          data: createSessionData({
            webAccount: createSessionWebAccount({
              requiresPasswordChange: false,
              credentialsBootstrappedAt: null,
              linkPromptSnoozeUntil: null,
            }),
          }),
          error: null,
          isPending: false,
        },
      }),
    )
    vi.mocked(usePlansQuery).mockReturnValue(createPlansQuery({ data: createPlansData() }))
    vi.mocked(useSubscriptionQuery).mockReturnValue(createSubscriptionQuery({ data: null }))
    vi.mocked(usePlatformPolicyQuery).mockReturnValue(createPlatformPolicyQuery())

    const { getByRole, getByText } = renderDashboard()

    expect(getByText('Credentials setup required')).toBeInTheDocument()
    expect(getByRole('link', { name: 'Set login and password' })).toHaveAttribute('href', '/web-account')
    expect(getByRole('button', { name: 'Remind me later' })).toBeInTheDocument()
  })

  it('shows linked-credentials-ready wording for unverified linked emails when login credentials are already ready', () => {
    vi.spyOn(authProvider, 'useAuthSession').mockReturnValue(
      createAuthSession({
        status: 'authenticated',
        sessionQuery: {
          data: createSessionData({
            webAccount: createSessionWebAccount({
              emailVerifiedAt: null,
              requiresPasswordChange: false,
              credentialsBootstrappedAt: '2026-04-01T12:00:00.000Z',
            }),
          }),
          error: null,
          isPending: false,
        },
      }),
    )
    vi.mocked(usePlansQuery).mockReturnValue(createPlansQuery({ data: createPlansData() }))
    vi.mocked(useSubscriptionQuery).mockReturnValue(createSubscriptionQuery({ data: null }))
    vi.mocked(usePlatformPolicyQuery).mockReturnValue(createPlatformPolicyQuery())

    const { getByText, queryByText } = renderDashboard()

    expect(getByText('Linked credentials ready')).toBeInTheDocument()
    expect(getByText('The linked web account has login and password credentials in place. Linked email verification remains an optional follow-up.')).toBeInTheDocument()
    expect(queryByText('Email verification required')).not.toBeInTheDocument()
  })

  it('shows the linked email verification CTA only for authenticated unverified linked accounts', () => {
    vi.mocked(usePlansQuery).mockReturnValue(createPlansQuery({ data: createPlansData() }))
    vi.mocked(useSubscriptionQuery).mockReturnValue(createSubscriptionQuery({ data: null }))
    vi.mocked(usePlatformPolicyQuery).mockReturnValue(createPlatformPolicyQuery())
    vi.spyOn(authProvider, 'useAuthSession').mockReturnValue(
      createAuthSession({
        status: 'authenticated',
        sessionQuery: {
          data: createSessionData({
            webAccount: createSessionWebAccount({
              emailVerifiedAt: null,
            }),
          }),
          error: null,
          isPending: false,
        },
      }),
    )

    const { getByRole, rerender, queryByRole } = renderDashboard()

    expect(getByRole('button', { name: 'Issue verification challenge' })).toBeInTheDocument()

    vi.spyOn(authProvider, 'useAuthSession').mockReturnValue(
      createAuthSession({
        status: 'authenticated',
        sessionQuery: {
          data: createSessionData({
            webAccount: createSessionWebAccount({
              emailVerifiedAt: '2026-04-01T12:00:00.000Z',
            }),
          }),
          error: null,
          isPending: false,
        },
      }),
    )

    rerender(<DashboardPage />)

    expect(queryByRole('button', { name: 'Issue verification challenge' })).not.toBeInTheDocument()
  })

  it('shows login setup readiness when the linked account has no login yet', () => {
    vi.spyOn(authProvider, 'useAuthSession').mockReturnValue(
      createAuthSession({
        status: 'authenticated',
        sessionQuery: {
          data: createSessionData({
            webAccount: createSessionWebAccount({
              login: null,
              loginNormalized: null,
              emailVerifiedAt: null,
            }),
          }),
          error: null,
          isPending: false,
        },
      }),
    )
    vi.mocked(usePlansQuery).mockReturnValue(createPlansQuery({ data: createPlansData() }))
    vi.mocked(useSubscriptionQuery).mockReturnValue(createSubscriptionQuery({ data: null }))
    vi.mocked(usePlatformPolicyQuery).mockReturnValue(createPlatformPolicyQuery())

    const { getByText, getByRole } = renderDashboard()

    expect(getByText('Login setup required')).toBeInTheDocument()
    expect(getByText('The linked web account exists, but it still needs a login before linked credentials are complete.')).toBeInTheDocument()
    expect(getByText('Web account login').closest('div')).toHaveTextContent('Not set')
    expect(getByRole('link', { name: 'Set login and password' })).toHaveAttribute('href', '/web-account')
  })

  it('prefers the linked login over session email in visible shell identity summaries', () => {
    vi.spyOn(authProvider, 'useAuthSession').mockReturnValue(
      createAuthSession({
        status: 'authenticated',
        sessionQuery: {
          data: createSessionData({
            email: 'user@rezeis.test',
            username: 'ruid-user',
            webAccount: createSessionWebAccount({
              login: 'linked-login',
              loginNormalized: 'linked-login',
            }),
          }),
          error: null,
          isPending: false,
        },
      }),
    )
    vi.mocked(usePlansQuery).mockReturnValue(createPlansQuery({ data: createPlansData() }))
    vi.mocked(useSubscriptionQuery).mockReturnValue(createSubscriptionQuery({ data: null }))
    vi.mocked(usePlatformPolicyQuery).mockReturnValue(createPlatformPolicyQuery())

    const { getByText } = renderDashboard()

    expect(getByText('Session').closest('article')).toHaveTextContent('linked-login')
  })

  it('hides the linked email verification CTA while linked credentials are still incomplete', () => {
    vi.mocked(usePlansQuery).mockReturnValue(createPlansQuery({ data: createPlansData() }))
    vi.mocked(useSubscriptionQuery).mockReturnValue(createSubscriptionQuery({ data: null }))
    vi.mocked(usePlatformPolicyQuery).mockReturnValue(createPlatformPolicyQuery())
    vi.spyOn(authProvider, 'useAuthSession').mockReturnValue(
      createAuthSession({
        status: 'authenticated',
        sessionQuery: {
          data: createSessionData({
            webAccount: createSessionWebAccount({
              login: null,
              loginNormalized: null,
              emailVerifiedAt: null,
            }),
          }),
          error: null,
          isPending: false,
        },
      }),
    )

    const { getByRole, queryByRole, queryByText } = renderDashboard()

    expect(getByRole('link', { name: 'Set login and password' })).toBeInTheDocument()
    expect(queryByRole('button', { name: 'Issue verification challenge' })).not.toBeInTheDocument()
    expect(queryByText('Optional linked email follow-up is available.')).not.toBeInTheDocument()
  })

  it('stops showing pending verification state when the current linked email no longer matches the challenge email', async () => {
    vi.mocked(usePlansQuery).mockReturnValue(createPlansQuery({ data: createPlansData() }))
    vi.mocked(useSubscriptionQuery).mockReturnValue(createSubscriptionQuery({ data: null }))
    vi.mocked(usePlatformPolicyQuery).mockReturnValue(createPlatformPolicyQuery())
    vi.spyOn(authProvider, 'useAuthSession').mockReturnValue(
      createAuthSession({
        status: 'authenticated',
        sessionQuery: {
          data: createSessionData({
            webAccount: createSessionWebAccount({
              email: 'new-email@rezeis.test',
              emailNormalized: 'new-email@rezeis.test',
              emailVerifiedAt: null,
            }),
          }),
          error: null,
          isPending: false,
        },
      }),
    )

    const { queryByText, queryByRole, getByRole } = renderDashboardWithAuthProvider({
      initialChallenge: createEmailVerificationChallenge({
        email: 'old-email@rezeis.test',
      }),
    })

    await waitFor(() => {
      expect(queryByText(/Verification email issued for old-email@rezeis.test/)).not.toBeInTheDocument()
    })

    expect(queryByRole('button', { name: 'Resend verification email' })).not.toBeInTheDocument()
    expect(getByRole('button', { name: 'Issue verification challenge' })).toBeInTheDocument()
    expect(queryByRole('link', { name: 'Enter verification code' })).not.toBeInTheDocument()
  })

  it('hides the linked email verification CTA when the linked account has no email address', () => {
    vi.mocked(usePlansQuery).mockReturnValue(createPlansQuery({ data: createPlansData() }))
    vi.mocked(useSubscriptionQuery).mockReturnValue(createSubscriptionQuery({ data: null }))
    vi.mocked(usePlatformPolicyQuery).mockReturnValue(createPlatformPolicyQuery())
    vi.spyOn(authProvider, 'useAuthSession').mockReturnValue(
      createAuthSession({
        status: 'authenticated',
        sessionQuery: {
          data: createSessionData({
            webAccount: createSessionWebAccount({
              email: null,
              emailNormalized: null,
              emailVerifiedAt: null,
            }),
          }),
          error: null,
          isPending: false,
        },
      }),
    )

    const { queryByRole } = renderDashboard()

    expect(queryByRole('button', { name: 'Issue verification challenge' })).not.toBeInTheDocument()
    expect(queryByRole('button', { name: 'Resend verification email' })).not.toBeInTheDocument()
  })

  it('reconciles the linked email state when issuance returns a missing-email fallback payload', async () => {
    const initialSession = createSessionData({
      webAccount: createSessionWebAccount({
        email: null,
        emailNormalized: 'normalized@rezeis.test',
        emailVerifiedAt: null,
      }),
    })
    const issueChallengeSpy = vi.spyOn(sessionApi, 'issueWebAccountEmailVerificationChallenge').mockResolvedValue(createEmailVerificationChallenge({
      email: null,
      challengeExpiresAt: null,
      emailVerifiedAt: null,
    }))
    vi.spyOn(sessionApi, 'getSession').mockResolvedValue(initialSession)
    vi.mocked(usePlansQuery).mockReturnValue(createPlansQuery({ data: createPlansData() }))
    vi.mocked(useSubscriptionQuery).mockReturnValue(createSubscriptionQuery({ data: null }))
    vi.mocked(usePlatformPolicyQuery).mockReturnValue(createPlatformPolicyQuery())

    const { getByRole, getByText, queryByRole, queryByText } = renderDashboardWithAuthProvider()

    await waitFor(() => {
      expect(getByRole('button', { name: 'Issue verification challenge' })).toBeInTheDocument()
    })

    expect(getByText('Linked email').closest('div')).toHaveTextContent('normalized@rezeis.test')

    fireEvent.click(getByRole('button', { name: 'Issue verification challenge' }))

    await waitFor(() => {
      expect(issueChallengeSpy).toHaveBeenCalledTimes(1)
    })

    expect(queryByText('Optional linked email follow-up is available.')).not.toBeInTheDocument()
    expect(getByText('Linked email').closest('div')).toHaveTextContent('Not set')
    expect(queryByRole('button', { name: 'Issue verification challenge' })).not.toBeInTheDocument()
    expect(queryByText(/Verification email issued for/)).not.toBeInTheDocument()
  })

  it('reconciles readiness state when issuance returns a verified fallback payload', async () => {
    const initialSession = createSessionData({
      webAccount: createSessionWebAccount({
        emailVerifiedAt: null,
      }),
    })
    const issueChallengeSpy = vi.spyOn(sessionApi, 'issueWebAccountEmailVerificationChallenge').mockResolvedValue(createEmailVerificationChallenge({
      challengeExpiresAt: null,
      emailVerifiedAt: '2026-04-17T12:15:00.000Z',
    }))
    vi.spyOn(sessionApi, 'getSession').mockResolvedValue(initialSession)
    vi.mocked(usePlansQuery).mockReturnValue(createPlansQuery({ data: createPlansData() }))
    vi.mocked(useSubscriptionQuery).mockReturnValue(createSubscriptionQuery({ data: null }))
    vi.mocked(usePlatformPolicyQuery).mockReturnValue(createPlatformPolicyQuery())

    const { getByRole, getByText, queryByRole, queryByText } = renderDashboardWithAuthProvider()

    await waitFor(() => {
      expect(getByRole('button', { name: 'Issue verification challenge' })).toBeInTheDocument()
    })

    fireEvent.click(getByRole('button', { name: 'Issue verification challenge' }))

    await waitFor(() => {
      expect(issueChallengeSpy).toHaveBeenCalledTimes(1)
    })
    expect(getByText('Linked credentials ready')).toBeInTheDocument()
    expect(getByText('Email verified').closest('div')).toHaveTextContent('Apr 17, 2026')
    expect(queryByText('Optional linked email follow-up is available.')).not.toBeInTheDocument()
    expect(queryByRole('button', { name: 'Issue verification challenge' })).not.toBeInTheDocument()
  })

  it('clears the stale issued verification state when issuance reports that no active challenge exists', async () => {
    const issueChallengeError = createApiError({ message: 'active email verification challenge not found' })
    vi.spyOn(sessionApi, 'issueWebAccountEmailVerificationChallenge').mockRejectedValue(issueChallengeError)
    vi.spyOn(sessionApi, 'getSession').mockResolvedValue(createSessionData({
      webAccount: createSessionWebAccount({
        emailVerifiedAt: null,
      }),
    }))
    vi.mocked(usePlansQuery).mockReturnValue(createPlansQuery({ data: createPlansData() }))
    vi.mocked(useSubscriptionQuery).mockReturnValue(createSubscriptionQuery({ data: null }))
    vi.mocked(usePlatformPolicyQuery).mockReturnValue(createPlatformPolicyQuery())

    const { getByRole, queryByText } = renderDashboardWithAuthProvider({
      initialChallenge: createEmailVerificationChallenge(),
    })

    await waitFor(() => {
      expect(getByRole('button', { name: 'Resend verification email' })).toBeInTheDocument()
    })

    fireEvent.click(getByRole('button', { name: 'Resend verification email' }))

    await waitFor(() => {
      expect(getByRole('button', { name: 'Issue verification challenge' })).toBeInTheDocument()
    })

    expect(queryByText(/Verification email issued for/)).not.toBeInTheDocument()
    expect(queryByText('active email verification challenge not found')).not.toBeInTheDocument()
  })

  it('reconciles to the unlinked dashboard state when issuance returns a missing-web-account fallback payload', async () => {
    vi.spyOn(sessionApi, 'getSession').mockResolvedValue(createSessionData({
      webAccount: createSessionWebAccount({
        emailVerifiedAt: null,
      }),
    }))
    const issueChallengeSpy = vi.spyOn(sessionApi, 'issueWebAccountEmailVerificationChallenge').mockResolvedValue(createEmailVerificationChallenge({
      webAccountId: null,
      email: null,
      challengeExpiresAt: null,
      emailVerifiedAt: null,
    }))
    vi.mocked(usePlansQuery).mockReturnValue(createPlansQuery({ data: createPlansData() }))
    vi.mocked(useSubscriptionQuery).mockReturnValue(createSubscriptionQuery({ data: null }))
    vi.mocked(usePlatformPolicyQuery).mockReturnValue(createPlatformPolicyQuery())

    const { getByRole, getByText, queryByText } = renderDashboardWithAuthProvider()

    await waitFor(() => {
      expect(getByRole('button', { name: 'Issue verification challenge' })).toBeInTheDocument()
    })

    fireEvent.click(getByRole('button', { name: 'Issue verification challenge' }))

    await waitFor(() => {
      expect(issueChallengeSpy).toHaveBeenCalledTimes(1)
    })

    expect(getByText('No linked web account is currently attached to this user.')).toBeInTheDocument()
    expect(queryByText('Optional linked email follow-up is available.')).not.toBeInTheDocument()
  })

  it('keeps session email separate from web-account email in the readiness block', () => {
    vi.spyOn(authProvider, 'useAuthSession').mockReturnValue(
      createAuthSession({
        status: 'authenticated',
        sessionQuery: {
          data: createSessionData({
            email: null,
            webAccount: createSessionWebAccount({
              email: 'linked@rezeis.test',
              emailNormalized: 'linked@rezeis.test',
              requiresPasswordChange: true,
            }),
          }),
          error: null,
          isPending: false,
        },
      }),
    )
    vi.mocked(usePlansQuery).mockReturnValue(createPlansQuery({ data: createPlansData() }))
    vi.mocked(useSubscriptionQuery).mockReturnValue(createSubscriptionQuery({ data: null }))
    vi.mocked(usePlatformPolicyQuery).mockReturnValue(createPlatformPolicyQuery())

    const { getByText, queryByText } = renderDashboard()

    expect(getByText('Email').closest('div')).toHaveTextContent('Not set')
    expect(getByText('Web account login').closest('div')).toHaveTextContent('rezeis-user')
    expect(getByText('Linked email').closest('div')).toHaveTextContent('linked@rezeis.test')
    expect(queryByText('user@rezeis.test')).not.toBeInTheDocument()
  })

  it('hides the web-account readiness CTA when follow-up is not actionable', () => {
    vi.mocked(usePlansQuery).mockReturnValue(createPlansQuery({ data: createPlansData() }))
    vi.mocked(useSubscriptionQuery).mockReturnValue(createSubscriptionQuery({ data: null }))
    vi.mocked(usePlatformPolicyQuery).mockReturnValue(createPlatformPolicyQuery())
    vi.spyOn(authProvider, 'useAuthSession').mockReturnValue(
      createAuthSession({
        status: 'authenticated',
        sessionQuery: {
          data: createSessionData({
            webAccount: createSessionWebAccount({
              requiresPasswordChange: false,
              credentialsBootstrappedAt: '2026-04-01T12:00:00.000Z',
            }),
          }),
          error: null,
          isPending: false,
        },
      }),
    )

    const { queryByRole, rerender } = renderDashboard()

    expect(queryByRole('button', { name: 'Remind me later' })).not.toBeInTheDocument()
    expect(queryByRole('link', { name: 'Set login and password' })).not.toBeInTheDocument()

    vi.spyOn(authProvider, 'useAuthSession').mockReturnValue(
      createAuthSession({
        status: 'authenticated',
        sessionQuery: {
          data: createSessionData({
            webAccount: createSessionWebAccount({
              requiresPasswordChange: true,
              linkPromptSnoozeUntil: '2099-04-24T05:00:00.000Z',
            }),
          }),
          error: null,
          isPending: false,
        },
      }),
    )

    rerender(<DashboardPage />)

    expect(queryByRole('button', { name: 'Remind me later' })).not.toBeInTheDocument()
    expect(queryByRole('link', { name: 'Set login and password' })).not.toBeInTheDocument()

    vi.spyOn(authProvider, 'useAuthSession').mockReturnValue(createAuthSession())

    rerender(<DashboardPage />)

    expect(queryByRole('button', { name: 'Remind me later' })).not.toBeInTheDocument()
    expect(queryByRole('link', { name: 'Set login and password' })).not.toBeInTheDocument()
  })

  it('hides the rules acceptance CTA when authentication is required', () => {
    vi.spyOn(authProvider, 'useAuthSession').mockReturnValue(createAuthSession())
    vi.mocked(usePlansQuery).mockReturnValue(createPlansQuery({ data: createPlansData() }))
    vi.mocked(useSubscriptionQuery).mockReturnValue(createSubscriptionQuery())
    vi.mocked(usePlatformPolicyQuery).mockReturnValue(
      createPlatformPolicyQuery({
        data: createPlatformPolicyData(),
      }),
    )

    const { queryByRole } = renderDashboard()

    expect(queryByRole('button', { name: 'Accept rules' })).not.toBeInTheDocument()
    expect(queryByRole('link', { name: 'Read rules' })).not.toBeInTheDocument()
  })

  it('hides the rules acceptance CTA when rules are not required', () => {
    vi.spyOn(authProvider, 'useAuthSession').mockReturnValue(
      createAuthSession({
        status: 'authenticated',
        sessionQuery: {
          data: createSessionData({ isRulesAccepted: false }),
          error: null,
          isPending: false,
        },
      }),
    )
    vi.mocked(usePlansQuery).mockReturnValue(createPlansQuery({ data: createPlansData() }))
    vi.mocked(useSubscriptionQuery).mockReturnValue(createSubscriptionQuery({ data: null }))
    vi.mocked(usePlatformPolicyQuery).mockReturnValue(
      createPlatformPolicyQuery({
        data: createPlatformPolicyData({ rulesRequired: false }),
      }),
    )

    const { queryByRole } = renderDashboard()

    expect(queryByRole('button', { name: 'Accept rules' })).not.toBeInTheDocument()
    expect(queryByRole('link', { name: 'Read rules' })).not.toBeInTheDocument()
  })

  it('refreshes the visible session state after rules acceptance succeeds', async () => {
    const initialSession = createSessionData({ isRulesAccepted: false })
    const refreshedSession = createSessionData({ isRulesAccepted: true })
    const acceptRulesSpy = vi.spyOn(sessionApi, 'acceptRules').mockResolvedValue(refreshedSession)
    const getSessionSpy = vi.spyOn(sessionApi, 'getSession').mockResolvedValue(initialSession)
    vi.mocked(usePlansQuery).mockReturnValue(createPlansQuery({ data: createPlansData() }))
    vi.mocked(useSubscriptionQuery).mockReturnValue(createSubscriptionQuery({ data: null }))
    vi.mocked(usePlatformPolicyQuery).mockReturnValue(
      createPlatformPolicyQuery({
        data: createPlatformPolicyData(),
      }),
    )

    const { getByRole, getByText, queryByRole } = renderDashboardWithAuthProvider()

    await waitFor(() => {
      expect(getByRole('button', { name: 'Accept rules' })).toBeInTheDocument()
    })

    expect(getByText('Rules acceptance').closest('article')).toHaveTextContent('No')

    fireEvent.click(getByRole('button', { name: 'Accept rules' }))

    await waitFor(() => {
      expect(acceptRulesSpy).toHaveBeenCalledTimes(1)
    })
    await waitFor(() => {
      expect(queryByRole('button', { name: 'Accept rules' })).not.toBeInTheDocument()
    })

    expect(getSessionSpy).toHaveBeenCalledTimes(1)
    expect(getByText('Rules acceptance').closest('article')).toHaveTextContent('Yes')
  })

  it('does not leave the rules acceptance CTA active after an unauthorized mutation failure', async () => {
    const unauthorizedError = createUnauthorizedError()
    const acceptRulesSpy = vi.spyOn(sessionApi, 'acceptRules').mockRejectedValue(unauthorizedError)
    const getSessionSpy = vi.spyOn(sessionApi, 'getSession').mockResolvedValueOnce(createSessionData({ isRulesAccepted: false })).mockRejectedValue(unauthorizedError)
    vi.mocked(usePlansQuery).mockReturnValue(createPlansQuery({ data: createPlansData() }))
    vi.mocked(useSubscriptionQuery).mockReturnValue(createSubscriptionQuery({ data: null }))
    vi.mocked(usePlatformPolicyQuery).mockReturnValue(
      createPlatformPolicyQuery({
        data: createPlatformPolicyData(),
      }),
    )

    const { getAllByText, getByRole, queryByRole, queryByText } = renderDashboardWithAuthProvider()

    await waitFor(() => {
      expect(getByRole('button', { name: 'Accept rules' })).toBeInTheDocument()
    })

    fireEvent.click(getByRole('button', { name: 'Accept rules' }))

    await waitFor(() => {
      expect(acceptRulesSpy).toHaveBeenCalledTimes(1)
    })
    await waitFor(() => {
      expect(getSessionSpy).toHaveBeenCalledTimes(2)
    })
    await waitFor(() => {
      expect(getAllByText('Authentication required').length).toBeGreaterThan(0)
      expect(queryByText('Open the Mini App in Telegram or reuse an existing cookie session.')).toBeInTheDocument()
      expect(queryByRole('button', { name: 'Accept rules' })).not.toBeInTheDocument()
      expect(queryByRole('link', { name: 'Read rules' })).not.toBeInTheDocument()
      expect(queryByText('Rezeis User')).not.toBeInTheDocument()
      expect(queryByText('user@rezeis.test')).not.toBeInTheDocument()
      expect(queryByText('USER')).not.toBeInTheDocument()
      expect(queryByText('Dashboard and subscription data now resolve from the opaque cookie session created by Telegram bootstrap.')).not.toBeInTheDocument()
    })
  })

  it('refreshes the visible session state after snoozing the web-account readiness prompt', async () => {
    const initialSession = createSessionData({
      webAccount: createSessionWebAccount({
        requiresPasswordChange: true,
        linkPromptSnoozeUntil: null,
      }),
    })
    const refreshedSession = createSessionData({
      webAccount: createSessionWebAccount({
        requiresPasswordChange: true,
        linkPromptSnoozeUntil: '2026-05-01T12:00:00.000Z',
      }),
    })
    const snoozeSpy = vi.spyOn(sessionApi, 'snoozeWebAccountLinkPrompt').mockResolvedValue(refreshedSession)
    const getSessionSpy = vi.spyOn(sessionApi, 'getSession').mockResolvedValue(initialSession)
    vi.mocked(usePlansQuery).mockReturnValue(createPlansQuery({ data: createPlansData() }))
    vi.mocked(useSubscriptionQuery).mockReturnValue(createSubscriptionQuery({ data: null }))
    vi.mocked(usePlatformPolicyQuery).mockReturnValue(createPlatformPolicyQuery())

    const { getByRole, getByText, queryByRole } = renderDashboardWithAuthProvider()

    await waitFor(() => {
      expect(getByRole('button', { name: 'Remind me later' })).toBeInTheDocument()
    })

    fireEvent.click(getByRole('button', { name: 'Remind me later' }))

    await waitFor(() => {
      expect(snoozeSpy).toHaveBeenCalledTimes(1)
    })
    await waitFor(() => {
      expect(queryByRole('button', { name: 'Remind me later' })).not.toBeInTheDocument()
    })

    expect(getSessionSpy).toHaveBeenCalledTimes(1)
    expect(getByText('Link prompt snooze').closest('div')).toHaveTextContent('May 1, 2026')
  })

  it('shows the pending verification state after issuing a linked email verification challenge', async () => {
    const initialSession = createSessionData({
      webAccount: createSessionWebAccount({
        emailVerifiedAt: null,
      }),
    })
    const issueChallengeSpy = vi.spyOn(sessionApi, 'issueWebAccountEmailVerificationChallenge').mockResolvedValue(createEmailVerificationChallenge())
    const getSessionSpy = vi.spyOn(sessionApi, 'getSession').mockResolvedValue(initialSession)
    vi.mocked(usePlansQuery).mockReturnValue(createPlansQuery({ data: createPlansData() }))
    vi.mocked(useSubscriptionQuery).mockReturnValue(createSubscriptionQuery({ data: null }))
    vi.mocked(usePlatformPolicyQuery).mockReturnValue(createPlatformPolicyQuery())

    const { getByRole, getByText } = renderDashboardWithAuthProvider()

    await waitFor(() => {
      expect(getByRole('button', { name: 'Issue verification challenge' })).toBeInTheDocument()
    })

    fireEvent.click(getByRole('button', { name: 'Issue verification challenge' }))

    await waitFor(() => {
      expect(issueChallengeSpy).toHaveBeenCalledTimes(1)
    })
    await waitFor(() => {
      expect(getByRole('button', { name: 'Resend verification email' })).toBeInTheDocument()
    })

    expect(getSessionSpy).toHaveBeenCalledTimes(1)
    expect(getByText(/Verification email issued for user@rezeis.test/)).toBeInTheDocument()
    expect(getByText('Email verified').closest('div')).toHaveTextContent('Not set')
  })

  it('keeps the issued verification state when navigating from dashboard to web-account inside one shell session', async () => {
    const initialSession = createSessionData({
      webAccount: createSessionWebAccount({
        emailVerifiedAt: null,
      }),
    })
    vi.spyOn(sessionApi, 'getSession').mockResolvedValue(initialSession)
    const issueChallengeSpy = vi.spyOn(sessionApi, 'issueWebAccountEmailVerificationChallenge').mockResolvedValue(createEmailVerificationChallenge())
    vi.mocked(usePlansQuery).mockReturnValue(createPlansQuery({ data: createPlansData() }))
    vi.mocked(useSubscriptionQuery).mockReturnValue(createSubscriptionQuery({ data: null }))
    vi.mocked(usePlatformPolicyQuery).mockReturnValue(createPlatformPolicyQuery())

    const { getByRole, getByText, router } = renderShellRouterWithAuth('/')

    await waitFor(() => {
      expect(getByRole('button', { name: 'Issue verification challenge' })).toBeInTheDocument()
    })

    fireEvent.click(getByRole('button', { name: 'Issue verification challenge' }))

    await waitFor(() => {
      expect(issueChallengeSpy).toHaveBeenCalledTimes(1)
    })
    await waitFor(() => {
      expect(getByRole('button', { name: 'Resend verification email' })).toBeInTheDocument()
    })

    await act(async () => {
      await router.navigate('/web-account')
    })

    await waitFor(() => {
      expect(getByText('Verification email issued.')).toBeInTheDocument()
    })
    expect(getByRole('button', { name: 'Resend verification email' })).toBeInTheDocument()
  })

  it('stops showing the local pending verification state after the challenge expires', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-17T12:00:00.000Z'))
    const initialSession = createSessionData({
      webAccount: createSessionWebAccount({
        emailVerifiedAt: null,
      }),
    })
    const issueChallengeSpy = vi.spyOn(sessionApi, 'issueWebAccountEmailVerificationChallenge').mockResolvedValue(
      createEmailVerificationChallenge({
        challengeExpiresAt: '2026-04-17T12:05:00.000Z',
      }),
    )
    vi.spyOn(sessionApi, 'getSession').mockResolvedValue(initialSession)
    vi.mocked(usePlansQuery).mockReturnValue(createPlansQuery({ data: createPlansData() }))
    vi.mocked(useSubscriptionQuery).mockReturnValue(createSubscriptionQuery({ data: null }))
    vi.mocked(usePlatformPolicyQuery).mockReturnValue(createPlatformPolicyQuery())

    const { getByRole, queryByText } = renderDashboardWithAuthProvider()

    await waitFor(() => {
      expect(getByRole('button', { name: 'Issue verification challenge' })).toBeInTheDocument()
    })

    fireEvent.click(getByRole('button', { name: 'Issue verification challenge' }))

    await waitFor(() => {
      expect(issueChallengeSpy).toHaveBeenCalledTimes(1)
    })
    await waitFor(() => {
      expect(getByRole('button', { name: 'Resend verification email' })).toBeInTheDocument()
    })

    await act(async () => {
      vi.setSystemTime(new Date('2026-04-17T12:06:00.000Z'))
      await vi.advanceTimersByTimeAsync(6 * 60 * 1000)
    })

    await waitFor(() => {
      expect(getByRole('button', { name: 'Issue verification challenge' })).toBeInTheDocument()
    })
    expect(queryByText(/Verification email issued for user@rezeis.test/)).not.toBeInTheDocument()
  })

  it('shows the readiness CTA after the snooze boundary passes while mounted', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-17T12:00:00.000Z'))
    vi.mocked(usePlansQuery).mockReturnValue(createPlansQuery({ data: createPlansData() }))
    vi.mocked(useSubscriptionQuery).mockReturnValue(createSubscriptionQuery({ data: null }))
    vi.mocked(usePlatformPolicyQuery).mockReturnValue(createPlatformPolicyQuery())
    vi.spyOn(authProvider, 'useAuthSession').mockReturnValue(
      createAuthSession({
        status: 'authenticated',
        sessionQuery: {
          data: createSessionData({
            webAccount: createSessionWebAccount({
              requiresPasswordChange: true,
              linkPromptSnoozeUntil: '2026-04-17T12:05:00.000Z',
            }),
          }),
          error: null,
          isPending: false,
        },
      }),
    )

    const { queryByRole, getByRole } = renderDashboard()

    expect(queryByRole('button', { name: 'Remind me later' })).not.toBeInTheDocument()

    await act(async () => {
      vi.setSystemTime(new Date('2026-04-17T12:06:00.000Z'))
      await vi.advanceTimersByTimeAsync(6 * 60 * 1000)
    })

    await waitFor(() => {
      expect(getByRole('button', { name: 'Remind me later' })).toBeInTheDocument()
    })
  })

  it('does not leave the verification CTA active after an unauthorized verification challenge failure', async () => {
    const unauthorizedError = createUnauthorizedError()
    const issueChallengeSpy = vi.spyOn(sessionApi, 'issueWebAccountEmailVerificationChallenge').mockRejectedValue(unauthorizedError)
    const getSessionSpy = vi.spyOn(sessionApi, 'getSession').mockResolvedValueOnce(
      createSessionData({
        webAccount: createSessionWebAccount({
          emailVerifiedAt: null,
        }),
      }),
    ).mockRejectedValue(unauthorizedError)
    vi.mocked(usePlansQuery).mockReturnValue(createPlansQuery({ data: createPlansData() }))
    vi.mocked(useSubscriptionQuery).mockReturnValue(createSubscriptionQuery({ data: null }))
    vi.mocked(usePlatformPolicyQuery).mockReturnValue(createPlatformPolicyQuery())

    const { getAllByText, getByRole, queryByRole, queryByText } = renderDashboardWithAuthProvider()

    await waitFor(() => {
      expect(getByRole('button', { name: 'Issue verification challenge' })).toBeInTheDocument()
    })

    fireEvent.click(getByRole('button', { name: 'Issue verification challenge' }))

    await waitFor(() => {
      expect(issueChallengeSpy).toHaveBeenCalledTimes(1)
    })
    await waitFor(() => {
      expect(getSessionSpy).toHaveBeenCalledTimes(2)
    })
    await waitFor(() => {
      expect(getAllByText('Authentication required').length).toBeGreaterThan(0)
      expect(queryByRole('button', { name: 'Issue verification challenge' })).not.toBeInTheDocument()
      expect(queryByText('Rezeis User')).not.toBeInTheDocument()
    })
  })

  it('does not leave the web-account readiness CTA active after an unauthorized snooze failure', async () => {
    const unauthorizedError = createUnauthorizedError()
    const snoozeSpy = vi.spyOn(sessionApi, 'snoozeWebAccountLinkPrompt').mockRejectedValue(unauthorizedError)
    const getSessionSpy = vi.spyOn(sessionApi, 'getSession').mockResolvedValueOnce(
      createSessionData({
        webAccount: createSessionWebAccount({
          requiresPasswordChange: true,
          linkPromptSnoozeUntil: null,
        }),
      }),
    ).mockRejectedValue(unauthorizedError)
    vi.mocked(usePlansQuery).mockReturnValue(createPlansQuery({ data: createPlansData() }))
    vi.mocked(useSubscriptionQuery).mockReturnValue(createSubscriptionQuery({ data: null }))
    vi.mocked(usePlatformPolicyQuery).mockReturnValue(createPlatformPolicyQuery())

    const { getAllByText, getByRole, queryByRole, queryByText } = renderDashboardWithAuthProvider()

    await waitFor(() => {
      expect(getByRole('button', { name: 'Remind me later' })).toBeInTheDocument()
    })

    fireEvent.click(getByRole('button', { name: 'Remind me later' }))

    await waitFor(() => {
      expect(snoozeSpy).toHaveBeenCalledTimes(1)
    })
    await waitFor(() => {
      expect(getSessionSpy).toHaveBeenCalledTimes(2)
    })
    await waitFor(() => {
      expect(getAllByText('Authentication required').length).toBeGreaterThan(0)
      expect(queryByRole('button', { name: 'Remind me later' })).not.toBeInTheDocument()
      expect(queryByText('Rezeis User')).not.toBeInTheDocument()
      expect(queryByText('user@rezeis.test')).not.toBeInTheDocument()
    })
  })
})
