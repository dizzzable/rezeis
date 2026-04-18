import type { MockInstance } from 'vitest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { authApi } from '@/features/auth/auth-api'
import { api } from '@/lib/api'

interface DeferredPromise<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(reason?: unknown): void
}

function createDeferredPromise<T>(): DeferredPromise<T> {
  let resolvePromise!: (value: T) => void
  let rejectPromise!: (reason?: unknown) => void
  const promise: Promise<T> = new Promise<T>((resolve: (value: T) => void, reject: (reason?: unknown) => void) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return {
    promise,
    resolve(value: T): void {
      resolvePromise(value)
    },
    reject(reason?: unknown): void {
      rejectPromise(reason)
    },
  }
}

describe('authApi.bootstrapTelegramSession', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('dedupes in-flight bootstrap requests for the same Telegram init data', async () => {
    const deferredRequest: DeferredPromise<unknown> = createDeferredPromise<unknown>()
    const postSpy: MockInstance = vi.spyOn(api, 'post').mockImplementation(() => deferredRequest.promise as ReturnType<typeof api.post>)

    const firstBootstrap: Promise<void> = authApi.bootstrapTelegramSession({ initData: 'telegram-init-data' })
    const secondBootstrap: Promise<void> = authApi.bootstrapTelegramSession({ initData: 'telegram-init-data' })

    expect(postSpy).toHaveBeenCalledTimes(1)
    expect(postSpy).toHaveBeenCalledWith('/auth/telegram/bootstrap', undefined, {
      headers: {
        Authorization: 'tma telegram-init-data',
      },
    })

    deferredRequest.resolve({})

    await Promise.all([firstBootstrap, secondBootstrap])
  })

  it('cleans up the in-flight request entry after completion', async () => {
    const postSpy: MockInstance = vi.spyOn(api, 'post').mockResolvedValue({} as Awaited<ReturnType<typeof api.post>>)

    await authApi.bootstrapTelegramSession({ initData: 'telegram-init-data-cleanup' })
    await authApi.bootstrapTelegramSession({ initData: 'telegram-init-data-cleanup' })

    expect(postSpy).toHaveBeenCalledTimes(2)
  })

  it('cleans up the in-flight request entry after a rejected bootstrap request', async () => {
    const bootstrapError = new Error('Bootstrap failed')
    const postSpy: MockInstance = vi
      .spyOn(api, 'post')
      .mockRejectedValueOnce(bootstrapError)
      .mockResolvedValueOnce({} as Awaited<ReturnType<typeof api.post>>)

    await expect(authApi.bootstrapTelegramSession({ initData: 'telegram-init-data-reject' })).rejects.toThrow('Bootstrap failed')
    await authApi.bootstrapTelegramSession({ initData: 'telegram-init-data-reject' })

    expect(postSpy).toHaveBeenCalledTimes(2)
  })
})
