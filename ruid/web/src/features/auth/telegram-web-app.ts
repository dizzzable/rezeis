export interface TelegramWebApp {
  readonly initData: string
  readonly platform?: string
  readonly isExpanded?: boolean
  ready(): void
  expand(): void
}

declare global {
  interface Window {
    readonly Telegram?: {
      readonly WebApp?: TelegramWebApp
    }
  }
}

const telegramScriptUrl: string = 'https://telegram.org/js/telegram-web-app.js?57'
const initialLaunchHash: string = typeof window === 'undefined' ? '' : captureTelegramLaunchHash()

export function getTelegramWebApp(): TelegramWebApp | null {
  return window.Telegram?.WebApp ?? null
}

export function getTelegramLaunchInitData(): string | null {
  const hashParams: URLSearchParams = new URLSearchParams(initialLaunchHash.replace(/^#/, ''))
  const initData: string | null = hashParams.get('tgWebAppData')
  return initData && initData.length > 0 ? initData : null
}

function captureTelegramLaunchHash(): string {
  const launchHash: string = window.location.hash
  const scrubbedHash: string = scrubTelegramLaunchHash(launchHash)
  if (scrubbedHash !== launchHash) {
    const nextUrl: string = `${window.location.pathname}${window.location.search}${scrubbedHash}`
    window.history.replaceState(window.history.state, '', nextUrl)
  }
  return launchHash
}

function scrubTelegramLaunchHash(hash: string): string {
  if (!hash.includes('tgWebAppData=')) {
    return hash
  }
  const hashParams: URLSearchParams = new URLSearchParams(hash.replace(/^#/, ''))
  hashParams.delete('tgWebAppData')
  const scrubbedHashParams: string = hashParams.toString()
  if (scrubbedHashParams.length === 0) {
    return ''
  }
  return `#${scrubbedHashParams}`
}

export function getTelegramRuntimeInitData(): string | null {
  const webApp: TelegramWebApp | null = getTelegramWebApp()
  if (!webApp) {
    return null
  }
  return webApp.initData.length > 0 ? webApp.initData : null
}

export function getTelegramBootstrapInitData(): string | null {
  return getTelegramRuntimeInitData() ?? getTelegramLaunchInitData()
}

export function loadTelegramWebAppScript(): Promise<void> {
  const existingWebApp: TelegramWebApp | null = getTelegramWebApp()
  if (existingWebApp) {
    return Promise.resolve()
  }
  const existingScript: HTMLScriptElement | null = document.querySelector(`script[src="${telegramScriptUrl}"]`)
  if (existingScript?.dataset.loaded === 'true') {
    return Promise.resolve()
  }
  return new Promise<void>((resolve, reject) => {
    const scriptElement: HTMLScriptElement = existingScript ?? document.createElement('script')
    const handleLoad = (): void => {
      scriptElement.dataset.loaded = 'true'
      resolve()
    }
    const handleError = (): void => {
      reject(new Error('Failed to load Telegram Mini App runtime.'))
    }
    scriptElement.addEventListener('load', handleLoad, { once: true })
    scriptElement.addEventListener('error', handleError, { once: true })
    if (!existingScript) {
      scriptElement.src = telegramScriptUrl
      scriptElement.async = true
      document.head.appendChild(scriptElement)
    }
  })
}
