import { safeGetItem, safeSetItem, safeRemoveItem } from './safe-storage'

const ACCESS_TOKEN_KEY: string = 'rezeis.admin.access-token'

export const authStorage = {
  getToken(): string {
    return safeGetItem(ACCESS_TOKEN_KEY) ?? ''
  },
  setToken(token: string): void {
    safeSetItem(ACCESS_TOKEN_KEY, token)
  },
  clearToken(): void {
    safeRemoveItem(ACCESS_TOKEN_KEY)
  },
}
