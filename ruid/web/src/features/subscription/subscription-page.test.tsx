import { act, screen, waitFor } from '@testing-library/react'
import { AxiosError } from 'axios'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider } from '@/features/auth/auth-provider'
import { sessionApi } from '@/features/session/session-api'
import { SubscriptionPage } from '@/features/subscription/subscription-page'
import { subscriptionApi } from '@/features/subscription/subscription-api'
import { renderWithProviders } from '@/test/render-app'

vi.mock('@/features/auth/telegram-web-app', () => ({
  getTelegramBootstrapInitData: vi.fn(),
  getTelegramLaunchInitData: vi.fn(),
  getTelegramWebApp: vi.fn(),
  loadTelegramWebAppScript: vi.fn(),
}))

import {
  getTelegramBootstrapInitData,
  getTelegramLaunchInitData,
  getTelegramWebApp,
  loadTelegramWebAppScript,
} from '@/features/auth/telegram-web-app'

type SessionData = Awaited<ReturnType<typeof sessionApi.getSession>>
type SubscriptionRecord = NonNullable<Awaited<ReturnType<typeof subscriptionApi.getSubscription>>>

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (reason?: unknown) => void
}

function createApiError({
  detail,
  message,
  status,
  statusText,
}: {
  readonly detail: string
  readonly message: string
  readonly status: number
  readonly statusText: string
}): AxiosError {
  const apiError = new AxiosError(message)
  Object.defineProperty(apiError, 'response', {
    value: {
      data: { detail },
      status,
      statusText,
      headers: {},
      config: {},
    },
  })
  return apiError
}

function createUnauthorizedError(): AxiosError {
  return createApiError({
    detail: 'Unauthorized',
    message: 'Unauthorized',
    status: 401,
    statusText: 'Unauthorized',
  })
}

function createServerError(detail: string): AxiosError {
  return createApiError({
    detail,
    message: detail,
    status: 500,
    statusText: 'Internal Server Error',
  })
}

function createDeferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | null = null
  let rejectPromise: ((reason?: unknown) => void) | null = null
  const promise: Promise<T> = new Promise<T>((resolve: (value: T) => void, reject: (reason?: unknown) => void) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  if (!resolvePromise || !rejectPromise) {
    throw new Error('Deferred promise handlers were not initialized.')
  }
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  }
}

function createSession(): SessionData {
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
    webAccount: {
      id: 'web-account-1',
      login: 'linked-login',
      loginNormalized: 'linked-login',
      email: 'linked@rezeis.test',
      emailNormalized: 'linked@rezeis.test',
      emailVerifiedAt: null,
      requiresPasswordChange: false,
      linkPromptSnoozeUntil: null,
      credentialsBootstrappedAt: '2026-04-01T12:00:00.000Z',
      createdAt: '2026-04-01T12:00:00.000Z',
      updatedAt: '2026-04-10T12:00:00.000Z',
    },
  }
}

function createSubscription(): SubscriptionRecord {
  return {
    id: 'subscription-1',
    status: 'ACTIVE',
    isTrial: true,
    plan: {
      name: 'Pro Trial',
      type: 'BOTH',
    },
    trafficLimit: 2147483648,
    deviceLimit: 2,
    configUrl: 'https://configs.rezeis.test/subscription-1',
    startedAt: '2026-04-10T12:00:00.000Z',
    expiresAt: '2999-04-18T12:00:00.000Z',
    createdAt: '2026-04-01T12:00:00.000Z',
    updatedAt: '2026-04-10T12:00:00.000Z',
  }
}

describe('SubscriptionPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getTelegramWebApp).mockReturnValue(null)
    vi.mocked(loadTelegramWebAppScript).mockResolvedValue(undefined)
    vi.mocked(getTelegramLaunchInitData).mockReturnValue(null)
    vi.mocked(getTelegramBootstrapInitData).mockReturnValue(null)
  })

  it('renders diagnostics cards from the current subscription payload', async () => {
    vi.spyOn(sessionApi, 'getSession').mockResolvedValue(createSession())
    vi.spyOn(subscriptionApi, 'getSubscription').mockResolvedValue(createSubscription())

    renderWithProviders(
      <AuthProvider>
        <SubscriptionPage />
      </AuthProvider>,
    )

    await waitFor(() => {
      expect(screen.getByText('Subscription diagnostics')).toBeInTheDocument()
    })

    expect(screen.getAllByText('Trial subscription').length).toBeGreaterThan(0)
    expect(screen.getByText('linked-login')).toBeInTheDocument()
    expect(screen.getByText('Config URL available')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'https://configs.rezeis.test/subscription-1' })).toBeInTheDocument()
    expect(screen.getByText('2 GiB traffic, 2 devices')).toBeInTheDocument()
    expect(screen.getByText("Current subscription status for the authenticated Telegram or cookie-backed session. This route remains a read-only surface; rules acceptance is the shell's only live write path.")).toBeInTheDocument()
  })

  it('renders loading states while auth and subscription data are still pending', async () => {
    const sessionDeferred: Deferred<SessionData> = createDeferred<SessionData>()
    const subscriptionDeferred: Deferred<SubscriptionRecord | null> = createDeferred<SubscriptionRecord | null>()
    vi.spyOn(sessionApi, 'getSession').mockReturnValue(sessionDeferred.promise)
    const getSubscriptionSpy = vi.spyOn(subscriptionApi, 'getSubscription').mockReturnValue(subscriptionDeferred.promise)

    renderWithProviders(
      <AuthProvider>
        <SubscriptionPage />
      </AuthProvider>,
    )

    expect(screen.getByText('Loading subscription...')).toBeInTheDocument()
    expect(screen.queryByText('Loading subscription details...')).not.toBeInTheDocument()
    expect(getSubscriptionSpy).not.toHaveBeenCalled()

    await act(async () => {
      sessionDeferred.resolve(createSession())
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(screen.getByText('Loading subscription details...')).toBeInTheDocument()
    })

    expect(getSubscriptionSpy).toHaveBeenCalledTimes(1)
  })

  it('renders the authentication-required state without surfacing the unauthorized API error', async () => {
    vi.spyOn(sessionApi, 'getSession').mockRejectedValue(createUnauthorizedError())
    const getSubscriptionSpy = vi.spyOn(subscriptionApi, 'getSubscription').mockResolvedValue(createSubscription())

    renderWithProviders(
      <AuthProvider>
        <SubscriptionPage />
      </AuthProvider>,
    )

    await waitFor(() => {
      expect(screen.getByText('Authentication required')).toBeInTheDocument()
    })

    expect(screen.getByText(/open this workspace from the Telegram Mini App/i)).toBeInTheDocument()
    expect(screen.queryByText('Unauthorized')).not.toBeInTheDocument()
    expect(screen.queryByText('Loading subscription details...')).not.toBeInTheDocument()
    expect(screen.queryByText('This user does not have a current subscription.')).not.toBeInTheDocument()
    expect(screen.queryByText('Subscription edge unavailable')).not.toBeInTheDocument()
    expect(screen.queryByText('Subscription diagnostics')).not.toBeInTheDocument()
    expect(getSubscriptionSpy).not.toHaveBeenCalled()
  })

  it('renders an empty state when the authenticated session has no current subscription', async () => {
    vi.spyOn(sessionApi, 'getSession').mockResolvedValue(createSession())
    vi.spyOn(subscriptionApi, 'getSubscription').mockResolvedValue(null)

    renderWithProviders(
      <AuthProvider>
        <SubscriptionPage />
      </AuthProvider>,
    )

    await waitFor(() => {
      expect(screen.getByText('This user does not have a current subscription.')).toBeInTheDocument()
    })

    expect(screen.queryByText('Loading subscription...')).not.toBeInTheDocument()
    expect(screen.queryByText('Loading subscription details...')).not.toBeInTheDocument()
    expect(screen.queryByText('Authentication required')).not.toBeInTheDocument()
    expect(screen.queryByText('Subscription edge unavailable')).not.toBeInTheDocument()
    expect(screen.queryByText('Subscription diagnostics')).not.toBeInTheDocument()
  })

  it('renders an API error message when subscription loading fails after authentication', async () => {
    vi.spyOn(sessionApi, 'getSession').mockResolvedValue(createSession())
    vi.spyOn(subscriptionApi, 'getSubscription').mockRejectedValue(createServerError('Subscription edge unavailable'))

    renderWithProviders(
      <AuthProvider>
        <SubscriptionPage />
      </AuthProvider>,
    )

    await waitFor(() => {
      expect(screen.getByText('Subscription edge unavailable')).toBeInTheDocument()
    })

    expect(screen.queryByText('Loading subscription...')).not.toBeInTheDocument()
    expect(screen.queryByText('Loading subscription details...')).not.toBeInTheDocument()
    expect(screen.queryByText('Authentication required')).not.toBeInTheDocument()
    expect(screen.queryByText('This user does not have a current subscription.')).not.toBeInTheDocument()
    expect(screen.queryByText('Subscription diagnostics')).not.toBeInTheDocument()
  })
})
