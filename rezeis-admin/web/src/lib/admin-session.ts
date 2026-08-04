import type { QueryClient } from '@tanstack/react-query'

import { usePermissionStore } from '@/features/rbac'
import { useAuthStore } from '@/stores/auth-store'
import { authStorage } from './auth-storage'
import { queryClient as defaultQueryClient } from './query-client'

const SIGN_IN_PATH = '/sign-in'
let forceLogoutInProgress = false

export function resetAdminClientState(queryClient: QueryClient): void {
  queryClient.clear()
  usePermissionStore.getState().reset()
  useAuthStore.getState().clearSession()
}

export function startAdminClientSession(queryClient: QueryClient, token: string): void {
  forceLogoutInProgress = false
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
  forceLogoutInProgress = false
  resetAdminClientState(queryClient)
}

/**
 * True from the moment a hard auth failure has torn the session down until the
 * next sign-in.
 *
 * Exposed for unsaved-changes guards. The navigation they would hold in that
 * window is this module's own trip to the sign-in page — the session behind it
 * is already destroyed, and `forceEndAdminSession` will not fire a second
 * redirect — so a prompt there offers a "stay" that strands the operator on a
 * page whose every request 401s.
 */
export function isForceLogoutInProgress(): boolean {
  return forceLogoutInProgress
}

export function forceEndAdminSession(queryClient: QueryClient = defaultQueryClient): void {
  if (forceLogoutInProgress) return
  endAdminClientSession(queryClient)
  forceLogoutInProgress = true
  if (typeof window !== 'undefined' && !window.location.pathname.endsWith(SIGN_IN_PATH)) {
    window.location.href = SIGN_IN_PATH
  }
}
