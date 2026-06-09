import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

/**
 * Listens for `NAVIGATE` messages posted by the service worker when an admin
 * taps a push notification while a panel window is already open. Routes via
 * react-router (no full reload). When no window is open the SW instead calls
 * `openWindow(url)`, which loads the SPA at the deep-link directly.
 */
export function useSwNavigation(): void {
  const navigate = useNavigate()
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    const handler = (event: MessageEvent) => {
      const data = event.data as { type?: string; url?: string } | null
      if (!data || data.type !== 'NAVIGATE' || typeof data.url !== 'string') return
      try {
        const u = new URL(data.url, window.location.origin)
        navigate(u.pathname + u.search + u.hash)
      } catch {
        navigate(data.url)
      }
    }
    navigator.serviceWorker.addEventListener('message', handler)
    return () => navigator.serviceWorker.removeEventListener('message', handler)
  }, [navigate])
}
