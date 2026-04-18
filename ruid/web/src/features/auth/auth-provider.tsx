import { createContext, useContext, useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react'
import { useMutation, useQueryClient, type UseMutationResult, type UseQueryResult } from '@tanstack/react-query'
import { authApi } from '@/features/auth/auth-api'
import { getTelegramBootstrapInitData, getTelegramLaunchInitData, getTelegramWebApp, loadTelegramWebAppScript, type TelegramWebApp } from '@/features/auth/telegram-web-app'
import { sessionApi } from '@/features/session/session-api'
import { useSessionQuery } from '@/features/session/use-session-query'
import { isApiUnauthorizedError } from '@/lib/api'

type SessionData = Awaited<ReturnType<typeof sessionApi.getSession>>
const TELEGRAM_RUNTIME_SYNC_INTERVAL_MS: number = 250

export type AuthStatus = 'loading' | 'authenticated' | 'authentication-required' | 'error'

interface AuthContextValue {
  readonly status: AuthStatus
  readonly sessionQuery: UseQueryResult<SessionData>
  readonly bootstrapError: unknown
  readonly hasSessionPersistenceIssue: boolean
  readonly telegramWebApp: TelegramWebApp | null
  readonly hasTelegramLaunch: boolean
  readonly canBootstrapWithTelegram: boolean
}

interface TelegramRuntimeState {
  readonly isRuntimeReady: boolean
  readonly runtimeError: unknown
  readonly webApp: TelegramWebApp | null
  readonly initData: string | null
  readonly hasLaunch: boolean
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { readonly children: ReactNode }): ReactElement {
  const queryClient = useQueryClient()
  const telegramRuntimeState: TelegramRuntimeState = useTelegramRuntimeState()
  const bootstrapMutation: UseMutationResult<void, unknown, { readonly initData: string }> = useMutation({
    mutationFn: authApi.bootstrapTelegramSession,
    retry: (failureCount: number, error: unknown): boolean => !isApiUnauthorizedError(error) && failureCount < 1,
    retryDelay: 500,
    onSuccess: async (): Promise<void> => {
      await queryClient.invalidateQueries({ queryKey: ['session'] })
      await queryClient.invalidateQueries({ queryKey: ['subscription'] })
      await queryClient.invalidateQueries({ queryKey: ['platform-policy'] })
    },
  })
  const [lastBootstrapInitData, setLastBootstrapInitData] = useState<string | null>(null)
  const hasPendingTelegramBootstrap: boolean = telegramRuntimeState.initData !== null && lastBootstrapInitData !== telegramRuntimeState.initData
  useEffect(() => {
    if (!telegramRuntimeState.initData || !hasPendingTelegramBootstrap || bootstrapMutation.isPending) {
      return
    }
    setLastBootstrapInitData(telegramRuntimeState.initData)
    bootstrapMutation.mutate({ initData: telegramRuntimeState.initData })
  }, [bootstrapMutation, hasPendingTelegramBootstrap, telegramRuntimeState.initData])
  const sessionQuery: UseQueryResult<SessionData> = useSessionQuery()
  const hasUnauthorizedSessionError: boolean = isApiUnauthorizedError(sessionQuery.error)
  useEffect(() => {
    if (!hasUnauthorizedSessionError) {
      return
    }
    queryClient.setQueryData(['session'], undefined)
    queryClient.removeQueries({ queryKey: ['subscription'], exact: true })
  }, [hasUnauthorizedSessionError])
  const status: AuthStatus = useMemo(() => {
    if (hasUnauthorizedSessionError) {
      return 'authentication-required'
    }
    if (sessionQuery.data) {
      return 'authenticated'
    }
    if (telegramRuntimeState.hasLaunch && !telegramRuntimeState.isRuntimeReady) {
      return 'loading'
    }
    if (hasPendingTelegramBootstrap) {
      return 'loading'
    }
    if (bootstrapMutation.isPending || sessionQuery.isPending) {
      return 'loading'
    }
    if (bootstrapMutation.error && !isApiUnauthorizedError(bootstrapMutation.error)) {
      return 'error'
    }
    if (telegramRuntimeState.runtimeError && telegramRuntimeState.hasLaunch && telegramRuntimeState.initData === null) {
      return 'error'
    }
    if (sessionQuery.error) {
      return 'error'
    }
    return 'authentication-required'
  }, [bootstrapMutation.error, bootstrapMutation.isPending, hasPendingTelegramBootstrap, hasUnauthorizedSessionError, sessionQuery.data, sessionQuery.error, sessionQuery.isPending, telegramRuntimeState.hasLaunch, telegramRuntimeState.initData, telegramRuntimeState.isRuntimeReady, telegramRuntimeState.runtimeError])
  const hasSessionPersistenceIssue: boolean = bootstrapMutation.isSuccess && hasUnauthorizedSessionError
  const contextValue: AuthContextValue = useMemo(
    () => ({
      status,
      sessionQuery,
      bootstrapError: telegramRuntimeState.runtimeError ?? bootstrapMutation.error,
      hasSessionPersistenceIssue,
      telegramWebApp: telegramRuntimeState.webApp,
      hasTelegramLaunch: telegramRuntimeState.hasLaunch,
      canBootstrapWithTelegram: telegramRuntimeState.initData !== null,
    }),
    [bootstrapMutation.error, hasSessionPersistenceIssue, sessionQuery, status, telegramRuntimeState.hasLaunch, telegramRuntimeState.initData, telegramRuntimeState.runtimeError, telegramRuntimeState.webApp],
  )
  return <AuthContext.Provider value={contextValue}>{children}</AuthContext.Provider>
}

export function useAuthSession(): AuthContextValue {
  const contextValue: AuthContextValue | null = useContext(AuthContext)
  if (!contextValue) {
    throw new Error('useAuthSession must be used within AuthProvider.')
  }
  return contextValue
}

function useTelegramRuntimeState(): TelegramRuntimeState {
  const [runtimeState, setRuntimeState] = useState<TelegramRuntimeState>(() => {
    const initialWebApp: TelegramWebApp | null = getTelegramWebApp()
    const initialInitData: string | null = getTelegramBootstrapInitData()
    const initialHasLaunch: boolean = getTelegramLaunchInitData() !== null || initialInitData !== null
    return {
      isRuntimeReady: initialWebApp !== null,
      runtimeError: null,
      webApp: initialWebApp,
      initData: initialInitData,
      hasLaunch: initialHasLaunch,
    }
  })
  useEffect(() => {
    let isMounted: boolean = true
    let pollTimerId: number | null = null
    const stopPolling = (): void => {
      if (pollTimerId === null) {
        return
      }
      window.clearInterval(pollTimerId)
      pollTimerId = null
    }
    const syncRuntimeState = ({ isRuntimeReady, runtimeError }: { readonly isRuntimeReady: boolean; readonly runtimeError: unknown }): void => {
      const webApp: TelegramWebApp | null = getTelegramWebApp()
      const initData: string | null = getTelegramBootstrapInitData()
      const hasLaunch: boolean = getTelegramLaunchInitData() !== null || initData !== null
      setRuntimeState((currentState) => {
        if (
          currentState.isRuntimeReady === isRuntimeReady &&
          currentState.runtimeError === runtimeError &&
          currentState.webApp === webApp &&
          currentState.initData === initData &&
          currentState.hasLaunch === hasLaunch
        ) {
          return currentState
        }
        return {
          isRuntimeReady,
          runtimeError,
          webApp,
          initData,
          hasLaunch,
        }
      })
      if (initData !== null) {
        stopPolling()
      }
    }
    const startPollingForLateInitData = (): void => {
      syncRuntimeState({ isRuntimeReady: true, runtimeError: null })
      if (getTelegramBootstrapInitData() !== null || pollTimerId !== null) {
        return
      }
      pollTimerId = window.setInterval(() => {
        if (!isMounted) {
          stopPolling()
          return
        }
        syncRuntimeState({ isRuntimeReady: true, runtimeError: null })
      }, TELEGRAM_RUNTIME_SYNC_INTERVAL_MS)
    }
    const executeLoad = async (): Promise<void> => {
      try {
        await loadTelegramWebAppScript()
        if (!isMounted) {
          return
        }
        startPollingForLateInitData()
      } catch (err: unknown) {
        if (!isMounted) {
          return
        }
        stopPolling()
        const hasTelegramLaunch: boolean = getTelegramLaunchInitData() !== null
        setRuntimeState({
          isRuntimeReady: true,
          runtimeError: hasTelegramLaunch ? err : null,
          webApp: null,
          initData: getTelegramLaunchInitData(),
          hasLaunch: hasTelegramLaunch,
        })
      }
    }
    if (getTelegramWebApp()) {
      startPollingForLateInitData()
    } else {
      void executeLoad()
    }
    return () => {
      isMounted = false
      stopPolling()
    }
  }, [])
  return runtimeState
}
