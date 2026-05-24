import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  isStorageAvailable,
  safeGetItem,
  safeRemoveItem,
  safeSetItem,
} from './safe-storage'

const realStorage = window.localStorage

interface ThrowingStorageOptions {
  readonly throwOnSet?: boolean
  readonly throwOnGet?: boolean
  readonly throwOnRemove?: boolean
}

function installThrowingStorage(opts: ThrowingStorageOptions): void {
  const stub: Storage = {
    length: 0,
    key: () => null,
    clear: () => undefined,
    getItem: (key: string) => {
      if (opts.throwOnGet) {
        const err = new Error('SecurityError')
        err.name = 'SecurityError'
        throw err
      }
      return realStorage.getItem(key)
    },
    setItem: (_key: string, _value: string) => {
      if (opts.throwOnSet) {
        const err = new Error('QuotaExceededError')
        err.name = 'QuotaExceededError'
        throw err
      }
    },
    removeItem: (_key: string) => {
      if (opts.throwOnRemove) {
        const err = new Error('SecurityError')
        err.name = 'SecurityError'
        throw err
      }
    },
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

describe('safe-storage', () => {
  beforeEach(() => {
    realStorage.clear()
  })

  afterEach(() => {
    restoreStorage()
  })

  describe('happy path', () => {
    it('reads, writes and removes values via localStorage', () => {
      expect(safeSetItem('rezeis.test.key', 'value-1')).toBe(true)
      expect(safeGetItem('rezeis.test.key')).toBe('value-1')
      expect(safeRemoveItem('rezeis.test.key')).toBe(true)
      expect(safeGetItem('rezeis.test.key')).toBeNull()
    })

    it('isStorageAvailable returns true in jsdom', () => {
      expect(isStorageAvailable()).toBe(true)
    })
  })

  describe('Safari Private Browsing simulation', () => {
    it('safeSetItem returns false when localStorage.setItem throws QuotaExceededError', () => {
      installThrowingStorage({ throwOnSet: true })

      expect(safeSetItem('rezeis.test.key', 'value-1')).toBe(false)
    })

    it('safeGetItem returns null when localStorage.getItem throws SecurityError', () => {
      installThrowingStorage({ throwOnGet: true })

      expect(safeGetItem('rezeis.test.key')).toBeNull()
    })

    it('safeRemoveItem returns false when localStorage.removeItem throws', () => {
      installThrowingStorage({ throwOnRemove: true })

      expect(safeRemoveItem('rezeis.test.key')).toBe(false)
    })

    it('isStorageAvailable returns false when probe write throws', () => {
      installThrowingStorage({ throwOnSet: true })

      expect(isStorageAvailable()).toBe(false)
    })
  })
})
