import { QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, waitFor, type RenderResult } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { RouterProvider, createMemoryRouter } from 'react-router-dom'
import { AxiosError } from 'axios'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { appRoutes } from '@/app/router'
import { AuthProvider } from '@/features/auth/auth-provider'
import { usePlansQuery } from '@/features/plans/use-plans-query'
import { usePlatformPolicyQuery } from '@/features/platform-policy/use-platform-policy-query'
import { sessionApi } from '@/features/session/session-api'
import { useSubscriptionQuery } from '@/features/subscription/use-subscription-query'
import { WebAccountPage } from '@/features/web-account/web-account-page'
import * as authProvider from '@/features/auth/auth-provider'
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

function createEmailVerificationChallenge(overrides: Partial<Awaited<ReturnType<typeof sessionApi.issueWebAccountEmailVerificationChallenge>>> = {}): Awaited<ReturnType<typeof sessionApi.issueWebAccountEmailVerificationChallenge>> {
  return {
    webAccountId: 'web-account-1',
    email: 'user@rezeis.test',
    challengeExpiresAt: '2026-04-20T12:00:00.000Z',
    emailVerifiedAt: null,
    ...overrides,
  }
}

function renderWebAccountPage(): ReturnType<typeof renderWithProviders> {
  return renderWithProviders(<WebAccountPage />)
}

function renderWebAccountPageWithAuthProvider({
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
          <WebAccountPage />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function renderWebAccountPageWithMockedAuthSession({
  authSession,
  initialChallenge = null,
}: {
  readonly authSession: ReturnType<typeof authProvider.useAuthSession>
  readonly initialChallenge?: Awaited<ReturnType<typeof sessionApi.issueWebAccountEmailVerificationChallenge>> | null
}): RenderResult & {
  readonly queryClient: ReturnType<typeof createQueryClient>
} {
  vi.spyOn(authProvider, 'useAuthSession').mockReturnValue(authSession)
  const queryClient = createQueryClient({ isTest: true })
  queryClient.setQueryData(['session', 'web-account-email-verification-challenge'], initialChallenge)
  const renderResult = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <WebAccountPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return {
    ...renderResult,
    queryClient,
  }
}

function renderShellRouterWithAuth({
  route = '/web-account',
  initialChallenge = null,
}: {
  readonly route?: string
  readonly initialChallenge?: Awaited<ReturnType<typeof sessionApi.issueWebAccountEmailVerificationChallenge>> | null
} = {}): RenderResult & { readonly router: ReturnType<typeof createMemoryRouter> } {
  const router = createMemoryRouter(appRoutes, {
    initialEntries: [route],
  })
  const queryClient = createQueryClient({ isTest: true })
  queryClient.setQueryData(['session', 'web-account-email-verification-challenge'], initialChallenge)
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

describe('WebAccountPage', () => {
  beforeEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.clearAllMocks()
    vi.mocked(usePlansQuery).mockReturnValue(createPlansQuery())
    vi.mocked(useSubscriptionQuery).mockReturnValue(createSubscriptionQuery())
    vi.mocked(usePlatformPolicyQuery).mockReturnValue(createPlatformPolicyQuery())
  })

  it('shows the login and password handoff form for actionable linked web-account states', () => {
    vi.spyOn(authProvider, 'useAuthSession').mockReturnValue(
      createAuthSession({
        status: 'authenticated',
        sessionQuery: {
          data: createSessionData({
            webAccount: createSessionWebAccount({
              requiresPasswordChange: true,
            }),
          }),
          error: null,
          isPending: false,
        },
      }),
    )

    const { getByLabelText, getByRole } = renderWebAccountPage()

    expect(getByLabelText('Login')).toHaveValue('rezeis-user')
    expect(getByLabelText('Password')).toBeInTheDocument()
    expect(getByLabelText('Confirm password')).toBeInTheDocument()
    expect(getByRole('button', { name: 'Save login and password' })).toBeInTheDocument()
  })

  it('shows optional verification state for an unverified linked account', () => {
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

    const { getByRole, getByText } = renderWebAccountPage()

    expect(getByText('Optional email verification is available.')).toBeInTheDocument()
    expect(getByText('Linked email').closest('div')).toHaveTextContent('user@rezeis.test')
    expect(getByRole('button', { name: 'Issue verification challenge' })).toBeInTheDocument()
  })

  it('demotes linked email verification copy while credential handoff is still incomplete', () => {
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

    const { getByText, queryByRole, queryByText } = renderWebAccountPage()

    expect(getByText('Credential handoff required')).toBeInTheDocument()
    expect(getByText('Optional email follow-up comes after the credential handoff.')).toBeInTheDocument()
    expect(getByText('Finish the linked login and password handoff first. Optional linked-email verification can follow afterward without leaving the authenticated shell.')).toBeInTheDocument()
    expect(queryByRole('button', { name: 'Issue verification challenge' })).not.toBeInTheDocument()
    expect(queryByText('Optional email verification is available.')).not.toBeInTheDocument()
  })

  it('keeps resend and completion available when a verification challenge is already active during credential handoff', async () => {
    vi.spyOn(sessionApi, 'getSession').mockResolvedValue(createSessionData({
      webAccount: createSessionWebAccount({
        login: null,
        loginNormalized: null,
        emailVerifiedAt: null,
      }),
    }))

    const { getByRole, getByText } = renderWebAccountPageWithAuthProvider({
      initialChallenge: createEmailVerificationChallenge(),
    })

    await waitFor(() => {
      expect(getByRole('button', { name: 'Resend verification email' })).toBeInTheDocument()
    })

    expect(getByRole('button', { name: 'Complete email verification' })).toBeInTheDocument()
    expect(getByText('Optional email follow-up comes after the credential handoff.')).toBeInTheDocument()
  })

  it('hides the verification CTA when the linked account has no email address', () => {
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

    const { getByText, queryByRole } = renderWebAccountPage()

    expect(getByText('Linked email is not available.')).toBeInTheDocument()
    expect(queryByRole('button', { name: 'Issue verification challenge' })).not.toBeInTheDocument()
    expect(queryByRole('button', { name: 'Resend verification email' })).not.toBeInTheDocument()
  })

  it('reconciles linked email state when issuance returns a missing-email fallback payload', async () => {
    const initialSession = createSessionData({
      webAccount: createSessionWebAccount({
        email: null,
        emailNormalized: 'normalized@rezeis.test',
        emailVerifiedAt: null,
      }),
    })
    vi.spyOn(sessionApi, 'getSession').mockResolvedValue(initialSession)
    const issueChallengeSpy = vi.spyOn(sessionApi, 'issueWebAccountEmailVerificationChallenge').mockResolvedValue(createEmailVerificationChallenge({
      email: null,
      challengeExpiresAt: null,
      emailVerifiedAt: null,
    }))

    const { getByRole, getByText, queryByRole, queryByText } = renderWebAccountPageWithAuthProvider()

    await waitFor(() => {
      expect(getByRole('button', { name: 'Issue verification challenge' })).toBeInTheDocument()
    })

    expect(getByText('Linked email').closest('div')).toHaveTextContent('normalized@rezeis.test')

    fireEvent.click(getByRole('button', { name: 'Issue verification challenge' }))

    await waitFor(() => {
      expect(issueChallengeSpy).toHaveBeenCalledTimes(1)
    })

    expect(getByText('Linked email is not available.')).toBeInTheDocument()
    expect(getByText('Linked email').closest('div')).toHaveTextContent('Not set')
    expect(queryByRole('button', { name: 'Issue verification challenge' })).not.toBeInTheDocument()
    expect(queryByText('Verification email issued.')).not.toBeInTheDocument()
  })

  it('shows the verification code completion form when a pending challenge is actionable', async () => {
    vi.spyOn(sessionApi, 'getSession').mockResolvedValue(createSessionData({
      webAccount: createSessionWebAccount({
        emailVerifiedAt: null,
      }),
    }))

    const { getByLabelText, getByRole } = renderWebAccountPageWithAuthProvider({
      initialChallenge: createEmailVerificationChallenge(),
    })

    await waitFor(() => {
      expect(getByLabelText('Verification code')).toBeInTheDocument()
    })

    expect(getByRole('button', { name: 'Complete email verification' })).toBeInTheDocument()
  })

  it('clears the cached pending challenge when the current linked email no longer matches the challenge email', async () => {
    const { queryClient, queryByRole } = renderWebAccountPageWithMockedAuthSession({
      authSession: createAuthSession({
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
      initialChallenge: createEmailVerificationChallenge({
        email: 'old-email@rezeis.test',
      }),
    })

    await waitFor(() => {
      expect(queryClient.getQueryData(['session', 'web-account-email-verification-challenge'])).toBeNull()
    })

    expect(queryByRole('button', { name: 'Complete email verification' })).not.toBeInTheDocument()
    expect(queryByRole('button', { name: 'Issue verification challenge' })).toBeInTheDocument()
  })

  it('clears the cached pending challenge when auth is no longer authenticated', async () => {
    const { queryClient, queryByRole } = renderWebAccountPageWithMockedAuthSession({
      authSession: createAuthSession(),
      initialChallenge: createEmailVerificationChallenge(),
    })

    await waitFor(() => {
      expect(queryClient.getQueryData(['session', 'web-account-email-verification-challenge'])).toBeNull()
    })

    expect(queryByRole('button', { name: 'Complete email verification' })).not.toBeInTheDocument()
  })

  it('clears the cached pending challenge when the authenticated session no longer supports it', async () => {
    const { queryClient, queryByRole } = renderWebAccountPageWithMockedAuthSession({
      authSession: createAuthSession({
        status: 'authenticated',
        sessionQuery: {
          data: createSessionData({
            webAccount: createSessionWebAccount({
              id: 'web-account-2',
              emailVerifiedAt: null,
            }),
          }),
          error: null,
          isPending: false,
        },
      }),
      initialChallenge: createEmailVerificationChallenge(),
    })

    await waitFor(() => {
      expect(queryClient.getQueryData(['session', 'web-account-email-verification-challenge'])).toBeNull()
    })

    expect(queryByRole('button', { name: 'Complete email verification' })).not.toBeInTheDocument()
  })

  it('clears the cached pending challenge when the linked account is already verified', async () => {
    const { queryClient, queryByRole } = renderWebAccountPageWithMockedAuthSession({
      authSession: createAuthSession({
        status: 'authenticated',
        sessionQuery: {
          data: createSessionData({
            webAccount: createSessionWebAccount({
              emailVerifiedAt: '2026-04-18T10:00:00.000Z',
            }),
          }),
          error: null,
          isPending: false,
        },
      }),
      initialChallenge: createEmailVerificationChallenge(),
    })

    await waitFor(() => {
      expect(queryClient.getQueryData(['session', 'web-account-email-verification-challenge'])).toBeNull()
    })

    expect(queryByRole('button', { name: 'Complete email verification' })).not.toBeInTheDocument()
  })

  it('clears the cached pending challenge when the linked account no longer has a usable email', async () => {
    const { queryClient, queryByRole } = renderWebAccountPageWithMockedAuthSession({
      authSession: createAuthSession({
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
      initialChallenge: createEmailVerificationChallenge(),
    })

    await waitFor(() => {
      expect(queryClient.getQueryData(['session', 'web-account-email-verification-challenge'])).toBeNull()
    })

    expect(queryByRole('button', { name: 'Complete email verification' })).not.toBeInTheDocument()
  })

  it('reconciles verified session state when issuance returns a verified fallback payload', async () => {
    const initialSession = createSessionData({
      webAccount: createSessionWebAccount({
        emailVerifiedAt: null,
      }),
    })
    vi.spyOn(sessionApi, 'getSession').mockResolvedValue(initialSession)
    const issueChallengeSpy = vi.spyOn(sessionApi, 'issueWebAccountEmailVerificationChallenge').mockResolvedValue(createEmailVerificationChallenge({
      challengeExpiresAt: null,
      emailVerifiedAt: '2026-04-17T12:15:00.000Z',
    }))

    const { getByRole, getByText, queryByRole } = renderWebAccountPageWithAuthProvider()

    await waitFor(() => {
      expect(getByRole('button', { name: 'Issue verification challenge' })).toBeInTheDocument()
    })

    fireEvent.click(getByRole('button', { name: 'Issue verification challenge' }))

    await waitFor(() => {
      expect(issueChallengeSpy).toHaveBeenCalledTimes(1)
    })
    expect(getByText('Linked email already verified.')).toBeInTheDocument()
    expect(getByText('Email verified').closest('div')).toHaveTextContent('Apr 17, 2026')
    expect(queryByRole('button', { name: 'Issue verification challenge' })).not.toBeInTheDocument()
  })

  it('reconciles to the unlinked state when issuance returns a missing-web-account fallback payload', async () => {
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

    const { getByRole, getByText, queryByText } = renderWebAccountPageWithAuthProvider()

    await waitFor(() => {
      expect(getByRole('button', { name: 'Issue verification challenge' })).toBeInTheDocument()
    })

    fireEvent.click(getByRole('button', { name: 'Issue verification challenge' }))

    await waitFor(() => {
      expect(issueChallengeSpy).toHaveBeenCalledTimes(1)
    })

    expect(getByText('No linked web account is available for credential handoff.')).toBeInTheDocument()
    expect(queryByText('Optional email verification is available.')).not.toBeInTheDocument()
  })

  it('hides the password handoff form for non-actionable linked web-account states', () => {
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

    const { getByText, queryByRole } = renderWebAccountPage()

    expect(getByText('No credential handoff is currently required.')).toBeInTheDocument()
    expect(queryByRole('button', { name: 'Save login and password' })).not.toBeInTheDocument()
  })

  it('shows an unlinked state instead of the completed state when no linked web account exists', () => {
    vi.spyOn(authProvider, 'useAuthSession').mockReturnValue(
      createAuthSession({
        status: 'authenticated',
        sessionQuery: {
          data: createSessionData({ webAccount: null }),
          error: null,
          isPending: false,
        },
      }),
    )

    const { getByText, queryByRole, queryByText } = renderWebAccountPage()

    expect(getByText('No linked web account is available for credential handoff.')).toBeInTheDocument()
    expect(queryByText('No credential handoff is currently required.')).not.toBeInTheDocument()
    expect(queryByRole('button', { name: 'Save login and password' })).not.toBeInTheDocument()
  })

  it('shows the existing auth-required fallback when the session is unauthorized', () => {
    vi.spyOn(authProvider, 'useAuthSession').mockReturnValue(createAuthSession())

    const { getByText } = renderWebAccountPage()

    expect(getByText('Authentication required')).toBeInTheDocument()
    expect(getByText(/Open this workspace from the Telegram Mini App or reuse an existing browser session/)).toBeInTheDocument()
  })

  it('prevents submit when login is missing', () => {
    const handoffSpy = vi.spyOn(sessionApi, 'handoffWebAccountPassword')
    vi.spyOn(authProvider, 'useAuthSession').mockReturnValue(
      createAuthSession({
        status: 'authenticated',
        sessionQuery: {
          data: createSessionData({
            webAccount: createSessionWebAccount({
              login: null,
              loginNormalized: null,
              credentialsBootstrappedAt: null,
            }),
          }),
          error: null,
          isPending: false,
        },
      }),
    )

    const { getByLabelText, getByRole, getByText } = renderWebAccountPage()

    fireEvent.change(getByLabelText('Login'), { target: { value: '   ' } })
    fireEvent.change(getByLabelText('Password'), { target: { value: 'new-password-123' } })
    fireEvent.change(getByLabelText('Confirm password'), { target: { value: 'new-password-123' } })
    fireEvent.click(getByRole('button', { name: 'Save login and password' }))

    expect(getByText('Login is required before you continue.')).toBeInTheDocument()
    expect(handoffSpy).not.toHaveBeenCalled()
  })

  it('prevents submit when login does not match the allowed backend-shaped format', () => {
    const handoffSpy = vi.spyOn(sessionApi, 'handoffWebAccountPassword')
    vi.spyOn(authProvider, 'useAuthSession').mockReturnValue(
      createAuthSession({
        status: 'authenticated',
        sessionQuery: {
          data: createSessionData({
            webAccount: createSessionWebAccount({
              login: null,
              loginNormalized: null,
              credentialsBootstrappedAt: null,
            }),
          }),
          error: null,
          isPending: false,
        },
      }),
    )

    const { getByLabelText, getByRole, getByText } = renderWebAccountPage()

    fireEvent.change(getByLabelText('Login'), { target: { value: 'ab!' } })
    fireEvent.change(getByLabelText('Password'), { target: { value: 'new-password-123' } })
    fireEvent.change(getByLabelText('Confirm password'), { target: { value: 'new-password-123' } })
    fireEvent.click(getByRole('button', { name: 'Save login and password' }))

    expect(getByText('Enter a login with 3-64 letters, numbers, dots, underscores, or hyphens.')).toBeInTheDocument()
    expect(handoffSpy).not.toHaveBeenCalled()
  })

  it('prevents submit when confirmation does not match', () => {
    const handoffSpy = vi.spyOn(sessionApi, 'handoffWebAccountPassword')
    vi.spyOn(authProvider, 'useAuthSession').mockReturnValue(
      createAuthSession({
        status: 'authenticated',
        sessionQuery: {
          data: createSessionData({
            webAccount: createSessionWebAccount({
              credentialsBootstrappedAt: null,
            }),
          }),
          error: null,
          isPending: false,
        },
      }),
    )

    const { getByLabelText, getByRole, getByText } = renderWebAccountPage()

    fireEvent.change(getByLabelText('Login'), { target: { value: 'rezeis-user' } })
    fireEvent.change(getByLabelText('Password'), { target: { value: 'new-password-123' } })
    fireEvent.change(getByLabelText('Confirm password'), { target: { value: 'different-password-123' } })
    fireEvent.click(getByRole('button', { name: 'Save login and password' }))

    expect(getByText('Passwords must match before you continue.')).toBeInTheDocument()
    expect(handoffSpy).not.toHaveBeenCalled()
  })

  it('prevents verification submit when the code is not a 6-digit numeric string', async () => {
    const completionSpy = vi.spyOn(sessionApi, 'completeWebAccountEmailVerification')
    vi.spyOn(sessionApi, 'getSession').mockResolvedValue(createSessionData({
      webAccount: createSessionWebAccount({
        emailVerifiedAt: null,
      }),
    }))

    const { getByLabelText, getByRole, getByText } = renderWebAccountPageWithAuthProvider({
      initialChallenge: createEmailVerificationChallenge(),
    })

    await waitFor(() => {
      expect(getByRole('button', { name: 'Complete email verification' })).toBeInTheDocument()
    })

    fireEvent.change(getByLabelText('Verification code'), { target: { value: '12ab' } })
    fireEvent.click(getByRole('button', { name: 'Complete email verification' }))

    expect(getByText('Enter the 6-digit verification code from your email.')).toBeInTheDocument()
    expect(completionSpy).not.toHaveBeenCalled()
  })

  it('trims surrounding whitespace before submitting a verification code', async () => {
    const completionSpy = vi.spyOn(sessionApi, 'completeWebAccountEmailVerification').mockResolvedValue(createSessionData({
      webAccount: createSessionWebAccount({
        emailVerifiedAt: '2026-04-18T10:00:00.000Z',
      }),
    }))
    vi.spyOn(sessionApi, 'getSession').mockResolvedValue(createSessionData({
      webAccount: createSessionWebAccount({
        emailVerifiedAt: null,
      }),
    }))

    const { getByLabelText, getByRole } = renderWebAccountPageWithAuthProvider({
      initialChallenge: createEmailVerificationChallenge(),
    })

    await waitFor(() => {
      expect(getByRole('button', { name: 'Complete email verification' })).toBeInTheDocument()
    })

    fireEvent.change(getByLabelText('Verification code'), { target: { value: ' 123456 ' } })
    fireEvent.click(getByRole('button', { name: 'Complete email verification' }))

    await waitFor(() => {
      expect(completionSpy).toHaveBeenCalledWith({ code: '123456' })
    })
  })

  it('clears the pending verification challenge when completion reports that no active challenge exists', async () => {
    const completionError = createApiError({ message: 'active email verification challenge not found' })
    vi.spyOn(sessionApi, 'completeWebAccountEmailVerification').mockRejectedValue(completionError)
    vi.spyOn(sessionApi, 'getSession').mockResolvedValue(createSessionData({
      webAccount: createSessionWebAccount({
        emailVerifiedAt: null,
      }),
    }))

    const { getByLabelText, getByRole, queryByRole, queryByText } = renderWebAccountPageWithAuthProvider({
      initialChallenge: createEmailVerificationChallenge(),
    })

    await waitFor(() => {
      expect(getByRole('button', { name: 'Complete email verification' })).toBeInTheDocument()
    })

    fireEvent.change(getByLabelText('Verification code'), { target: { value: '123456' } })
    fireEvent.click(getByRole('button', { name: 'Complete email verification' }))

    await waitFor(() => {
      expect(queryByRole('button', { name: 'Complete email verification' })).not.toBeInTheDocument()
    })
    expect(queryByText('active email verification challenge not found')).not.toBeInTheDocument()
    expect(getByRole('button', { name: 'Issue verification challenge' })).toBeInTheDocument()
  })

  it('refreshes the visible session state after a successful password handoff', async () => {
    const initialSession = createSessionData({
      webAccount: createSessionWebAccount({
        requiresPasswordChange: true,
        credentialsBootstrappedAt: null,
      }),
    })
    const refreshedSession = createSessionData({
      webAccount: createSessionWebAccount({
        requiresPasswordChange: false,
        credentialsBootstrappedAt: '2026-04-17T12:00:00.000Z',
        linkPromptSnoozeUntil: null,
      }),
    })
    const getSessionSpy = vi.spyOn(sessionApi, 'getSession').mockResolvedValue(initialSession)
    const handoffSpy = vi.spyOn(sessionApi, 'handoffWebAccountPassword').mockResolvedValue(refreshedSession)

    const { getByLabelText, getByRole, getByText, queryByRole } = renderWebAccountPageWithAuthProvider()

    await waitFor(() => {
      expect(getByRole('button', { name: 'Save login and password' })).toBeInTheDocument()
    })

    fireEvent.change(getByLabelText('Login'), { target: { value: 'next-login' } })
    fireEvent.change(getByLabelText('Password'), { target: { value: 'new-password-123' } })
    fireEvent.change(getByLabelText('Confirm password'), { target: { value: 'new-password-123' } })
    fireEvent.click(getByRole('button', { name: 'Save login and password' }))

    await waitFor(() => {
      expect(handoffSpy).toHaveBeenCalledWith({ login: 'next-login', password: 'new-password-123' })
    })
    await waitFor(() => {
      expect(queryByRole('button', { name: 'Save login and password' })).not.toBeInTheDocument()
    })

    expect(getSessionSpy).toHaveBeenCalledTimes(1)
    expect(getByText('No credential handoff is currently required.')).toBeInTheDocument()
    expect(getByText('Web account login').closest('div')).toHaveTextContent('rezeis-user')
    expect(getByText('Credentials bootstrapped').closest('div')).toHaveTextContent('Apr 17, 2026')
  })

  it('trims surrounding whitespace before submitting a login', async () => {
    const refreshedSession = createSessionData({
      webAccount: createSessionWebAccount({
        login: 'trimmed-user',
        loginNormalized: 'trimmed-user',
        requiresPasswordChange: false,
        credentialsBootstrappedAt: '2026-04-17T12:00:00.000Z',
      }),
    })
    vi.spyOn(sessionApi, 'getSession').mockResolvedValue(createSessionData({
      webAccount: createSessionWebAccount({
        login: null,
        loginNormalized: null,
        requiresPasswordChange: true,
        credentialsBootstrappedAt: null,
      }),
    }))
    const handoffSpy = vi.spyOn(sessionApi, 'handoffWebAccountPassword').mockResolvedValue(refreshedSession)

    const { getByLabelText, getByRole } = renderWebAccountPageWithAuthProvider()

    await waitFor(() => {
      expect(getByRole('button', { name: 'Save login and password' })).toBeInTheDocument()
    })

    fireEvent.change(getByLabelText('Login'), { target: { value: '  trimmed-user  ' } })
    fireEvent.change(getByLabelText('Password'), { target: { value: 'new-password-123' } })
    fireEvent.change(getByLabelText('Confirm password'), { target: { value: 'new-password-123' } })
    fireEvent.click(getByRole('button', { name: 'Save login and password' }))

    await waitFor(() => {
      expect(handoffSpy).toHaveBeenCalledWith({ login: 'trimmed-user', password: 'new-password-123' })
    })
  })

  it('shows pending verification state after issuing a linked email verification challenge', async () => {
    const initialSession = createSessionData({
      webAccount: createSessionWebAccount({
        emailVerifiedAt: null,
      }),
    })
    const getSessionSpy = vi.spyOn(sessionApi, 'getSession').mockResolvedValue(initialSession)
    const issueChallengeSpy = vi.spyOn(sessionApi, 'issueWebAccountEmailVerificationChallenge').mockResolvedValue(createEmailVerificationChallenge())

    const { getByRole, getByText } = renderWebAccountPageWithAuthProvider()

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
    expect(getByText('Verification email issued.')).toBeInTheDocument()
    expect(getByText('Pending challenge expires').closest('div')).toHaveTextContent('Apr 20, 2026')
  })

  it('refreshes the visible session state after a successful email verification completion', async () => {
    const initialSession = createSessionData({
      webAccount: createSessionWebAccount({
        emailVerifiedAt: null,
      }),
    })
    const refreshedSession = createSessionData({
      webAccount: createSessionWebAccount({
        emailVerifiedAt: '2026-04-18T10:00:00.000Z',
      }),
    })
    const getSessionSpy = vi.spyOn(sessionApi, 'getSession').mockResolvedValue(initialSession)
    const completionSpy = vi.spyOn(sessionApi, 'completeWebAccountEmailVerification').mockResolvedValue(refreshedSession)

    const { getByLabelText, getByRole, getByText, queryByRole } = renderWebAccountPageWithAuthProvider({
      initialChallenge: createEmailVerificationChallenge(),
    })

    await waitFor(() => {
      expect(getByRole('button', { name: 'Complete email verification' })).toBeInTheDocument()
    })

    fireEvent.change(getByLabelText('Verification code'), { target: { value: '123456' } })
    fireEvent.click(getByRole('button', { name: 'Complete email verification' }))

    await waitFor(() => {
      expect(completionSpy).toHaveBeenCalledWith({ code: '123456' })
    })
    await waitFor(() => {
      expect(queryByRole('button', { name: 'Complete email verification' })).not.toBeInTheDocument()
    })

    expect(getSessionSpy).toHaveBeenCalledTimes(1)
    expect(getByText('Linked email already verified.')).toBeInTheDocument()
    expect(getByText('Email verified').closest('div')).toHaveTextContent('Apr 18, 2026')
  })

  it('keeps the issued verification state when navigating from web-account to dashboard inside one shell session', async () => {
    const initialSession = createSessionData({
      webAccount: createSessionWebAccount({
        emailVerifiedAt: null,
      }),
    })
    vi.spyOn(sessionApi, 'getSession').mockResolvedValue(initialSession)
    const issueChallengeSpy = vi.spyOn(sessionApi, 'issueWebAccountEmailVerificationChallenge').mockResolvedValue(createEmailVerificationChallenge())

    const { getByRole, getByText, router } = renderShellRouterWithAuth({ route: '/web-account' })

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
      await router.navigate('/')
    })

    await waitFor(() => {
      expect(getByText(/Verification email issued for user@rezeis.test/)).toBeInTheDocument()
    })
    expect(getByRole('link', { name: 'Enter verification code' })).toHaveAttribute('href', '/web-account')
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
    vi.spyOn(sessionApi, 'getSession').mockResolvedValue(initialSession)
    const issueChallengeSpy = vi.spyOn(sessionApi, 'issueWebAccountEmailVerificationChallenge').mockResolvedValue(
      createEmailVerificationChallenge({
        challengeExpiresAt: '2026-04-17T12:05:00.000Z',
      }),
    )

    const { getByRole, queryByText } = renderWebAccountPageWithAuthProvider()

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
    expect(queryByText('Verification email issued.')).not.toBeInTheDocument()
  })

  it('falls back to auth-required state after an unauthorized verification challenge failure', async () => {
    const unauthorizedError = createUnauthorizedError()
    const getSessionSpy = vi.spyOn(sessionApi, 'getSession').mockResolvedValueOnce(
      createSessionData({
        webAccount: createSessionWebAccount({
          emailVerifiedAt: null,
        }),
      }),
    ).mockRejectedValue(unauthorizedError)
    const issueChallengeSpy = vi.spyOn(sessionApi, 'issueWebAccountEmailVerificationChallenge').mockRejectedValue(unauthorizedError)

    const { getAllByText, getByRole, queryByRole } = renderWebAccountPageWithAuthProvider()

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
    })
  })

  it('falls back to auth-required state after an unauthorized verification completion failure', async () => {
    const unauthorizedError = createUnauthorizedError()
    const getSessionSpy = vi.spyOn(sessionApi, 'getSession').mockResolvedValueOnce(
      createSessionData({
        webAccount: createSessionWebAccount({
          emailVerifiedAt: null,
        }),
      }),
    ).mockRejectedValue(unauthorizedError)
    const completionSpy = vi.spyOn(sessionApi, 'completeWebAccountEmailVerification').mockRejectedValue(unauthorizedError)

    const { getAllByText, getByLabelText, getByRole, queryByRole } = renderWebAccountPageWithAuthProvider({
      initialChallenge: createEmailVerificationChallenge(),
    })

    await waitFor(() => {
      expect(getByRole('button', { name: 'Complete email verification' })).toBeInTheDocument()
    })

    fireEvent.change(getByLabelText('Verification code'), { target: { value: '123456' } })
    fireEvent.click(getByRole('button', { name: 'Complete email verification' }))

    await waitFor(() => {
      expect(completionSpy).toHaveBeenCalledTimes(1)
    })
    await waitFor(() => {
      expect(getSessionSpy).toHaveBeenCalledTimes(2)
    })
    await waitFor(() => {
      expect(getAllByText('Authentication required').length).toBeGreaterThan(0)
      expect(queryByRole('button', { name: 'Complete email verification' })).not.toBeInTheDocument()
    })
  })

  it('keeps the completed verification state visible after navigating back to the dashboard inside one shell session', async () => {
    const initialSession = createSessionData({
      webAccount: createSessionWebAccount({
        emailVerifiedAt: null,
      }),
    })
    const refreshedSession = createSessionData({
      webAccount: createSessionWebAccount({
        emailVerifiedAt: '2026-04-18T10:00:00.000Z',
      }),
    })
    vi.spyOn(sessionApi, 'getSession').mockResolvedValue(initialSession)
    const completionSpy = vi.spyOn(sessionApi, 'completeWebAccountEmailVerification').mockResolvedValue(refreshedSession)

    const { getByLabelText, getByText, getByRole, queryByRole, router } = renderShellRouterWithAuth({
      route: '/web-account',
      initialChallenge: createEmailVerificationChallenge(),
    })

    await waitFor(() => {
      expect(getByRole('button', { name: 'Complete email verification' })).toBeInTheDocument()
    })

    fireEvent.change(getByLabelText('Verification code'), { target: { value: '123456' } })
    fireEvent.click(getByRole('button', { name: 'Complete email verification' }))

    await waitFor(() => {
      expect(completionSpy).toHaveBeenCalledWith({ code: '123456' })
    })
    await waitFor(() => {
      expect(queryByRole('button', { name: 'Complete email verification' })).not.toBeInTheDocument()
    })

    await act(async () => {
      await router.navigate('/')
    })

    await waitFor(() => {
      expect(getByText('Email verified').closest('div')).toHaveTextContent('Apr 18, 2026')
    })
    expect(queryByRole('button', { name: 'Issue verification challenge' })).not.toBeInTheDocument()
  })

  it('falls back to auth-required state after an unauthorized password handoff failure', async () => {
    const unauthorizedError = createUnauthorizedError()
    const getSessionSpy = vi.spyOn(sessionApi, 'getSession').mockResolvedValueOnce(
      createSessionData({
        webAccount: createSessionWebAccount({
          requiresPasswordChange: true,
          credentialsBootstrappedAt: null,
        }),
      }),
    ).mockRejectedValue(unauthorizedError)
    const handoffSpy = vi.spyOn(sessionApi, 'handoffWebAccountPassword').mockRejectedValue(unauthorizedError)

    const { getAllByText, getByLabelText, getByRole, queryByRole } = renderWebAccountPageWithAuthProvider()

    await waitFor(() => {
      expect(getByRole('button', { name: 'Save login and password' })).toBeInTheDocument()
    })

    fireEvent.change(getByLabelText('Login'), { target: { value: 'rezeis-user' } })
    fireEvent.change(getByLabelText('Password'), { target: { value: 'new-password-123' } })
    fireEvent.change(getByLabelText('Confirm password'), { target: { value: 'new-password-123' } })
    fireEvent.click(getByRole('button', { name: 'Save login and password' }))

    await waitFor(() => {
      expect(handoffSpy).toHaveBeenCalledTimes(1)
    })
    await waitFor(() => {
      expect(getSessionSpy).toHaveBeenCalledTimes(2)
    })
    await waitFor(() => {
      expect(getAllByText('Authentication required').length).toBeGreaterThan(0)
      expect(queryByRole('button', { name: 'Save login and password' })).not.toBeInTheDocument()
    })
  })
})
