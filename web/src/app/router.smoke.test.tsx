// TODO(rezeis-rebuild): Re-enable once the matching backend contract is rebuilt under the new schema.
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from '@/App'
import { Providers } from '@/app/providers'
import type { useAuthMe as UseAuthMeFn } from '@/features/auth/use-auth-me'
import { useAuthStore } from '@/stores/auth-store'

vi.mock('@/features/auth/use-auth-me', () => ({
  useAuthMe: vi.fn(),
}))

function createAuthMeResult(overrides: Partial<ReturnType<typeof UseAuthMeFn>> = {}): ReturnType<typeof UseAuthMeFn> {
  return {
    data: undefined,
    error: null,
    isError: false,
    isLoading: false,
    isRefetching: false,
    isSuccess: false,
    refetch: vi.fn(),
    ...overrides,
  } as unknown as ReturnType<typeof UseAuthMeFn>
}
describe.skip('router smoke', () => {
  beforeEach(async () => {
    const { useAuthMe } = await import('@/features/auth/use-auth-me')
    vi.mocked(useAuthMe).mockReturnValue(createAuthMeResult())
  })

  it('renders login route for unauthenticated state', async () => {
    window.history.pushState({}, '', '/login')
    render(
      <Providers>
        <App />
      </Providers>,
    )

    expect(await screen.findByText('Admin sign in')).toBeInTheDocument()
  })

  it('renders dashboard route for verified authenticated state', async () => {
    useAuthStore.setState({
      token: 'admin-token',
      sessionRevision: 1,
      verifiedSessionRevision: 1,
      pendingLoginRevision: null,
      user: null,
    })
    window.history.pushState({}, '', '/dashboard')

    render(
      <Providers>
        <App />
      </Providers>,
    )

    expect(await screen.findByText('Daily admin pulse')).toBeInTheDocument()
  })
})
