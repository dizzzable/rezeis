/**
 * The QR logo upload, owned by the branding page rather than by the QR tab.
 *
 * ── Why not the tab ─────────────────────────────────────────────────────────
 *
 * The tab unmounts whenever another tab is shown, and an upload — a raster of
 * up to 2 MB — easily outlasts a look at another tab. Kept inside the tab, the
 * upload lost everything but its request on the way: coming back, the operator
 * found the upload button enabled while the first upload still ran, and a
 * refusal that arrived meanwhile had been shown to nobody.
 *
 * ── What an upload lands on ─────────────────────────────────────────────────
 *
 * The style AS IT STANDS WHEN THE UPLOAD FINISHES (`read`), not as it stood
 * when the file was picked: a preset, a colour, a logo size or plate chosen
 * while the upload ran all stay, and only the logo's address changes. The tab
 * used to apply it to the style of the pick, which silently undid every one of
 * those the moment the POST resolved.
 *
 * Unless the operator has decided about the logo another way since: picked
 * another file, taken the logo away, taken the brand logo, reset the code to
 * plain, or thrown the page's changes out (`supersede`). None of those asked
 * for the logo still on its way, so it is dropped — its address and its
 * refusal alike.
 *
 * ── How long a refusal stays ────────────────────────────────────────────────
 *
 * Until the operator decides about the logo: the same decisions retire a
 * refusal still standing. A look at another tab changes nothing, and neither
 * do a preset, a colour, a size or a plate. The refused file is still refused,
 * and nothing has taken its place.
 */
import { LOGO_SVG_MAX_BYTES } from '@/lib/qr/kit/qr-logo-source'
import type { QrLogo } from '@/lib/qr/kit/qr-style'

import { BRANDING_RASTER_MAX_BYTES } from './branding-asset-field'
import type { BrandingQrStyleDraft } from './branding-form-schema'

/** A first logo starts at the size and on the plate that spend the least. */
export const NEW_QR_LOGO: Pick<QrLogo, 'size' | 'plate'> = { size: 'small', plate: 'light' }

/** The logo at `src`, at the size and on the plate of the logo it replaces. */
export function qrLogoWithSrc(replaced: QrLogo | null, src: string): QrLogo {
  return { src, size: replaced?.size ?? NEW_QR_LOGO.size, plate: replaced?.plate ?? NEW_QR_LOGO.plate }
}

export type QrLogoUploadRefusal =
  /** Refused before uploading: larger than the server takes, or than the cabinet's loader draws. */
  | { readonly kind: 'too-large'; readonly svg: boolean; readonly bytes: number; readonly limit: number }
  /** The server's own words. */
  | { readonly kind: 'refused'; readonly message: string }
  /** It failed with nothing to say why. */
  | { readonly kind: 'failed' }

export interface QrLogoUploadState {
  readonly uploading: boolean
  readonly refusal: QrLogoUploadRefusal | null
}

export interface QrLogoUploadStore {
  state(): QrLogoUploadState
  /** Uploads a picked file; when it lands, it goes into the style as it stands then. */
  pick(file: File): void
  /** The operator decided about the logo another way: an upload still running is dropped, and a refusal retired. */
  supersede(): void
  subscribe(listener: () => void): () => void
}

export function createQrLogoUploadStore(options: {
  /** Uploads the file and answers its `/uploads/branding/<file>` address. */
  readonly upload: (file: File) => Promise<string>
  /** The style as it stands now. */
  readonly read: () => BrandingQrStyleDraft
  /** Hands back the style with the uploaded logo in it. */
  readonly write: (next: BrandingQrStyleDraft) => void
}): QrLogoUploadStore {
  const listeners = new Set<() => void>()
  let state: QrLogoUploadState = { uploading: false, refusal: null }
  // Moved on by every pick and every other decision about the logo. An upload
  // lands only while it still holds the number of its own pick.
  let decision = 0

  const set = (next: QrLogoUploadState): void => {
    state = next
    for (const listener of [...listeners]) listener()
  }

  return {
    state: () => state,
    pick: (file) => {
      decision += 1
      const pick = decision
      // Guidance before the upload; the server re-checks every byte. The SVG
      // ceiling is the cabinet loader's own number, from the kit.
      const svg = file.type.toLowerCase() === 'image/svg+xml' || (file.type === '' && /\.svg$/i.test(file.name))
      const limit = svg ? LOGO_SVG_MAX_BYTES : BRANDING_RASTER_MAX_BYTES
      if (file.size > limit) {
        set({ uploading: false, refusal: { kind: 'too-large', svg, bytes: file.size, limit } })
        return
      }
      set({ uploading: true, refusal: null })
      new Promise<string>((resolve) => resolve(options.upload(file))).then(
        (src) => {
          if (pick !== decision) return
          const current = options.read()
          options.write({ ...current, logo: qrLogoWithSrc(current.logo, src) })
          set({ uploading: false, refusal: null })
        },
        (error: unknown) => {
          if (pick !== decision) return
          const message = (error as { response?: { data?: { message?: unknown } } } | null)?.response?.data?.message
          set({
            uploading: false,
            refusal: typeof message === 'string' && message.length > 0 ? { kind: 'refused', message } : { kind: 'failed' },
          })
        },
      )
    },
    supersede: () => {
      decision += 1
      // A refusal still standing goes too. The page keeps it past the tab, so
      // it would otherwise stay beside the logo the operator chose instead,
      // and an invalid upload button would say something is wrong with that one.
      if (state.uploading || state.refusal !== null) set({ uploading: false, refusal: null })
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
