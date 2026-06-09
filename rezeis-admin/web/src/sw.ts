/// <reference lib="webworker" />
/**
 * Rezeis Admin service worker (vite-plugin-pwa `injectManifest`).
 *
 * Responsibilities:
 *   - Precache the application shell (HTML/CSS/JS) for installable PWA + fast
 *     reloads.
 *   - Network-first for navigations so a redeploy never strands the user on a
 *     stale shell referencing old hashed bundles.
 *   - Cache-first for immutable hashed static assets.
 *   - Web Push display + click-to-open deep-link (used from Phase 2 onward;
 *     harmless when no pushes are sent).
 *
 * Admin data is sensitive — API responses are intentionally NEVER cached.
 */
import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching'
import { registerRoute, Route, setCatchHandler } from 'workbox-routing'
import { CacheFirst, NetworkFirst } from 'workbox-strategies'
import { ExpirationPlugin } from 'workbox-expiration'
import { CacheableResponsePlugin } from 'workbox-cacheable-response'

declare let self: ServiceWorkerGlobalScope

const STATIC_CACHE = 'rezeis-static-v1'
const NAV_CACHE = 'rezeis-navigations-v1'

// Activate the new SW immediately on update.
self.addEventListener('install', () => {
  void self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      await cleanupOutdatedCaches()
      const cacheNames = await caches.keys()
      const valid = [STATIC_CACHE, NAV_CACHE]
      await Promise.all(
        cacheNames
          .filter((name) => !valid.includes(name) && !name.startsWith('workbox-precache'))
          .map((name) => caches.delete(name)),
      )
      await self.clients.claim()
    })(),
  )
})

// Application shell — Workbox injects the precache manifest here at build time.
precacheAndRoute(self.__WB_MANIFEST)

// Navigations: network-first (fresh shell when online, cached shell offline).
registerRoute(
  new Route(
    ({ request }) => request.mode === 'navigate',
    new NetworkFirst({
      cacheName: NAV_CACHE,
      networkTimeoutSeconds: 5,
      plugins: [
        new CacheableResponsePlugin({ statuses: [0, 200] }),
        new ExpirationPlugin({ maxEntries: 10, maxAgeSeconds: 24 * 60 * 60 }),
      ],
    }),
  ),
)

// Immutable hashed static assets: cache-first (never documents).
registerRoute(
  new Route(
    ({ request, url }) => {
      if (request.mode === 'navigate' || request.destination === 'document') return false
      if (url.pathname.startsWith('/assets/')) return true
      return (
        request.destination === 'script' ||
        request.destination === 'style' ||
        request.destination === 'font' ||
        request.destination === 'image'
      )
    },
    new CacheFirst({
      cacheName: STATIC_CACHE,
      plugins: [
        new CacheableResponsePlugin({ statuses: [0, 200] }),
        new ExpirationPlugin({ maxEntries: 120, maxAgeSeconds: 30 * 24 * 60 * 60 }),
      ],
    }),
  ),
)

// Offline fallback for navigations when the network is down and nothing cached.
setCatchHandler(async ({ request }) => {
  if (request.mode === 'navigate') {
    const navCache = await caches.open(NAV_CACHE)
    const navHit = await navCache.match(request)
    if (navHit) return navHit
    return new Response(
      '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Offline</title></head>' +
        '<body style="background:#09090b;color:#fafafa;font-family:system-ui;display:flex;height:100vh;align-items:center;justify-content:center;text-align:center"><div><h1>Offline</h1><p>Rezeis Admin is not available offline. Check your connection.</p></div></body></html>',
      { headers: { 'Content-Type': 'text/html' }, status: 503 },
    )
  }
  return Response.error()
})

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting()
  }
})

// ─── Web Push (used from Phase 2) ─────────────────────────────────────────────
interface WebPushPayload {
  readonly title?: string
  readonly body?: string
  readonly url?: string
}

self.addEventListener('push', (event) => {
  const data: WebPushPayload = (() => {
    try {
      return event.data?.json() ?? {}
    } catch {
      return {}
    }
  })()

  const title = typeof data.title === 'string' && data.title.length > 0 ? data.title : 'Rezeis Admin'
  const body = typeof data.body === 'string' && data.body.length > 0 ? data.body : ''
  const url = typeof data.url === 'string' && data.url.length > 0 ? data.url : '/'

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/rezeis-logo.svg',
      badge: '/rezeis-logo.svg',
      data: { url },
      tag: 'rezeis-admin-notification',
      ...({ renotify: true } as Record<string, unknown>),
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const data = (event.notification.data ?? {}) as { url?: string }
  const targetUrl = typeof data.url === 'string' && data.url.length > 0 ? data.url : '/'
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      for (const client of all) {
        try {
          const clientUrl = new URL(client.url)
          const targetParsed = new URL(targetUrl, self.location.origin)
          if (clientUrl.origin === targetParsed.origin) {
            await client.focus()
            client.postMessage({ type: 'NAVIGATE', url: targetUrl })
            return
          }
        } catch {
          // fall through to opening a new window
        }
      }
      await self.clients.openWindow(targetUrl)
    })(),
  )
})
