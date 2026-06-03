import React, { createContext, useContext, useCallback, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { startAdminClientSession, endAdminClientSession } from '@/lib/admin-session'
import { logClientDiagnostic } from '@/lib/client-logger'
import { usePermissionStore } from '@/features/rbac'
import { useAuthStore } from '@/stores/auth-store'
import { getMeApi, type AdminProfile } from './auth-api'

interface AuthContextValue {
  isAuthenticated: boolean
  isLoading: boolean
  sessionError: Error | null
  admin: AdminProfile | null
  /** Snapshot from the latest permission probe — convenient for UI gates. */
  mustChangePassword: boolean
  login: (token: string) => void
  logout: () => void
  retrySession: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

function isUnauthorizedError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('response' in error)) return false
  return (error as { response?: { status?: number } }).response?.status === 401
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient()
  const { t } = useTranslation()
  const token = useAuthStore((state) => state.token)

  const { data: admin, isLoading: isQueryLoading, error: authError, refetch: refetchAdmin } = useQuery<AdminProfile>({
    queryKey: ['auth-me'],
    queryFn: getMeApi,
    enabled: token.length > 0,
    retry: false,
    staleTime: 5 * 60 * 1000,
  })

  // Permission store mirrors `/admin/auth/permissions`. We keep it in sync
  // with the auth lifecycle: load on auth, refresh on login, reset on
  // logout. The page-level RolesPage and PermissionGate consume the store.
  const loadPermissions = usePermissionStore((s) => s.loadPermissions)
  const permissionsLoaded = usePermissionStore((s) => s.loaded)
  const permissionsLoading = usePermissionStore((s) => s.loading)
  const permissionsError = usePermissionStore((s) => s.error)
  const mustChangePassword = usePermissionStore((s) => s.mustChangePassword)
  const hasToken = token.length > 0
  const authErrorIsUnauthorized = isUnauthorizedError(authError)
  const sessionError = authErrorIsUnauthorized
    ? null
    : authError instanceof Error
      ? authError
      : permissionsError
  const isSessionReady =
    !hasToken ||
    (!!admin && permissionsLoaded) ||
    (!!admin && !!permissionsError && !permissionsLoading) ||
    (!!authError && !isQueryLoading)

  useEffect(() => {
    if (token && authErrorIsUnauthorized) {
      endAdminClientSession(queryClient)
    }
  }, [authErrorIsUnauthorized, queryClient, token])

  const handlePermissionLoadFailure = useCallback((err: unknown) => {
    // Surface the failure: without permissions, the workspace stays locked
    // so a forced password-change admin cannot briefly render the shell.
    logClientDiagnostic('[auth-provider] loadPermissions failed', err)
    toast.error(t('authProvider.permissions.loadFailed'), {
      duration: 8_000,
      action: {
        label: t('authProvider.permissions.retry'),
        onClick: () => {
          void loadPermissions().catch((retryErr: unknown) => {
            logClientDiagnostic('[auth-provider] retry loadPermissions failed', retryErr)
          })
        },
      },
    })
  }, [loadPermissions, t])

  useEffect(() => {
    if (admin && !permissionsLoaded) {
      loadPermissions().catch(handlePermissionLoadFailure)
    }
  }, [admin, permissionsLoaded, loadPermissions, handlePermissionLoadFailure])

  const retrySession = useCallback(() => {
    if (admin && !permissionsLoaded) {
      void loadPermissions().catch(handlePermissionLoadFailure)
      return
    }
    void refetchAdmin()
  }, [admin, handlePermissionLoadFailure, loadPermissions, permissionsLoaded, refetchAdmin])

  const login = useCallback((newToken: string) => {
    startAdminClientSession(queryClient, newToken)
  }, [queryClient])

  const logout = useCallback(() => {
    endAdminClientSession(queryClient)
  }, [queryClient])

  return (
    <AuthContext.Provider
      value={{
        isAuthenticated: !!admin && permissionsLoaded,
        isLoading: hasToken && !isSessionReady,
        sessionError,
        admin: admin ?? null,
        mustChangePassword,
        login,
        logout,
        retrySession,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within <AuthProvider>')
  }
  return context
}
