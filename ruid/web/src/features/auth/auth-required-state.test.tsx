import type { MockedFunction } from 'vitest'
import { describe, expect, it, vi } from 'vitest'
import { AuthRequiredState } from '@/features/auth/auth-required-state'
import { useAuthSession } from '@/features/auth/auth-provider'
import { renderWithProviders } from '@/test/render-app'

vi.mock('@/features/auth/auth-provider', () => ({
  useAuthSession: vi.fn(),
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

describe('AuthRequiredState', () => {
  it('renders the persistence recovery copy when Telegram bootstrap did not retain the session', () => {
    const mockedUseAuthSession: MockedFunction<typeof useAuthSession> = vi.mocked(useAuthSession)
    mockedUseAuthSession.mockReturnValue(createAuthSession({ hasSessionPersistenceIssue: true }))

    const { getByText } = renderWithProviders(<AuthRequiredState />, { withRouter: false })

    expect(getByText(/Telegram bootstrap completed, but this browser did not retain the cookie-backed session/i)).toBeInTheDocument()
  })

  it('renders the standard Telegram launch guidance when no persistence issue is present', () => {
    const mockedUseAuthSession: MockedFunction<typeof useAuthSession> = vi.mocked(useAuthSession)
    mockedUseAuthSession.mockReturnValue(createAuthSession())

    const { getByText } = renderWithProviders(<AuthRequiredState />, { withRouter: false })

    expect(getByText(/Open this workspace from the Telegram Mini App or reuse an existing browser session created by Telegram bootstrap/i)).toBeInTheDocument()
  })
})
