import type { ReactElement } from 'react'
import { useEffect } from 'react'
import { screen, waitFor } from '@testing-library/react'
import { AxiosError } from 'axios'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider, useAuthSession } from '@/features/auth/auth-provider'
import { authApi } from '@/features/auth/auth-api'
import { AuthRequiredState } from '@/features/auth/auth-required-state'
import { sessionApi } from '@/features/session/session-api'
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

interface AuthProbeProps {
  readonly onStatusChange: (status: string) => void
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
    webAccount: null,
  }
}

function AuthProbe({ onStatusChange }: AuthProbeProps): ReactElement {
  const authSession = useAuthSession()
  useEffect(() => {
    onStatusChange(authSession.status)
  }, [authSession.status, onStatusChange])
  return (
    <>
      <div data-testid="auth-status">{authSession.status}</div>
      <div data-testid="auth-persistence-issue">{String(authSession.hasSessionPersistenceIssue)}</div>
      <div data-testid="auth-bootstrap-error">{String(authSession.bootstrapError instanceof Error ? authSession.bootstrapError.message : authSession.bootstrapError ?? '')}</div>
    </>
  )
}

function AuthenticationRequiredProbe(): ReactElement | null {
  const authSession = useAuthSession()
  if (authSession.status !== 'authentication-required') {
    return null
  }
  return <AuthRequiredState />
}

describe('AuthProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getTelegramWebApp).mockReturnValue(null)
    vi.mocked(loadTelegramWebAppScript).mockResolvedValue(undefined)
    vi.mocked(getTelegramLaunchInitData).mockReturnValue(null)
    vi.mocked(getTelegramBootstrapInitData).mockReturnValue(null)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('bootstraps a Telegram session and transitions to authenticated', async () => {
    const observedStatuses: string[] = []
    let sessionCallCount = 0
    vi.mocked(getTelegramLaunchInitData).mockReturnValue('launch-init-data')
    vi.mocked(getTelegramBootstrapInitData).mockReturnValue('telegram-init-data')
    vi.spyOn(sessionApi, 'getSession').mockImplementation(async () => {
      sessionCallCount += 1
      if (sessionCallCount === 1) {
        throw createUnauthorizedError()
      }
      return createSession()
    })
    const bootstrapSpy = vi.spyOn(authApi, 'bootstrapTelegramSession').mockResolvedValue(undefined)

    renderWithProviders(
      <AuthProvider>
        <AuthProbe onStatusChange={(status: string) => observedStatuses.push(status)} />
      </AuthProvider>,
      { withRouter: false },
    )

    await waitFor(() => {
      expect(screen.getByTestId('auth-status')).toHaveTextContent('authenticated')
    })

    expect(bootstrapSpy).toHaveBeenCalledTimes(1)
    expect(bootstrapSpy).toHaveBeenCalledWith(
      { initData: 'telegram-init-data' },
      expect.anything(),
    )
    expect(observedStatuses).toContain('loading')
    expect(observedStatuses.at(-1)).toBe('authenticated')
  })

  it('stays in authentication-required when no Telegram launch data exists', async () => {
    vi.spyOn(sessionApi, 'getSession').mockRejectedValue(createUnauthorizedError())
    const bootstrapSpy = vi.spyOn(authApi, 'bootstrapTelegramSession').mockResolvedValue(undefined)

    renderWithProviders(
      <AuthProvider>
        <AuthProbe onStatusChange={() => undefined} />
        <AuthenticationRequiredProbe />
      </AuthProvider>,
      { withRouter: false },
    )

    await waitFor(() => {
      expect(screen.getByTestId('auth-status')).toHaveTextContent('authentication-required')
    })

    expect(bootstrapSpy).not.toHaveBeenCalled()
    expect(screen.getByTestId('auth-persistence-issue')).toHaveTextContent('false')
    expect(screen.getByText(/open this workspace from the Telegram Mini App/i)).toBeInTheDocument()
    expect(screen.queryByText(/this browser did not retain the cookie-backed session/i)).not.toBeInTheDocument()
  })

  it('surfaces an error when the Telegram runtime script fails after launch detection', async () => {
    vi.mocked(getTelegramLaunchInitData)
      .mockReturnValueOnce('launch-init-data')
      .mockReturnValueOnce('launch-init-data')
      .mockReturnValueOnce(null)
    vi.mocked(loadTelegramWebAppScript).mockRejectedValue(new Error('Telegram runtime failed to load'))
    vi.spyOn(sessionApi, 'getSession').mockResolvedValue(undefined as never)

    renderWithProviders(
      <AuthProvider>
        <AuthProbe onStatusChange={() => undefined} />
      </AuthProvider>,
      { withRouter: false },
    )

    await waitFor(() => {
      expect(screen.getByTestId('auth-status')).toHaveTextContent('error')
    })

    expect(screen.getByTestId('auth-bootstrap-error')).toHaveTextContent('Telegram runtime failed to load')
  })

  it('surfaces an error when Telegram bootstrap fails with a non-401 response', async () => {
    vi.useFakeTimers()
    vi.mocked(getTelegramLaunchInitData).mockReturnValue('launch-init-data')
    vi.mocked(getTelegramBootstrapInitData).mockReturnValue('telegram-init-data')
    vi.spyOn(sessionApi, 'getSession').mockResolvedValue(undefined as never)
    const bootstrapSpy = vi.spyOn(authApi, 'bootstrapTelegramSession').mockRejectedValue(createServerError('Bootstrap failed'))

    renderWithProviders(
      <AuthProvider>
        <AuthProbe onStatusChange={() => undefined} />
      </AuthProvider>,
      { withRouter: false },
    )

    const statusPromise: Promise<void> = waitFor(() => {
      expect(screen.getByTestId('auth-status')).toHaveTextContent('error')
    })
    await vi.advanceTimersByTimeAsync(500)
    await statusPromise

    expect(bootstrapSpy).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('auth-bootstrap-error')).toHaveTextContent('Bootstrap failed')
  })

  it('marks a session persistence issue when bootstrap succeeds but the session remains unauthorized', async () => {
    vi.mocked(getTelegramLaunchInitData).mockReturnValue('launch-init-data')
    vi.mocked(getTelegramBootstrapInitData).mockReturnValue('telegram-init-data')
    vi.spyOn(sessionApi, 'getSession').mockRejectedValue(createUnauthorizedError())
    const bootstrapSpy = vi.spyOn(authApi, 'bootstrapTelegramSession').mockResolvedValue(undefined)

    renderWithProviders(
      <AuthProvider>
        <AuthProbe onStatusChange={() => undefined} />
        <AuthenticationRequiredProbe />
      </AuthProvider>,
      { withRouter: false },
    )

    await waitFor(() => {
      expect(screen.getByTestId('auth-status')).toHaveTextContent('authentication-required')
    })

    expect(bootstrapSpy).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('auth-persistence-issue')).toHaveTextContent('true')
    expect(screen.getByText(/this browser did not retain the cookie-backed session/i)).toBeInTheDocument()
    expect(screen.getByText(/recovery path: reopen the app from your bot chat/i)).toBeInTheDocument()
  })
})
