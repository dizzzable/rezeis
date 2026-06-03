import { safeGetItem, safeSetItem, safeRemoveItem } from './safe-storage'

export const ADMIN_ACCESS_TOKEN_KEY: string = 'rezeis_admin_token'

let memoryToken = ''
let useMemoryFallback = false

function persistToken(token: string): void {
  memoryToken = token
  useMemoryFallback = !safeSetItem(ADMIN_ACCESS_TOKEN_KEY, token)
}

function consumeOAuthTokenFromHash(): string | null {
  if (typeof window === 'undefined' || !window.location.hash) return null

  const hashParams = new URLSearchParams(window.location.hash.slice(1))
  const oauthToken = hashParams.get('oauth_token')
  if (!oauthToken) return null

  persistToken(oauthToken)
  window.history.replaceState({}, '', `${window.location.pathname}${window.location.search}`)
  return oauthToken
}

export const authStorage = {
  getToken(): string {
    const oauthToken = consumeOAuthTokenFromHash()
    if (oauthToken) return oauthToken

    const persistedToken = safeGetItem(ADMIN_ACCESS_TOKEN_KEY)
    if (persistedToken !== null) return persistedToken
    return useMemoryFallback ? memoryToken : ''
  },
  setToken(token: string): void {
    persistToken(token)
  },
  clearToken(): void {
    memoryToken = ''
    useMemoryFallback = false
    safeRemoveItem(ADMIN_ACCESS_TOKEN_KEY)
  },
}
