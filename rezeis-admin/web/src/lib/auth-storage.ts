const ACCESS_TOKEN_KEY: string = 'rezeis.admin.access-token'

function canUseStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
}

export const authStorage = {
  getToken(): string {
    if (!canUseStorage()) {
      return ''
    }
    return window.localStorage.getItem(ACCESS_TOKEN_KEY) ?? ''
  },
  setToken(token: string): void {
    if (!canUseStorage()) {
      return
    }
    window.localStorage.setItem(ACCESS_TOKEN_KEY, token)
  },
  clearToken(): void {
    if (!canUseStorage()) {
      return
    }
    window.localStorage.removeItem(ACCESS_TOKEN_KEY)
  },
}
