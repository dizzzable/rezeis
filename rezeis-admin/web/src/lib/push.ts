/**
 * Admin Web Push helpers.
 *
 * Wraps the browser PushManager API and the `/admin/push/*` endpoints:
 *   1. Fetch the VAPID public key (empty ⇒ push disabled server-side).
 *   2. Convert the URL-safe base64 key to bytes for `pushManager.subscribe`.
 *   3. POST the subscription so the backend can deliver admin notifications.
 *
 * iOS 16.4+ delivers web-push only to PWAs added to the Home Screen, so the
 * caller should prompt installation when `iOS && !standalone`.
 */
import { api } from './api'

export type PushSupport =
  | 'ready'
  | 'unsupported-browser'
  | 'ios-needs-install'

export function detectPushSupport(): PushSupport {
  if (typeof window === 'undefined') return 'unsupported-browser'
  const hasSW = 'serviceWorker' in navigator
  const hasPush = 'PushManager' in window
  const hasNotification = 'Notification' in window
  if (!hasSW || !hasPush || !hasNotification) return 'unsupported-browser'

  const ua = navigator.userAgent
  const isIos = /iphone|ipad|ipod/i.test(ua)
  const standalone =
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  if (isIos && !standalone) return 'ios-needs-install'
  return 'ready'
}

export async function getCurrentSubscription(): Promise<PushSubscription | null> {
  if (!('serviceWorker' in navigator)) return null
  const reg = await navigator.serviceWorker.ready
  return reg.pushManager.getSubscription()
}

async function getPublicKey(): Promise<string> {
  const { data } = await api.get<{ publicKey: string }>('/admin/push/public-key')
  return (data.publicKey ?? '').trim()
}

export type EnablePushResult =
  | 'subscribed'
  | 'permission-denied'
  | 'push-disabled'
  | 'subscribe-failed'
  | 'unsupported'

export async function enablePush(): Promise<EnablePushResult> {
  if (detectPushSupport() !== 'ready') return 'unsupported'

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return 'permission-denied'

  const publicKey = await getPublicKey()
  if (publicKey.length === 0) return 'push-disabled'

  const reg = await navigator.serviceWorker.ready
  let subscription: PushSubscription
  try {
    subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    })
  } catch (err) {
    // Permission was granted above, so a failure here is NOT a permission
    // problem — it's the push service rejecting the subscription (e.g. a
    // VAPID key mismatch, or the browser's push service being unreachable).
    // Report it distinctly instead of the misleading "permission denied".
    console.error('[push] pushManager.subscribe failed', err)
    return 'subscribe-failed'
  }

  const json = subscription.toJSON()
  try {
    await api.post('/admin/push/subscribe', {
      subscription: {
        endpoint: subscription.endpoint,
        keys: {
          p256dh: json.keys?.p256dh ?? '',
          auth: json.keys?.auth ?? '',
        },
      },
    })
  } catch (err) {
    try {
      await subscription.unsubscribe()
    } catch {
      // best-effort
    }
    throw err
  }
  return 'subscribed'
}

/**
 * Ensure a push subscription exists WITHOUT prompting — used to make admin push
 * "on by default" once the operator has granted notification permission. No-op
 * when push isn't ready, permission isn't granted, or the server has no VAPID
 * key. Re-subscribes when the browser dropped the subscription and registers
 * it. Returns true when a subscription is in place afterwards.
 */
export async function ensurePushSubscription(): Promise<boolean> {
  if (detectPushSupport() !== 'ready') return false
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false
  const publicKey = await getPublicKey()
  if (publicKey.length === 0) return false
  const reg = await navigator.serviceWorker.ready
  let subscription = await reg.pushManager.getSubscription()
  if (subscription === null) {
    try {
      subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      })
    } catch {
      return false
    }
  }
  const json = subscription.toJSON()
  try {
    await api.post('/admin/push/subscribe', {
      subscription: {
        endpoint: subscription.endpoint,
        keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' },
      },
    })
  } catch {
    return false
  }
  return true
}

export async function disablePush(): Promise<boolean> {
  if (!('serviceWorker' in navigator)) return false
  const reg = await navigator.serviceWorker.ready
  const sub = await reg.pushManager.getSubscription()
  if (sub === null) return true
  const endpoint = sub.endpoint
  await sub.unsubscribe()
  try {
    await api.post('/admin/push/unsubscribe', { endpoint })
  } catch {
    // best-effort — local unsubscribe already stops new pushes
  }
  return true
}

/** True when the operator configured VAPID server-side (push available). */
export async function isPushConfigured(): Promise<boolean> {
  try {
    return (await getPublicKey()).length > 0
  } catch {
    return false
  }
}

/**
 * Convert a URL-safe base64 VAPID key to the raw bytes PushManager expects.
 * Returns an ArrayBuffer (not a Uint8Array view) because TS 6's BufferSource
 * discriminator rejects SharedArrayBuffer-backed views in `subscribe()`.
 */
function urlBase64ToUint8Array(base64String: string): ArrayBuffer {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = window.atob(base64)
  const output = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) {
    output[i] = raw.charCodeAt(i)
  }
  return output.buffer
}
