import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '@/App'
import { Providers } from '@/app/providers'
import { registerServiceWorker } from '@/lib/register-sw'
import '@/index.css'

// Register the service worker for installable PWA + offline shell.
void registerServiceWorker()

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <Providers>
      <App />
    </Providers>
  </React.StrictMode>,
)
