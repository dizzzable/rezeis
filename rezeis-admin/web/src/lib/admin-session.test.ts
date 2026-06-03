import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { usePermissionStore } from '@/features/rbac'
import { useAuthStore } from '@/stores/auth-store'
import { endAdminClientSession, forceEndAdminSession, startAdminClientSession } from './admin-session'
import { authStorage } from './auth-storage'

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })
}

function seedSensitiveStores(): void {
  authStorage.setToken('old-token')
  useAuthStore.setState({
    token: 'old-token',
    user: {
      id: 'admin-a',
      login: 'admin-a',
      email: 'a@example.com',
      name: 'Admin A',
      role: 'ADMIN',
      isActive: true,
      createdAt: '2026-06-03T00:00:00.000Z',
      lastLoginAt: null,
      lastLoginIp: '127.0.0.1',
    },
    sessionRevision: 4,
    verifiedSessionRevision: 4,
    pendingLoginRevision: null,
  })
  usePermissionStore.setState({
    loaded: true,
    loading: false,
    granted: new Set(['users:read']),
    mustChangePassword: true,
    role: 'ADMIN',
    rbacRoleId: 'role-a',
    error: new Error('old permission error'),
  })
}

describe('admin session boundary', () => {
  beforeEach(() => {
    window.localStorage.clear()
    seedSensitiveStores()
  })

  afterEach(() => {
    window.localStorage.clear()
    endAdminClientSession(createQueryClient())
  })

  it('clears query cache and sensitive stores before starting a new admin session', () => {
    const queryClient = createQueryClient()
    queryClient.setQueryData(['admin', 'dashboard', 'summary'], { owner: 'admin-a' })

    startAdminClientSession(queryClient, 'new-token')

    expect(queryClient.getQueryData(['admin', 'dashboard', 'summary'])).toBeUndefined()
    expect(authStorage.getToken()).toBe('new-token')
    expect(useAuthStore.getState().token).toBe('new-token')
    expect(useAuthStore.getState().user).toBeNull()
    expect(usePermissionStore.getState().loaded).toBe(false)
    expect(usePermissionStore.getState().granted.size).toBe(0)
    expect(usePermissionStore.getState().mustChangePassword).toBe(false)
  })

  it('clears query cache, tokens, and sensitive stores on logout', () => {
    const queryClient = createQueryClient()
    queryClient.setQueryData(['admin', 'users'], [{ id: 'user-a' }])

    endAdminClientSession(queryClient)

    expect(queryClient.getQueryData(['admin', 'users'])).toBeUndefined()
    expect(authStorage.getToken()).toBe('')
    expect(useAuthStore.getState().token).toBe('')
    expect(useAuthStore.getState().user).toBeNull()
    expect(usePermissionStore.getState().loaded).toBe(false)
    expect(usePermissionStore.getState().role).toBeNull()
  })

  it('uses the same client-state reset for hard auth failures', () => {
    const queryClient = createQueryClient()
    queryClient.setQueryData(['admin', 'payments', 'transactions'], [{ id: 'tx-a' }])
    window.history.pushState({}, '', '/sign-in')

    forceEndAdminSession(queryClient)

    expect(queryClient.getQueryData(['admin', 'payments', 'transactions'])).toBeUndefined()
    expect(authStorage.getToken()).toBe('')
    expect(useAuthStore.getState().token).toBe('')
    expect(usePermissionStore.getState().loaded).toBe(false)
  })
})
