/**
 * Service worker registration for the admin PWA.
 *
 * Uses vite-plugin-pwa's virtual `registerSW` (the plugin emits the runtime
 * registration helper even in `injectRegister: false` mode). Reloads once when
 * a freshly-activated worker takes control so a redeploy is picked up without a
 * manual hard refresh, and probes for updates on load + hourly.
 */
export async function registerServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) return

  try {
    const { registerSW } = await import('virtual:pwa-register')

    let reloadedForNewSw = false
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloadedForNewSw) return
      reloadedForNewSw = true
      window.location.reload()
    })

    registerSW({
      immediate: true,
      onRegisteredSW(_swUrl, registration) {
        if (!registration) return
        void registration.update()
        setInterval(() => void registration.update(), 60 * 60 * 1000)
      },
    })
  } catch (error) {
    console.warn('[SW] Failed to register service worker:', error)
  }
}
