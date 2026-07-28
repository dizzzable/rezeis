import type { ReactElement, ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import ProtectedRoute from '@/app/protected-route'
import { usePermissionStore, type RbacEffectivePermissionsResponse } from '@/features/rbac'
import { i18n } from '@/i18n/i18n'
import { authStorage } from '@/lib/auth-storage'
import { useAuthStore } from '@/stores/auth-store'
import { getEffectivePermissions } from '@/features/rbac/rbac-api'
import { getMeApi } from './auth-api'
import { AuthProvider } from './auth-provider'

vi.mock('./auth-api', () => ({
  getMeApi: vi.fn(),
}))

vi.mock('@/features/rbac/rbac-api', () => ({
  getEffectivePermissions: vi.fn(),
}))

const admin = {
  id: 'admin-1',
  login: 'admin',
  email: null,
  name: null,
  role: 'ADMIN' as const,
  isActive: true,
  createdAt: '2026-06-04T00:00:00.000Z',
  lastLoginAt: null,
  lastLoginIp: null,
}

describe('AuthProvider protected route readiness', () => {
  beforeEach(() => {
    window.localStorage.clear()
    usePermissionStore.getState().reset()
    useAuthStore.getState().clearSession()
    vi.mocked(getMeApi).mockReset()
    vi.mocked(getEffectivePermissions).mockReset()
  })

  afterEach(() => {
    cleanup()
    window.localStorage.clear()
    usePermissionStore.getState().reset()
    useAuthStore.getState().clearSession()
  })

  it('keeps protected routes locked until permissions and mustChangePassword resolve', async () => {
    const permissions = deferred<RbacEffectivePermissionsResponse>()
    vi.mocked(getMeApi).mockResolvedValue(admin)
    vi.mocked(getEffectivePermissions).mockReturnValue(permissions.promise)
    seedToken('valid-token')

    renderProtectedRoutes('/')

    expect(await screen.findByText(/auth\.verifyingSession|Verifying session|Проверка сессии/)).toBeInTheDocument()
    expect(screen.queryByText('Admin shell rendered')).not.toBeInTheDocument()

    await act(async () => {
      permissions.resolve({
        permissions: [],
        mustChangePassword: true,
        role: 'ADMIN',
        rbacRoleId: null,
      })
      await permissions.promise
    })

    expect(await screen.findByText('Change password')).toBeInTheDocument()
    expect(screen.queryByText('Admin shell rendered')).not.toBeInTheDocument()
  })

  it('does not render the password-change route without an authenticated session', async () => {
    renderProtectedRoutes('/change-password')

    expect(await screen.findByText('Sign in')).toBeInTheDocument()
    expect(screen.queryByText('Change password')).not.toBeInTheDocument()
    expect(getMeApi).not.toHaveBeenCalled()
  })

  it('clears the session instead of showing a locked error on /me 401', async () => {
    vi.mocked(getMeApi).mockRejectedValue({ response: { status: 401 } })
    seedToken('expired-token')

    renderProtectedRoutes('/')

    expect(await screen.findByText('Sign in')).toBeInTheDocument()
    expect(screen.queryByText('Unable to verify admin session')).not.toBeInTheDocument()
    expect(useAuthStore.getState().token).toBe('')
  })

  it('keeps the workspace locked when permissions fail to load', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.mocked(getMeApi).mockResolvedValue(admin)
    vi.mocked(getEffectivePermissions).mockRejectedValue(new Error('permissions unavailable'))
    seedToken('valid-token')

    renderProtectedRoutes('/')

    expect(await screen.findByText('Unable to verify admin session')).toBeInTheDocument()
    expect(screen.getByText('permissions unavailable')).toBeInTheDocument()
    expect(screen.queryByText('Admin shell rendered')).not.toBeInTheDocument()
  })
})

function renderProtectedRoutes(route: string): void {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })

  function Wrapper({ children }: { readonly children: ReactNode }): ReactElement {
    return (
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>{children}</AuthProvider>
        </QueryClientProvider>
      </I18nextProvider>
    )
  }

  render(
    <MemoryRouter initialEntries={[route]}>
      <Routes>
        <Route element={<ProtectedRoute />}>
          <Route index element={<div>Admin shell rendered</div>} />
          <Route path="change-password" element={<div>Change password</div>} />
        </Route>
        <Route path="/sign-in" element={<div>Sign in</div>} />
      </Routes>
    </MemoryRouter>,
    { wrapper: Wrapper },
  )
}

function seedToken(token: string): void {
  authStorage.setToken(token)
  useAuthStore.setState({
    token,
    user: null,
    sessionRevision: 1,
    verifiedSessionRevision: null,
    pendingLoginRevision: null,
  })
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}
