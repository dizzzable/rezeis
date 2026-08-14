/**
 * What the panel does when the server refuses this browser's push endpoint.
 *
 * `POST /admin/push/subscribe` answers 409 for exactly one case: another admin
 * already owns the endpoint. It is not a transport hiccup — it will still be
 * there on the next attempt, and no amount of retrying clears it. Both callers
 * used to fold it into "something went wrong": `enablePush` rethrew into a
 * generic toast, and `ensurePushSubscription` returned `false` and said
 * nothing, so an admin could sit with push silently off and no way to find out
 * why.
 *
 * The recoverability claim is the part worth pinning: the local subscription is
 * dropped on failure, so the NEXT `pushManager.subscribe()` mints a fresh
 * endpoint that nobody else holds and the toggle simply works. A test that only
 * checked the returned string would still pass if that unsubscribe were
 * deleted, which is why the calls are counted here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const apiMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))

vi.mock('./api', () => ({ api: apiMock }))

import {
  PUSH_OPTOUT_KEY,
  enablePush,
  ensurePushSubscription,
  hasPushOptOut,
} from './push'

const ENDPOINT = 'https://push.example.test/abc'

let unsubscribeMock: ReturnType<typeof vi.fn>
let subscribeMock: ReturnType<typeof vi.fn>
let getSubscriptionMock: ReturnType<typeof vi.fn>

function fakeSubscription(): unknown {
  return {
    endpoint: ENDPOINT,
    toJSON: () => ({ keys: { p256dh: 'p256dh-key', auth: 'auth-key' } }),
    unsubscribe: unsubscribeMock,
  }
}

/** 409 in the shape axios rejects with. */
function conflict(): unknown {
  return { response: { status: 409 } }
}

beforeEach(() => {
  apiMock.get.mockReset()
  apiMock.post.mockReset()
  apiMock.get.mockResolvedValue({ data: { publicKey: 'BJ3rSJm0' } })

  unsubscribeMock = vi.fn().mockResolvedValue(true)
  subscribeMock = vi.fn().mockResolvedValue(fakeSubscription())
  getSubscriptionMock = vi.fn().mockResolvedValue(fakeSubscription())

  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { ready: Promise.resolve({ pushManager: { getSubscription: getSubscriptionMock, subscribe: subscribeMock } }) },
  })
  Object.defineProperty(window, 'PushManager', { configurable: true, value: class {} })
  Object.defineProperty(window, 'Notification', {
    configurable: true,
    value: Object.assign(class {}, {
      permission: 'granted',
      requestPermission: vi.fn().mockResolvedValue('granted'),
    }),
  })
  localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ensurePushSubscription — the silent heal', () => {
  it('reports a taken endpoint distinctly instead of a bare failure', async () => {
    apiMock.post.mockRejectedValue(conflict())

    await expect(ensurePushSubscription()).resolves.toBe('endpoint-taken')
  })

  it('still reports everything else as unavailable, so the 409 means only itself', async () => {
    apiMock.post.mockRejectedValue({ response: { status: 500 } })

    await expect(ensurePushSubscription()).resolves.toBe('unavailable')
  })

  it('reports success when the endpoint is registered', async () => {
    apiMock.post.mockResolvedValue({ data: {} })

    await expect(ensurePushSubscription()).resolves.toBe('subscribed')
    expect(apiMock.post).toHaveBeenCalledWith('/admin/push/subscribe', {
      subscription: { endpoint: ENDPOINT, keys: { p256dh: 'p256dh-key', auth: 'auth-key' } },
    })
  })

  it('does nothing at all when notification permission was never granted', async () => {
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      value: Object.assign(class {}, { permission: 'default', requestPermission: vi.fn() }),
    })

    await expect(ensurePushSubscription()).resolves.toBe('unavailable')
    expect(apiMock.post).not.toHaveBeenCalled()
    expect(subscribeMock).not.toHaveBeenCalled()
  })
})

describe('enablePush — the explicit toggle', () => {
  it('returns endpoint-taken and drops the local subscription so the retry can succeed', async () => {
    apiMock.post.mockRejectedValue(conflict())

    await expect(enablePush()).resolves.toBe('endpoint-taken')
    // The whole reason this is recoverable: without it the browser keeps the
    // endpoint another admin owns and every retry hits the same 409.
    expect(unsubscribeMock).toHaveBeenCalledTimes(1)
  })

  it('still throws on failures that are not a conflict', async () => {
    apiMock.post.mockRejectedValue({ response: { status: 503 } })

    await expect(enablePush()).rejects.toBeTruthy()
    expect(unsubscribeMock).toHaveBeenCalledTimes(1)
  })
})

describe('hasPushOptOut', () => {
  it('is false until the operator turns push off on this device', () => {
    expect(hasPushOptOut()).toBe(false)
    localStorage.setItem(PUSH_OPTOUT_KEY, '1')
    expect(hasPushOptOut()).toBe(true)
  })

  it('treats unreadable storage as "no explicit opt-out"', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled')
    })

    // Guessing the other way would make push unhealable in private mode, where
    // the operator never opted out of anything.
    expect(hasPushOptOut()).toBe(false)
    spy.mockRestore()
  })
})
