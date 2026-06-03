import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ADMIN_ACCESS_TOKEN_KEY, authStorage } from './auth-storage'

const realStorage = window.localStorage

function installThrowingStorage(): void {
  const stub: Storage = {
    length: 0,
    key: () => null,
    clear: () => undefined,
    getItem: () => null,
    setItem: () => {
      const err = new Error('QuotaExceededError')
      err.name = 'QuotaExceededError'
      throw err
    },
    removeItem: () => undefined,
  }
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: stub,
  })
}

function restoreStorage(): void {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: realStorage,
  })
}

describe('auth-storage', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/')
    restoreStorage()
    realStorage.clear()
    authStorage.clearToken()
  })

  afterEach(() => {
    window.history.replaceState({}, '', '/')
    restoreStorage()
    realStorage.clear()
    authStorage.clearToken()
  })

  it('persists the admin token in localStorage when available', () => {
    authStorage.setToken('token-1')

    expect(realStorage.getItem(ADMIN_ACCESS_TOKEN_KEY)).toBe('token-1')
    expect(authStorage.getToken()).toBe('token-1')
  })

  it('keeps the current tab authenticated when localStorage writes fail', () => {
    installThrowingStorage()

    authStorage.setToken('memory-token')

    expect(authStorage.getToken()).toBe('memory-token')
  })

  it('consumes OAuth tokens from the hash fragment without query-string fallback', () => {
    window.history.replaceState({}, '', '/#oauth_token=hash-token')

    expect(authStorage.getToken()).toBe('hash-token')
    expect(realStorage.getItem(ADMIN_ACCESS_TOKEN_KEY)).toBe('hash-token')
    expect(window.location.hash).toBe('')
  })

  it('does not resurrect a persisted token removed outside authStorage', () => {
    authStorage.setToken('token-1')
    realStorage.removeItem(ADMIN_ACCESS_TOKEN_KEY)

    expect(authStorage.getToken()).toBe('')
  })

  it('clears both persisted and in-memory tokens', () => {
    authStorage.setToken('token-1')
    authStorage.clearToken()

    expect(authStorage.getToken()).toBe('')
    expect(realStorage.getItem(ADMIN_ACCESS_TOKEN_KEY)).toBeNull()
  })
})
