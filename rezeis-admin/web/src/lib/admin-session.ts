import type { QueryClient } from '@tanstack/react-query'

import { usePermissionStore } from '@/features/rbac'
import { useAuthStore } from '@/stores/auth-store'
import { authStorage } from './auth-storage'

export function resetAdminClientState(queryClient: QueryClient): void {
  queryClient.clear()
  usePermissionStore.getState().reset()
  useAuthStore.getState().clearSession()
}

export function startAdminClientSession(queryClient: QueryClient, token: string): void {
  resetAdminClientState(queryClient)
  authStorage.setToken(token)
  useAuthStore.setState((state) => {
    const sessionRevision = state.sessionRevision + 1
    return {
      token,
      user: null,
      sessionRevision,
      verifiedSessionRevision: null,
      pendingLoginRevision: sessionRevision,
    }
  })
}

export function endAdminClientSession(queryClient: QueryClient): void {
  resetAdminClientState(queryClient)
}
