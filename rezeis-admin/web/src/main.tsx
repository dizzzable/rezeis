import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '@/App'
import { Providers } from '@/app/providers'
import { registerServiceWorker } from '@/lib/register-sw'
import { i18nReady } from '@/i18n/i18n'
import '@/index.css'

// Service worker for installable PWA + offline shell. The helper defers the
// actual registration until after window load + idle so the ~7 MiB precache
// never races the login-critical requests on first visit.
void registerServiceWorker()

// Wait for the initial locale bundle to load before the first paint so the
// pre-auth spinner shows translated copy instead of raw keys like
// "auth.verifyingSession". `.finally` so a failed locale fetch still renders.
void i18nReady.finally(() => {
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
      <Providers>
        <App />
      </Providers>
    </React.StrictMode>,
  )
})
