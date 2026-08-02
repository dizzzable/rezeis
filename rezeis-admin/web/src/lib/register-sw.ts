/**
 * Service worker registration for the admin PWA.
 *
 * Uses vite-plugin-pwa's virtual `registerSW` (the plugin emits the runtime
 * registration helper even in `injectRegister: false` mode). In auto-update
 * mode that helper owns the single update reload; this module only probes for
 * updates on load + hourly.
 */
export async function registerServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) return

  try {
    const { registerSW } = await import('virtual:pwa-register')

    registerSW({
      immediate: true,
      onRegisteredSW(_swUrl, registration) {
        if (!registration) return
        const checkForUpdate = () =>
          registration.update().catch((error: unknown) => {
            console.warn('[SW] Update check failed:', error)
          })
        void checkForUpdate()
        setInterval(() => void checkForUpdate(), 60 * 60 * 1000)
      },
    })
  } catch (error) {
    console.warn('[SW] Failed to register service worker:', error)
  }
}
