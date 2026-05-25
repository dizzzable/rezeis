import React, { createContext, useContext, useState, useCallback, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { TOKEN_KEY } from '@/lib/api'
import { safeGetItem, safeSetItem, safeRemoveItem } from '@/lib/safe-storage'
import { usePermissionStore } from '@/features/rbac'
import { getMeApi, type AdminProfile } from './auth-api'

interface AuthContextValue {
  isAuthenticated: boolean
  isLoading: boolean
  admin: AdminProfile | null
  /** Snapshot from the latest permission probe — convenient for UI gates. */
  mustChangePassword: boolean
  login: (token: string) => void
  logout: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient()
  const { t } = useTranslation()

  const [token, setToken] = useState<string | null>(() => {
    // Check for OAuth callback token in URL hash fragment (GitHub redirect)
    if (window.location.hash) {
      const hashParams = new URLSearchParams(window.location.hash.slice(1))
      const oauthToken = hashParams.get('oauth_token')
      if (oauthToken) {
        safeSetItem(TOKEN_KEY, oauthToken)
        // Clean URL hash
        window.history.replaceState({}, '', window.location.pathname)
        return oauthToken
      }
    }
    // Legacy: also check query params for backwards compat
    const params = new URLSearchParams(window.location.search)
    const oauthTokenQuery = params.get('oauth_token')
    if (oauthTokenQuery) {
      safeSetItem(TOKEN_KEY, oauthTokenQuery)
      window.history.replaceState({}, '', window.location.pathname)
      return oauthTokenQuery
    }
    return safeGetItem(TOKEN_KEY)
  })

  const { data: admin, isLoading: isQueryLoading } = useQuery<AdminProfile>({
    queryKey: ['auth-me'],
    queryFn: getMeApi,
    enabled: !!token,
    retry: false,
    staleTime: 5 * 60 * 1000,
  })

  // Permission store mirrors `/admin/auth/permissions`. We keep it in sync
  // with the auth lifecycle: load on auth, refresh on login, reset on
  // logout. The page-level RolesPage and PermissionGate consume the store.
  const loadPermissions = usePermissionStore((s) => s.loadPermissions)
  const resetPermissions = usePermissionStore((s) => s.reset)
  const permissionsLoaded = usePermissionStore((s) => s.loaded)
  const mustChangePassword = usePermissionStore((s) => s.mustChangePassword)

  useEffect(() => {
    if (admin && !permissionsLoaded) {
      loadPermissions().catch((err: unknown) => {
        // Surface the failure: without permissions, the UI hides actions
        // the operator might actually be allowed to perform. We log to
        // the console for debugging and offer a one-click retry.
        console.error('[auth-provider] loadPermissions failed:', err)
        toast.error(t('authProvider.permissions.loadFailed'), {
          duration: 8_000,
          action: {
            label: t('authProvider.permissions.retry'),
            onClick: () => {
              void loadPermissions()
            },
          },
        })
      })
    }
  }, [admin, permissionsLoaded, loadPermissions, t])

  const login = useCallback((newToken: string) => {
    safeSetItem(TOKEN_KEY, newToken)
    setToken(newToken)
    // Reset and reload everything: a fresh login should clear stale
    // state from the previous session before any UI mounts.
    resetPermissions()
    queryClient.invalidateQueries({ queryKey: ['auth-me'] })
  }, [queryClient, resetPermissions])

  const logout = useCallback(() => {
    safeRemoveItem(TOKEN_KEY)
    setToken(null)
    resetPermissions()
    queryClient.removeQueries({ queryKey: ['auth-me'] })
  }, [queryClient, resetPermissions])

  return (
    <AuthContext.Provider
      value={{
        isAuthenticated: !!admin,
        isLoading: !!token && isQueryLoading,
        admin: admin ?? null,
        mustChangePassword,
        login,
        logout,
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
