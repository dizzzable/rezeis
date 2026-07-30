import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const syncMocks = vi.hoisted(() => {
  type StoreName = 'theme' | 'glass' | 'effects' | 'appearance'
  type Listener = () => void

  const listeners: Record<StoreName, Set<Listener>> = {
    theme: new Set(),
    glass: new Set(),
    effects: new Set(),
    appearance: new Set(),
  }

  const makeStore = (name: StoreName) => ({
    subscribe: vi.fn((listener: Listener) => {
      listeners[name].add(listener)
      return () => listeners[name].delete(listener)
    }),
    persist: {
      rehydrate: vi.fn(async () => {
        for (const listener of listeners[name]) listener()
      }),
    },
  })

  return {
    apiGet: vi.fn(),
    apiPut: vi.fn(),
    keepaliveFetch: vi.fn(),
    getToken: vi.fn(() => 'admin-token'),
    listeners,
    stores: {
      theme: makeStore('theme'),
      glass: makeStore('glass'),
      effects: makeStore('effects'),
      appearance: makeStore('appearance'),
    },
    emit(name: StoreName) {
      for (const listener of listeners[name]) listener()
    },
  }
})

vi.mock('@/lib/api', () => ({
  api: {
    get: syncMocks.apiGet,
    put: syncMocks.apiPut,
  },
}))
vi.mock('@/lib/auth-storage', () => ({
  authStorage: { getToken: syncMocks.getToken },
}))
vi.mock('./theme-store', () => ({ useThemeStore: syncMocks.stores.theme }))
vi.mock('./glass-store', () => ({ useGlassStore: syncMocks.stores.glass }))
vi.mock('./effects-store', () => ({ useEffectsStore: syncMocks.stores.effects }))
vi.mock('./appearance-store', () => ({ useAppearanceStore: syncMocks.stores.appearance }))

import {
  APPEARANCE_STORE_KEYS,
  APPEARANCE_SYNC_LIMITS,
  APPEARANCE_SYNC_TIMING,
  applyAppearancePrefsToStorage,
  sanitizeAppearancePrefs,
  useAppearanceSync,
} from './appearance-sync'

function persisted(state: Record<string, unknown>, version = 1) {
  return { state, version }
}

function writeLocal(
  key: (typeof APPEARANCE_STORE_KEYS)[number],
  state: Record<string, unknown>,
  version = 1,
): void {
  localStorage.setItem(key, JSON.stringify(persisted(state, version)))
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function flushPromises(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve()
  })
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
  await flushPromises()
}

describe('appearance sync payload guards', () => {
  it('keeps only known bounded Zustand envelopes', () => {
    const theme = persisted({ presetId: 'concept-cz', customCss: '' }, 2)
    const result = sanitizeAppearancePrefs({
      'rezeis-admin-theme': theme,
      'rezeis-admin-glass': [],
      unknown: persisted({ injected: true }),
    })

    expect(result).toEqual({ 'rezeis-admin-theme': theme })
    expect(
      sanitizeAppearancePrefs({
        'rezeis-admin-theme': persisted({
          customCss: 'x'.repeat(APPEARANCE_SYNC_LIMITS.storeBytes + 1),
        }),
      }),
    ).toEqual({})
    expect(
      sanitizeAppearancePrefs({
        'rezeis-admin-theme': { state: {}, version: 2, extra: true },
      }),
    ).toEqual({})
  })

  it('rolls localStorage back when a remote multi-store write fails midway', () => {
    const data = new Map<string, string>([
      ['rezeis-admin-theme', JSON.stringify(persisted({ presetId: 'old' }, 2))],
    ])
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (key === 'rezeis-admin-glass') throw new Error('quota')
        data.set(key, value)
      },
      removeItem: (key: string) => {
        data.delete(key)
      },
    }

    expect(
      applyAppearancePrefsToStorage(
        {
          'rezeis-admin-theme': persisted({ presetId: 'remote' }, 2),
          'rezeis-admin-glass': persisted({ glassEnabled: true }, 4),
        },
        storage,
      ),
    ).toBe(false)
    expect(JSON.parse(data.get('rezeis-admin-theme') ?? '')).toEqual(
      persisted({ presetId: 'old' }, 2),
    )
  })
})

describe('useAppearanceSync', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    syncMocks.apiGet.mockReset()
    syncMocks.apiPut.mockReset()
    syncMocks.apiPut.mockResolvedValue({ data: { ok: true } })
    syncMocks.keepaliveFetch.mockReset()
    syncMocks.keepaliveFetch.mockResolvedValue({ ok: true })
    syncMocks.getToken.mockClear()
    vi.stubGlobal('fetch', syncMocks.keepaliveFetch)
    for (const listeners of Object.values(syncMocks.listeners)) listeners.clear()
    for (const store of Object.values(syncMocks.stores)) {
      store.subscribe.mockClear()
      store.persist.rehydrate.mockClear()
    }
  })

  afterEach(() => {
    cleanup()
    vi.clearAllTimers()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('applies the server snapshot and rehydrates every appearance store without echoing it', async () => {
    const remote = {
      'rezeis-admin-theme': persisted({ presetId: 'concept-ba', mode: 'light' }, 2),
      'rezeis-admin-glass': persisted({ glassEnabled: false }, 4),
      'rezeis-admin-effects': persisted({ effectsEnabled: false }, 2),
      'rezeis-admin-appearance': persisted({ density: 'compact' }, 0),
    }
    syncMocks.apiGet.mockResolvedValue({ data: { prefs: remote } })

    renderHook(() => useAppearanceSync(true))
    await flushPromises()
    await advance(APPEARANCE_SYNC_TIMING.debounceMs * 2)

    for (const key of APPEARANCE_STORE_KEYS) {
      expect(JSON.parse(localStorage.getItem(key) ?? '')).toEqual(remote[key])
    }
    for (const store of Object.values(syncMocks.stores)) {
      expect(store.persist.rehydrate).toHaveBeenCalledTimes(1)
    }
    expect(syncMocks.apiPut).not.toHaveBeenCalled()
  })

  it('retries a failed initial GET and still restores the remote appearance', async () => {
    const remoteTheme = persisted({ presetId: 'concept-q', mode: 'light' }, 2)
    syncMocks.apiGet
      .mockRejectedValueOnce(new Error('temporarily offline'))
      .mockResolvedValueOnce({
        data: { prefs: { 'rezeis-admin-theme': remoteTheme } },
      })

    renderHook(() => useAppearanceSync(true))
    await flushPromises()
    expect(syncMocks.apiGet).toHaveBeenCalledTimes(1)

    await advance(APPEARANCE_SYNC_TIMING.retryBaseMs)

    expect(syncMocks.apiGet).toHaveBeenCalledTimes(2)
    expect(JSON.parse(localStorage.getItem('rezeis-admin-theme') ?? '')).toEqual(remoteTheme)
    expect(syncMocks.stores.theme.persist.rehydrate).toHaveBeenCalledTimes(1)
  })

  it('normalizes a legacy partial server snapshot with the complete local store set', async () => {
    const localGlass = persisted({ glassEnabled: true }, 4)
    const remoteTheme = persisted({ presetId: 'concept-j' }, 2)
    localStorage.setItem('rezeis-admin-glass', JSON.stringify(localGlass))
    syncMocks.apiGet.mockResolvedValue({
      data: { prefs: { 'rezeis-admin-theme': remoteTheme } },
    })

    renderHook(() => useAppearanceSync(true))
    await flushPromises()
    await advance(APPEARANCE_SYNC_TIMING.debounceMs)

    expect(syncMocks.apiPut).toHaveBeenCalledTimes(1)
    expect(syncMocks.apiPut.mock.calls[0]?.[1]).toEqual({
      prefs: {
        'rezeis-admin-theme': remoteTheme,
        'rezeis-admin-glass': localGlass,
      },
    })
  })

  it('seeds an empty server snapshot from an existing local appearance', async () => {
    const localTheme = persisted({ presetId: 'concept-existing', mode: 'dark' }, 2)
    const localEffects = persisted({ effectsEnabled: true }, 2)
    localStorage.setItem('rezeis-admin-theme', JSON.stringify(localTheme))
    localStorage.setItem('rezeis-admin-effects', JSON.stringify(localEffects))
    syncMocks.apiGet.mockResolvedValue({ data: { prefs: null } })

    renderHook(() => useAppearanceSync(true))
    await flushPromises()
    await advance(APPEARANCE_SYNC_TIMING.debounceMs)

    expect(syncMocks.apiPut).toHaveBeenCalledTimes(1)
    expect(syncMocks.apiPut.mock.calls[0]?.[1]).toEqual({
      prefs: {
        'rezeis-admin-theme': localTheme,
        'rezeis-admin-effects': localEffects,
      },
    })
  })

  it('lets a local edit win when the initial GET resolves late, then uploads that edit', async () => {
    const initialGet = deferred<{ data: { prefs: unknown } }>()
    syncMocks.apiGet.mockReturnValue(initialGet.promise)
    renderHook(() => useAppearanceSync(true))

    const localTheme = persisted({ presetId: 'concept-cz', mode: 'dark' }, 2)
    localStorage.setItem('rezeis-admin-theme', JSON.stringify(localTheme))
    act(() => syncMocks.emit('theme'))

    initialGet.resolve({
      data: {
        prefs: {
          'rezeis-admin-theme': persisted({ presetId: 'concept-a', mode: 'light' }, 2),
        },
      },
    })
    await flushPromises()

    expect(JSON.parse(localStorage.getItem('rezeis-admin-theme') ?? '')).toEqual(localTheme)
    await advance(APPEARANCE_SYNC_TIMING.debounceMs)
    expect(syncMocks.apiPut).toHaveBeenCalledTimes(1)
    expect(syncMocks.apiPut.mock.calls[0]?.[1]).toEqual({
      prefs: { 'rezeis-admin-theme': localTheme },
    })
  })

  it('flushes the newest debounced edit during unmount', async () => {
    syncMocks.apiGet.mockResolvedValue({ data: { prefs: null } })
    const { unmount } = renderHook(() => useAppearanceSync(true))
    await flushPromises()

    writeLocal('rezeis-admin-theme', { presetId: 'concept-a' }, 2)
    act(() => syncMocks.emit('theme'))
    await advance(APPEARANCE_SYNC_TIMING.debounceMs / 2)
    writeLocal('rezeis-admin-theme', { presetId: 'concept-b' }, 2)
    act(() => syncMocks.emit('theme'))

    unmount()
    await flushPromises()

    expect(syncMocks.apiPut).toHaveBeenCalledTimes(1)
    expect(syncMocks.apiPut.mock.calls[0]?.[1]).toEqual({
      prefs: {
        'rezeis-admin-theme': persisted({ presetId: 'concept-b' }, 2),
      },
    })
  })

  it('uses an authenticated keepalive request when the page is being closed', async () => {
    syncMocks.apiGet.mockResolvedValue({ data: { prefs: null } })
    renderHook(() => useAppearanceSync(true))
    await flushPromises()

    writeLocal('rezeis-admin-glass', { glassEnabled: false }, 4)
    act(() => syncMocks.emit('glass'))
    act(() => window.dispatchEvent(new Event('pagehide')))
    await flushPromises()

    expect(syncMocks.keepaliveFetch).toHaveBeenCalledTimes(1)
    const [url, options] = syncMocks.keepaliveFetch.mock.calls[0] ?? []
    expect(url).toBe('/api/admin/theme-presets/active-prefs')
    expect(options).toMatchObject({
      method: 'PUT',
      keepalive: true,
      credentials: 'same-origin',
      headers: {
        Authorization: 'Bearer admin-token',
        'Content-Type': 'application/json',
      },
    })
    expect(JSON.parse(String(options?.body))).toEqual({
      prefs: {
        'rezeis-admin-glass': persisted({ glassEnabled: false }, 4),
      },
    })
    expect(syncMocks.apiPut).toHaveBeenCalledTimes(1)
  })

  it('contains PUT failures and retries with capped exponential backoff', async () => {
    syncMocks.apiGet.mockRejectedValue(new Error('offline GET'))
    syncMocks.apiPut
      .mockRejectedValueOnce(new Error('offline PUT 1'))
      .mockRejectedValueOnce(new Error('offline PUT 2'))
      .mockResolvedValueOnce({ data: { ok: true } })
    renderHook(() => useAppearanceSync(true))
    await flushPromises()

    writeLocal('rezeis-admin-effects', { effectsEnabled: false }, 2)
    act(() => syncMocks.emit('effects'))
    await advance(APPEARANCE_SYNC_TIMING.debounceMs)
    expect(syncMocks.apiPut).toHaveBeenCalledTimes(1)

    await advance(APPEARANCE_SYNC_TIMING.retryBaseMs)
    expect(syncMocks.apiPut).toHaveBeenCalledTimes(2)

    await advance(APPEARANCE_SYNC_TIMING.retryBaseMs * 2)
    expect(syncMocks.apiPut).toHaveBeenCalledTimes(3)
  })

  it('serializes writes and sends the latest snapshot after an in-flight save', async () => {
    syncMocks.apiGet.mockResolvedValue({ data: { prefs: null } })
    const firstSave = deferred<{ data: { ok: true } }>()
    syncMocks.apiPut
      .mockReturnValueOnce(firstSave.promise)
      .mockResolvedValueOnce({ data: { ok: true } })
    renderHook(() => useAppearanceSync(true))
    await flushPromises()

    writeLocal('rezeis-admin-appearance', { density: 'compact' }, 0)
    act(() => syncMocks.emit('appearance'))
    await advance(APPEARANCE_SYNC_TIMING.debounceMs)
    expect(syncMocks.apiPut).toHaveBeenCalledTimes(1)

    writeLocal('rezeis-admin-appearance', { density: 'spacious' }, 0)
    act(() => syncMocks.emit('appearance'))
    await advance(APPEARANCE_SYNC_TIMING.debounceMs)
    expect(syncMocks.apiPut).toHaveBeenCalledTimes(1)

    firstSave.resolve({ data: { ok: true } })
    await flushPromises()
    await advance(0)

    expect(syncMocks.apiPut).toHaveBeenCalledTimes(2)
    expect(syncMocks.apiPut.mock.calls[1]?.[1]).toEqual({
      prefs: {
        'rezeis-admin-appearance': persisted({ density: 'spacious' }, 0),
      },
    })
  })

  it('drops a stale queued edit when the user returns to the in-flight value', async () => {
    syncMocks.apiGet.mockResolvedValue({ data: { prefs: null } })
    const firstSave = deferred<{ data: { ok: true } }>()
    syncMocks.apiPut.mockReturnValueOnce(firstSave.promise)
    renderHook(() => useAppearanceSync(true))
    await flushPromises()

    writeLocal('rezeis-admin-appearance', { density: 'compact' }, 0)
    act(() => syncMocks.emit('appearance'))
    await advance(APPEARANCE_SYNC_TIMING.debounceMs)
    expect(syncMocks.apiPut).toHaveBeenCalledTimes(1)

    writeLocal('rezeis-admin-appearance', { density: 'spacious' }, 0)
    act(() => syncMocks.emit('appearance'))
    await advance(APPEARANCE_SYNC_TIMING.debounceMs)

    writeLocal('rezeis-admin-appearance', { density: 'compact' }, 0)
    act(() => syncMocks.emit('appearance'))
    await advance(APPEARANCE_SYNC_TIMING.debounceMs)

    firstSave.resolve({ data: { ok: true } })
    await flushPromises()
    await advance(0)

    expect(syncMocks.apiPut).toHaveBeenCalledTimes(1)
  })
})
