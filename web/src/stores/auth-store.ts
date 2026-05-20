import { create } from 'zustand'
import { z } from 'zod'
import { authUserSchema } from '@/features/auth/auth-user'
import { authStorage } from '@/lib/auth-storage'

type AuthUser = z.infer<typeof authUserSchema>

interface AuthState {
  readonly token: string
  readonly user: AuthUser | null
  readonly sessionRevision: number
  readonly verifiedSessionRevision: number | null
  readonly pendingLoginRevision: number | null
  startSession: (input: { readonly token: string; readonly user: AuthUser }) => void
  setUser: (user: AuthUser | null) => void
  markSessionVerified: (sessionRevision: number) => void
  clearSession: () => void
}

function readInitialToken(): string {
  return authStorage.getToken()
}

export const useAuthStore = create<AuthState>((set) => ({
  token: readInitialToken(),
  user: null,
  sessionRevision: 0,
  verifiedSessionRevision: null,
  pendingLoginRevision: null,
  startSession: (input: { readonly token: string; readonly user: AuthUser }): void => {
    authStorage.setToken(input.token)
    set((state) => {
      const nextSessionRevision: number = state.sessionRevision + 1
      return {
        token: input.token,
        user: input.user,
        sessionRevision: nextSessionRevision,
        verifiedSessionRevision: null,
        pendingLoginRevision: nextSessionRevision,
      }
    })
  },
  setUser: (user: AuthUser | null): void => {
    set({ user })
  },
  markSessionVerified: (sessionRevision: number): void => {
    set((state) => {
      if (state.sessionRevision !== sessionRevision) {
        return state
      }
      return {
        verifiedSessionRevision: sessionRevision,
        pendingLoginRevision: state.pendingLoginRevision === sessionRevision ? null : state.pendingLoginRevision,
      }
    })
  },
  clearSession: (): void => {
    authStorage.clearToken()
    set((state) => ({
      token: '',
      user: null,
      sessionRevision: state.sessionRevision + 1,
      verifiedSessionRevision: null,
      pendingLoginRevision: null,
    }))
  },
}))
