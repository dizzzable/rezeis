/**
 * THE TOTP SECRET NEVER LEAVES THE BROWSER.
 *
 * During enrollment the page shows a QR code for the authenticator app. The
 * code encodes `otpauth://totp/...?secret=<BASE32>&issuer=...` — the shared
 * secret IS the second factor: whoever holds it can mint valid codes for as
 * long as the enrollment lives. From commit ba9c7ae (2026-05-24) the page drew
 * that code as
 *
 *     <img src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=<otpauthUri>">
 *
 * so every enrollment sent the secret, in a query string, to a third-party
 * service — into its access logs, and past anything on the network path that
 * records URLs. Nothing about it looked wrong on screen: the code scanned.
 *
 * Two guards, because the defect has two shapes and they fail differently:
 *
 *   1. THE PAGE. Walked through enrollment for real (the wire stubbed at the
 *      axios adapter, the real i18n bundle), the QR `<img>` must be a
 *      `data:image/svg+xml` URL whose payload is byte-for-byte the panel kit's
 *      plain rendering of exactly `enrollment.otpauthUri` — so it both stays
 *      local AND still encodes the right URI, secret included. Separately, no
 *      `<img>` on the page may point at another origin, and the secret may
 *      appear in no image URL at all: an equality check alone would not notice
 *      a SECOND image added next to the local one.
 *   2. THE SOURCE. No production file under `web/src` may mention a public
 *      QR-image generator. A page test only covers the page it renders; the
 *      next "quick QR" on another screen would be written the same way. The
 *      scan reads comments too, on purpose: a host that may not be CALLED has
 *      no business being documented as an option either, and comment-skipping
 *      is how a scan like this quietly stops seeing code.
 *
 * The plate is asserted as well. Authenticator apps scan dark-on-light; the
 * old plate was `bg-background`, which is near-black in the dark theme.
 */
import { fireEvent, screen } from '@testing-library/react'
import {
  type AxiosAdapter,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { api } from '@/lib/api'
import { authStorage } from '@/lib/auth-storage'
import { QR_STYLE_PLAIN, qrSvg } from '@/lib/qr/kit/qr-style'
import { i18n, i18nReady, loadFeatureBundle } from '@/i18n/i18n'
import { renderWithProviders } from '@/test/test-utils'

import TwoFactorPage from './two-factor-page'

/** A real-shaped enrollment. The secret is the RFC 4648 example, not anyone's. */
const SECRET = 'JBSWY3DPEHPK3PXP'
const OTPAUTH_URI = `otpauth://totp/Rezeis:admin%40example.com?secret=${SECRET}&issuer=Rezeis`

function ok(config: InternalAxiosRequestConfig, data: unknown): AxiosResponse {
  return { data, status: 200, statusText: 'OK', headers: {}, config } as AxiosResponse
}

const adapter: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
  const url = config.url ?? ''
  if (url.includes('/admin/2fa/status')) {
    return ok(config, { enabled: false, enrolledAt: null, recoveryCodesRemaining: 0 })
  }
  if (url.includes('/admin/2fa/enroll')) {
    return ok(config, { secret: SECRET, otpauthUri: OTPAUTH_URI, recoveryCodes: [] })
  }
  if (url.includes('/admin/passkey/credentials')) return ok(config, [])
  if (url.includes('/admin/ip-allowlist')) return ok(config, { items: [], total: 0 })
  return ok(config, {})
}

let originalAdapter: AxiosAdapter | undefined

/** Renders the page and walks it to the enrollment confirm step. */
async function enrollmentQr(): Promise<HTMLImageElement> {
  renderWithProviders(<TwoFactorPage />)
  fireEvent.click(await screen.findByRole('button', { name: i18n.t('twoFactorPage.enableButton') }))
  // The local code is rendered asynchronously (the kit's `qrSvg` is async), so
  // wait for the image itself rather than for the card around it.
  const image = await screen.findByAltText(i18n.t('twoFactorPage.confirm.qrAlt'))
  expect(image.tagName).toBe('IMG')
  return image as HTMLImageElement
}

/** The SVG inside a `data:image/svg+xml[;params],<payload>` URL, or `null`. */
function svgPayload(src: string): string | null {
  if (!src.startsWith('data:image/svg+xml')) return null
  const comma = src.indexOf(',')
  if (comma < 0) return null
  const header = src.slice(0, comma)
  const payload = src.slice(comma + 1)
  return header.endsWith(';base64') ? atob(payload) : decodeURIComponent(payload)
}

beforeAll(async () => {
  await i18nReady
  await loadFeatureBundle('twoFactor')
  // Anti-vacuity: with no bundle every `t()` returns its key path, and a test
  // looking up the button or the alt text by a key path finds nothing real.
  expect(i18n.t('twoFactorPage.enableButton')).not.toBe('twoFactorPage.enableButton')
  expect(i18n.t('twoFactorPage.confirm.qrAlt')).not.toBe('twoFactorPage.confirm.qrAlt')
})

beforeEach(() => {
  originalAdapter = api.defaults.adapter as AxiosAdapter | undefined
  api.defaults.adapter = adapter
  window.localStorage.clear()
  authStorage.setToken('a-live-session-token')
})

afterEach(() => {
  api.defaults.adapter = originalAdapter
  window.localStorage.clear()
})

describe('the enrollment QR code is drawn locally', () => {
  it('is the panel kit’s own plain rendering of exactly the otpauth URI', async () => {
    const image = await enrollmentQr()
    const src = image.getAttribute('src') ?? ''

    // Local, and an SVG — not a PNG from somewhere, not a remote URL.
    expect(src.startsWith('data:image/svg+xml')).toBe(true)
    // And it encodes EXACTLY the enrollment URI, secret included: byte-for-byte
    // what the kit draws for it. A code that stayed local but dropped the
    // secret would enroll nothing, and this is the line that notices.
    expect(svgPayload(src)).toBe(await qrSvg(OTPAUTH_URI, QR_STYLE_PLAIN, 200))
  })

  it('points no image on the page at another origin, and puts the secret in no image URL', async () => {
    await enrollmentQr()
    const images = [...document.querySelectorAll('img')]
    // Anti-vacuity: the QR image is among them.
    expect(images.length).toBeGreaterThan(0)

    const leaks = images
      .map((img) => img.getAttribute('src') ?? '')
      .filter((src) => {
        if (src === '' || src.startsWith('data:') || src.startsWith('blob:')) return false
        return new URL(src, window.location.href).origin !== window.location.origin
      })
    expect(leaks).toEqual([])

    // The secret is shown as text for manual entry — that stays — but no image
    // URL may carry it, local or not. (A `data:` SVG of a QR code contains
    // module geometry, never the encoded text.)
    const carrying = images
      .map((img) => img.getAttribute('src') ?? '')
      .filter((src) => src.includes(SECRET) || decodeURIComponent(src).includes(SECRET))
    expect(carrying).toEqual([])
  })

  it('sits on a white plate in every theme', async () => {
    const image = await enrollmentQr()
    // The nearest element that paints a background under the code.
    let plate: Element | null = image
    while (plate && !/(?:^|\s)bg-/.test(plate.getAttribute('class') ?? '')) {
      plate = plate.parentElement
    }
    const classes = (plate?.getAttribute('class') ?? '').split(/\s+/)
    expect(classes).toContain('bg-white')
    expect(classes).not.toContain('bg-background')
  })
})

// ── The source ────────────────────────────────────────────────────────────────

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * Public QR-image generators: services that render a QR code for whatever is
 * in their query string. Handing one a URL publishes it. Extend the list; do
 * not relax it.
 */
const REMOTE_QR_GENERATORS: readonly string[] = [
  'api.qrserver.com',
  'goqr.me',
  'chart.googleapis.com/chart',
  'image-charts.com',
  'quickchart.io/qr',
  'qrcode.tec-it.com',
  'api.qr-code-generator.com',
  'qrickit.com',
  'barcode.tec-it.com',
]

/** Every `.ts`/`.tsx` under `src`, `src`-relative, tests excluded. */
function sources(dir: string = SRC, into: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) sources(path, into)
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      into.push(path.slice(SRC.length + 1).split(sep).join('/'))
    }
  }
  return into
}

describe('no production file hands a link to a public QR generator', () => {
  it('mentions none of them anywhere under web/src', () => {
    const files = sources()
    // Anti-vacuity: the walk really read the SPA, including the page that had
    // the defect — a scan rooted one directory too deep passes on nothing.
    expect(files.length).toBeGreaterThan(200)
    expect(files).toContain('features/two-factor/two-factor-page.tsx')

    const hits = files.flatMap((file) => {
      const text = readFileSync(join(SRC, file), 'utf8').toLowerCase()
      return REMOTE_QR_GENERATORS.filter((host) => text.includes(host)).map((host) => `${file}: ${host}`)
    })
    expect(hits).toEqual([])
  })
})
