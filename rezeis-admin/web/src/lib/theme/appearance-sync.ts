/**
 * Cross-device appearance sync for the authenticated admin shell.
 *
 * The four Zustand stores remain the source of truth for the current browser.
 * Their persisted envelopes are mirrored to the server as one bounded payload
 * so a later session for the same admin can rehydrate the same active look.
 */
import { useEffect } from 'react'

import { api } from '@/lib/api'
import { authStorage } from '@/lib/auth-storage'
import { useAppearanceStore } from './appearance-store'
import { useEffectsStore } from './effects-store'
import { useGlassStore } from './glass-store'
import { useThemeStore } from './theme-store'

export const APPEARANCE_STORE_KEYS = [
  'rezeis-admin-theme',
  'rezeis-admin-glass',
  'rezeis-admin-effects',
  'rezeis-admin-appearance',
] as const

export const APPEARANCE_SYNC_LIMITS = {
  payloadBytes: 256 * 1024,
  storeBytes: 192 * 1024,
  stringBytes: 192 * 1024,
  keepaliveBytes: 60 * 1024,
  maxDepth: 12,
  maxNodes: 4096,
  maxCollectionEntries: 512,
} as const

export const APPEARANCE_SYNC_TIMING = {
  debounceMs: 1000,
  retryBaseMs: 500,
  retryMaxMs: 8000,
} as const

type AppearanceStoreKey = (typeof APPEARANCE_STORE_KEYS)[number]

interface PersistedStoreEnvelope {
  readonly state: Record<string, unknown>
  readonly version?: number
}

export type AppearancePrefs = Partial<Record<AppearanceStoreKey, PersistedStoreEnvelope>>

type PersistApi = { persist: { rehydrate: () => void | Promise<void> } }

interface PendingSnapshot {
  readonly prefs: AppearancePrefs
  readonly fingerprint: string
}

const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function serializedByteLength(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value)
    return serialized === undefined ? null : byteLength(serialized)
  } catch {
    return null
  }
}

function isSafeJsonValue(
  value: unknown,
  depth = 0,
  budget: { nodes: number } = { nodes: 0 },
): boolean {
  budget.nodes += 1
  if (budget.nodes > APPEARANCE_SYNC_LIMITS.maxNodes) return false
  if (depth > APPEARANCE_SYNC_LIMITS.maxDepth) return false

  if (value === null || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'string') {
    return byteLength(value) <= APPEARANCE_SYNC_LIMITS.stringBytes
  }
  if (Array.isArray(value)) {
    if (value.length > APPEARANCE_SYNC_LIMITS.maxCollectionEntries) return false
    return value.every((entry) => isSafeJsonValue(entry, depth + 1, budget))
  }
  if (!isPlainRecord(value)) return false

  const entries = Object.entries(value)
  if (entries.length > APPEARANCE_SYNC_LIMITS.maxCollectionEntries) return false
  return entries.every(
    ([key, entry]) =>
      !FORBIDDEN_OBJECT_KEYS.has(key) &&
      byteLength(key) <= 256 &&
      isSafeJsonValue(entry, depth + 1, budget),
  )
}

function isPersistedStoreEnvelope(value: unknown): value is PersistedStoreEnvelope {
  if (!isPlainRecord(value)) return false
  const keys = Object.keys(value)
  if (
    !Object.prototype.hasOwnProperty.call(value, 'state') ||
    keys.some((key) => key !== 'state' && key !== 'version') ||
    !isPlainRecord(value.state)
  ) {
    return false
  }
  if (
    value.version !== undefined &&
    (!Number.isSafeInteger(value.version) || (value.version as number) < 0)
  ) {
    return false
  }
  return isSafeJsonValue(value)
}

/**
 * Keeps only known, valid Zustand persistence envelopes and enforces both
 * per-store and aggregate UTF-8 limits. Unknown future server fields are
 * ignored by old clients rather than being copied into localStorage.
 */
export function sanitizeAppearancePrefs(input: unknown): AppearancePrefs {
  if (!isPlainRecord(input)) return {}

  const result: AppearancePrefs = {}
  let totalBytes = 2

  for (const key of APPEARANCE_STORE_KEYS) {
    const value = input[key]
    if (!isPersistedStoreEnvelope(value)) continue
    const valueBytes = serializedByteLength(value)
    if (valueBytes === null || valueBytes > APPEARANCE_SYNC_LIMITS.storeBytes) continue

    const entryBytes =
      byteLength(JSON.stringify(key)) +
      valueBytes +
      1 +
      (Object.keys(result).length > 0 ? 1 : 0)
    if (totalBytes + entryBytes > APPEARANCE_SYNC_LIMITS.payloadBytes) continue

    result[key] = value
    totalBytes += entryBytes
  }

  return result
}

export function readLocalAppearancePrefs(
  storage: Pick<Storage, 'getItem'> = localStorage,
): AppearancePrefs {
  const parsed: Record<string, unknown> = {}

  for (const key of APPEARANCE_STORE_KEYS) {
    try {
      const raw = storage.getItem(key)
      if (raw !== null) parsed[key] = JSON.parse(raw) as unknown
    } catch {
      // A malformed entry or unavailable storage must not poison other stores.
    }
  }

  return sanitizeAppearancePrefs(parsed)
}

/**
 * Applies a remote snapshot atomically as far as localStorage permits. If a
 * quota/security error occurs midway, already-written keys are rolled back so
 * the four stores never rehydrate a mixed local/remote appearance.
 */
export function applyAppearancePrefsToStorage(
  input: unknown,
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = localStorage,
): boolean {
  const prefs = sanitizeAppearancePrefs(input)
  const entries = APPEARANCE_STORE_KEYS.flatMap((key) => {
    const value = prefs[key]
    return value === undefined ? [] : ([[key, JSON.stringify(value)]] as const)
  })
  if (entries.length === 0) return false

  const previous = new Map<AppearanceStoreKey, string | null>()
  const applied: AppearanceStoreKey[] = []

  try {
    for (const [key, serialized] of entries) {
      previous.set(key, storage.getItem(key))
      storage.setItem(key, serialized)
      applied.push(key)
    }
    return true
  } catch {
    for (const key of applied.reverse()) {
      try {
        const oldValue = previous.get(key)
        if (oldValue === null || oldValue === undefined) storage.removeItem(key)
        else storage.setItem(key, oldValue)
      } catch {
        // Best-effort rollback: storage itself can remain unavailable.
      }
    }
    return false
  }
}

function fingerprint(prefs: AppearancePrefs): string {
  return JSON.stringify(prefs)
}

function sendKeepaliveSnapshot(prefs: AppearancePrefs): void {
  const token = authStorage.getToken()
  if (!token || typeof fetch !== 'function') return

  const body = JSON.stringify({ prefs })
  if (byteLength(body) > APPEARANCE_SYNC_LIMITS.keepaliveBytes) return

  try {
    void fetch('/api/admin/theme-presets/active-prefs', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      credentials: 'same-origin',
      keepalive: true,
      body,
    }).catch(() => {
      // Browser shutdown is best-effort; the normal serialized PUT remains the
      // primary path and will retry while the page is alive.
    })
  } catch {
    // Some embedded browsers reject keepalive synchronously.
  }
}

async function rehydrateAll(): Promise<void> {
  const stores = [
    useThemeStore,
    useGlassStore,
    useEffectsStore,
    useAppearanceStore,
  ] as unknown as PersistApi[]

  await Promise.allSettled(
    stores.map((store) => Promise.resolve(store.persist.rehydrate())),
  )
}

/**
 * Mount once inside the authenticated shell. Local changes made while the
 * initial GET is in flight always win; otherwise the server snapshot is
 * applied and every store is rehydrated.
 */
export function useAppearanceSync(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return

    let stopped = false
    let ready = false
    let applyingRemoteFingerprint: string | null = null
    let localRevision = 0
    let dirty = false
    let pending: PendingSnapshot | null = null
    let lastSuccessfulFingerprint: string | null = null
    let saveTimer: ReturnType<typeof setTimeout> | undefined
    let loadTimer: ReturnType<typeof setTimeout> | undefined
    let loadInFlight = false
    let remoteLoadSettled = false
    let loadRetryAttempt = 0
    let inFlight = false
    let inFlightFingerprint: string | null = null
    let inFlightSnapshot: PendingSnapshot | null = null
    let retryAttempt = 0
    let flushAfterFlight = false

    const clearSaveTimer = (): void => {
      if (saveTimer !== undefined) {
        clearTimeout(saveTimer)
        saveTimer = undefined
      }
    }

    const clearLoadTimer = (): void => {
      if (loadTimer !== undefined) {
        clearTimeout(loadTimer)
        loadTimer = undefined
      }
    }

    const captureLatest = (): void => {
      const prefs = readLocalAppearancePrefs()
      if (Object.keys(prefs).length === 0) return

      const nextFingerprint = fingerprint(prefs)
      if (nextFingerprint === pending?.fingerprint) return
      if (nextFingerprint === inFlightFingerprint) {
        // The user returned to the value currently being persisted. Drop an
        // older queued intermediate snapshot instead of sending stale state
        // after the in-flight request succeeds.
        pending = null
        return
      }
      if (nextFingerprint === lastSuccessfulFingerprint) {
        pending = null
        dirty = false
        return
      }
      pending = { prefs, fingerprint: nextFingerprint }
    }

    const retryDelay = (): number =>
      Math.min(
        APPEARANCE_SYNC_TIMING.retryBaseMs * 2 ** Math.max(0, retryAttempt - 1),
        APPEARANCE_SYNC_TIMING.retryMaxMs,
      )

    const scheduleSave = (delayMs: number): void => {
      if (stopped) return
      clearSaveTimer()
      saveTimer = setTimeout(() => {
        saveTimer = undefined
        captureLatest()
        dispatchPending()
      }, delayMs)
    }

    const scheduleLoadRetry = (): void => {
      if (stopped || remoteLoadSettled || loadTimer !== undefined) return
      const delay = Math.min(
        APPEARANCE_SYNC_TIMING.retryBaseMs *
          2 ** Math.max(0, loadRetryAttempt - 1),
        APPEARANCE_SYNC_TIMING.retryMaxMs,
      )
      loadTimer = setTimeout(() => {
        loadTimer = undefined
        loadRemote()
      }, delay)
    }

    function dispatchPending(finalAttempt = false): void {
      if ((stopped && !finalAttempt) || inFlight || pending === null) return

      const snapshot = pending
      pending = null
      inFlight = true
      inFlightFingerprint = snapshot.fingerprint
      inFlightSnapshot = snapshot
      let failed = false

      void Promise.resolve()
        .then(() =>
          api.put('/admin/theme-presets/active-prefs', { prefs: snapshot.prefs }),
        )
        .then(() => {
          lastSuccessfulFingerprint = snapshot.fingerprint
        })
        .catch(() => {
          failed = true
          dirty = true
          if (!finalAttempt && pending === null) pending = snapshot
        })
        .finally(() => {
          inFlight = false
          inFlightFingerprint = null
          inFlightSnapshot = null

          if (stopped) {
            if (flushAfterFlight && pending !== null) {
              flushAfterFlight = false
              dispatchPending(true)
            }
            return
          }

          if (failed) {
            retryAttempt += 1
            if (pending !== null && saveTimer === undefined) {
              scheduleSave(retryDelay())
            }
            return
          }

          retryAttempt = 0
          const currentFingerprint = fingerprint(readLocalAppearancePrefs())
          if (pending === null && currentFingerprint === snapshot.fingerprint) {
            dirty = false
          } else if (currentFingerprint !== snapshot.fingerprint) {
            dirty = true
          }
          if (pending !== null && saveTimer === undefined) scheduleSave(0)
        })
    }

    const flushNow = (finalAttempt = false): void => {
      clearSaveTimer()
      if (dirty) captureLatest()
      if (inFlight) {
        if (dirty || pending !== null) flushAfterFlight = true
        return
      }
      dispatchPending(finalAttempt)
    }

    const onStoreChange = (): void => {
      if (stopped) return
      if (applyingRemoteFingerprint !== null) {
        const current = fingerprint(readLocalAppearancePrefs())
        if (current === applyingRemoteFingerprint) return
      }

      localRevision += 1
      dirty = true
      // A real local edit is authoritative for this session. A late or retried
      // GET must never overwrite it; the queued PUT becomes the new server copy.
      remoteLoadSettled = true
      clearLoadTimer()
      if (ready) scheduleSave(APPEARANCE_SYNC_TIMING.debounceMs)
    }

    const unsubscribers = [
      useThemeStore.subscribe(onStoreChange),
      useGlassStore.subscribe(onStoreChange),
      useEffectsStore.subscribe(onStoreChange),
      useAppearanceStore.subscribe(onStoreChange),
    ]

    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'hidden') flushNow()
    }
    const onPageHide = (): void => {
      clearSaveTimer()
      if (dirty) captureLatest()
      const latest = pending ?? inFlightSnapshot
      if (dirty && latest !== null) sendKeepaliveSnapshot(latest.prefs)
      flushNow()
    }
    const onOnline = (): void => {
      if (!remoteLoadSettled && !loadInFlight) {
        clearLoadTimer()
        loadRemote()
      }
      if (dirty || pending !== null) scheduleSave(0)
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('online', onOnline)

    const revisionAtLoadStart = localRevision
    function loadRemote(): void {
      if (stopped || loadInFlight || remoteLoadSettled) return
      loadInFlight = true

      void api
        .get<{ prefs: unknown }>('/admin/theme-presets/active-prefs')
        .then(async (response) => {
          remoteLoadSettled = true
          loadRetryAttempt = 0
          if (stopped || localRevision !== revisionAtLoadStart) return

          const remotePrefs = sanitizeAppearancePrefs(response.data?.prefs)
          if (Object.keys(remotePrefs).length === 0) {
            // Existing admins may already have a configured local appearance
            // from before server sync was introduced. Seed an empty server
            // snapshot without requiring them to touch a setting again.
            if (Object.keys(readLocalAppearancePrefs()).length > 0) dirty = true
            return
          }
          const remoteFingerprint = fingerprint(remotePrefs)
          if (!applyAppearancePrefsToStorage(remotePrefs)) return

          applyingRemoteFingerprint = fingerprint(readLocalAppearancePrefs())
          await rehydrateAll()

          if (stopped || localRevision !== revisionAtLoadStart) return
          const currentFingerprint = fingerprint(readLocalAppearancePrefs())
          if (currentFingerprint === remoteFingerprint) {
            lastSuccessfulFingerprint = currentFingerprint
            dirty = false
          } else {
            // A legacy/partial snapshot or a store migration produced a more
            // complete current shape. Normalize it back to the server once.
            dirty = true
          }
        })
        .catch(() => {
          loadRetryAttempt += 1
          scheduleLoadRetry()
        })
        .finally(() => {
          applyingRemoteFingerprint = null
          loadInFlight = false
          if (stopped) return
          ready = true
          if (dirty) scheduleSave(APPEARANCE_SYNC_TIMING.debounceMs)
        })
    }
    loadRemote()

    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe()
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('online', onOnline)
      clearSaveTimer()
      clearLoadTimer()

      stopped = true
      if (dirty) captureLatest()
      if (inFlight) {
        if (dirty || pending !== null) flushAfterFlight = true
      } else {
        dispatchPending(true)
      }
    }
  }, [enabled])
}
