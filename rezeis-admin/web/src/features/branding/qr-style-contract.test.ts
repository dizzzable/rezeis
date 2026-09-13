import { describe, expect, it } from 'vitest'

import { en } from '@/i18n/en'
import { ru } from '@/i18n/ru'
import { LOGO_SVG_MAX_BYTES } from '@/lib/qr/kit/qr-logo-source'
import { QR_STYLE_PLAIN, isQrLogoSrc, isUsableDark, resolveQrStyle, type QrLogo } from '@/lib/qr/kit/qr-style'

import {
  BRANDING_QR_EYE_SHAPES,
  BRANDING_QR_LOGO_PLATES,
  BRANDING_QR_LOGO_SIZES,
  BRANDING_QR_MODULE_SHAPES,
  DEFAULT_BRANDING_DRAFT,
  QR_STYLE_PRESETS,
  applyQrStylePreset,
  createBrandingDirtyPatch,
  createBrandingFormSchema,
  createInitialBrandingDraft,
  getBrandingChangedFields,
  type BrandingFormDraft,
} from './branding-form-schema'

// The API's own vocabulary, default and reader — imported, not restated, the
// way `branding-preset-slot-preservation.test.tsx` drives the real merge.
import {
  DEFAULT_BRANDING,
  QR_EYE_SHAPES,
  QR_LOGO_PLATES,
  QR_LOGO_SIZES,
  QR_MODULE_SHAPES,
} from '../../../../src/modules/settings/interfaces/branding-settings.interface'
import { readBrandingSettings } from '../../../../src/modules/settings/utils/branding-settings.util'
import { QR_LOGO_SVG_MAX_BYTES } from '../../../../src/modules/settings/utils/branding-qr-style.util'

/**
 * One QR style, three places that judge it: the panel's form, the panel's API,
 * and the cabinet's renderer (the vendored copy in `@/lib/qr/kit`, byte-frozen
 * against reiwa by `qr-kit-manifest.test.ts`). Each was written to the same
 * rule; this file is what keeps "the same" true. None of the ways they could
 * disagree is an error anybody sees:
 *
 *   - the form accepts, the API refuses — a save the operator cannot explain;
 *   - the API keeps, the cabinet refuses — the panel shows a colour and
 *     subscribers get black;
 *   - the form or the API offers a shape the renderer does not know — the
 *     cabinet quietly draws squares for a choice the operator made.
 */

const messages = {
  hexInvalid: 'hex invalid',
  imageUrlInvalid: 'image url invalid',
  gradientInvalid: 'gradient invalid',
  qrDarkTooLight: 'qr dark too light',
  qrLogoInvalid: 'qr logo invalid',
} as const

const schema = createBrandingFormSchema(messages)

function withQrStyle(qrStyle: unknown): BrandingFormDraft {
  return { ...createInitialBrandingDraft(), qrStyle: qrStyle as BrandingFormDraft['qrStyle'] }
}

/** A logo the panel's own upload produces. */
const LOGO: QrLogo = { src: '/uploads/branding/0123456789abcdef0123456789abcdef.png', size: 'large', plate: 'dark' }

describe('QR style — defaults', () => {
  it('starts every installation on the plain code, with no logo, on all three sides', () => {
    expect(QR_STYLE_PLAIN).toEqual({ modules: 'square', eyes: 'square', dark: '#000000', logo: null })
    expect(DEFAULT_BRANDING_DRAFT.qrStyle).toEqual(QR_STYLE_PLAIN)
    expect(DEFAULT_BRANDING.qrStyle).toEqual(QR_STYLE_PLAIN)
    // What a fresh page, and an API answer that carries no block, both show.
    expect(createInitialBrandingDraft().qrStyle).toEqual(QR_STYLE_PLAIN)
    expect(createInitialBrandingDraft({}).qrStyle).toEqual(QR_STYLE_PLAIN)
  })

  it('reads a stored block back the way the cabinet draws it', () => {
    // The tab has to show what subscribers see. A block no API save could
    // produce — a restored backup, a hand edit — reads back as the cabinet
    // would draw it: garbage as plain, a colour it would not draw as black,
    // a logo it would not load as none.
    expect(createInitialBrandingDraft({ qrStyle: 'dots' as never }).qrStyle).toEqual(QR_STYLE_PLAIN)
    expect(
      createInitialBrandingDraft({ qrStyle: { modules: 'dots', eyes: 'rounded', dark: '#cccccc' } as never })
        .qrStyle,
    ).toEqual({ modules: 'dots', eyes: 'rounded', dark: '#000000', logo: null })
    const navy = { modules: 'rounded', eyes: 'rounded', dark: '#1e3a8a', logo: null } as const
    expect(createInitialBrandingDraft({ qrStyle: navy }).qrStyle).toEqual(navy)
    expect(createInitialBrandingDraft({ qrStyle: { ...navy, logo: LOGO } }).qrStyle).toEqual({ ...navy, logo: LOGO })
    expect(
      createInitialBrandingDraft({ qrStyle: { ...navy, logo: { ...LOGO, src: 'https://cdn.example.com/l.png' } } })
        .qrStyle,
    ).toEqual(navy)
  })
})

describe('QR style — shapes', () => {
  it('offers the shapes, logo sizes and plates the API accepts, no more and no fewer', () => {
    expect([...BRANDING_QR_MODULE_SHAPES]).toEqual([...QR_MODULE_SHAPES])
    expect([...BRANDING_QR_EYE_SHAPES]).toEqual([...QR_EYE_SHAPES])
    expect([...BRANDING_QR_LOGO_SIZES]).toEqual([...QR_LOGO_SIZES])
    expect([...BRANDING_QR_LOGO_PLATES]).toEqual([...QR_LOGO_PLATES])
  })

  it('offers only shapes, sizes and plates the cabinet renderer draws as chosen', () => {
    for (const modules of BRANDING_QR_MODULE_SHAPES) {
      expect(resolveQrStyle({ modules, eyes: 'square', dark: '#000000' }).modules).toBe(modules)
    }
    for (const eyes of BRANDING_QR_EYE_SHAPES) {
      expect(resolveQrStyle({ modules: 'square', eyes, dark: '#000000' }).eyes).toBe(eyes)
    }
    for (const size of BRANDING_QR_LOGO_SIZES) {
      expect(resolveQrStyle({ ...QR_STYLE_PLAIN, logo: { ...LOGO, size } }).logo?.size).toBe(size)
    }
    for (const plate of BRANDING_QR_LOGO_PLATES) {
      expect(resolveQrStyle({ ...QR_STYLE_PLAIN, logo: { ...LOGO, plate } }).logo?.plate).toBe(plate)
    }
  })

  it('offers only presets the cabinet draws exactly as offered, plain first', () => {
    expect(applyQrStylePreset(QR_STYLE_PLAIN, QR_STYLE_PRESETS[0].style)).toEqual(QR_STYLE_PLAIN)
    for (const { id, style } of QR_STYLE_PRESETS) {
      const applied = applyQrStylePreset(QR_STYLE_PLAIN, style)
      expect(resolveQrStyle(applied), id).toEqual(applied)
      expect(schema.safeParse(withQrStyle(applied)).success, id).toBe(true)
    }
  })

  it('keeps the operator’s logo when a preset is applied — every preset, both ways', () => {
    // The owner's decision: a preset is a way to draw the code around the
    // logo, not a reason to lose it.
    for (const { id, style } of QR_STYLE_PRESETS) {
      expect(Object.keys(style).sort(), id).toEqual(['dark', 'eyes', 'modules'])
      const current = { modules: 'dots', eyes: 'rounded', dark: '#595959', logo: LOGO } as const
      expect(applyQrStylePreset(current, style), id).toEqual({ ...style, logo: LOGO })
      expect(applyQrStylePreset({ ...current, logo: null }, style), id).toEqual({ ...style, logo: null })
    }
  })
})

describe('QR style — the logo, in the form', () => {
  const issues = (logo: unknown): string[][] => {
    const result = schema.safeParse(withQrStyle({ ...QR_STYLE_PLAIN, logo }))
    return result.success ? [] : result.error.issues.map((issue) => [issue.path.join('.'), issue.message])
  }

  it('takes no logo, and a logo the cabinet draws', () => {
    expect(issues(null)).toEqual([])
    expect(issues(LOGO)).toEqual([])
    expect(issues({ ...LOGO, size: 'small', plate: 'light', src: '/uploads/branding/mark.svg' })).toEqual([])
  })

  it('reads a block without a logo key as no logo, as the API and the cabinet read it', () => {
    const { logo: _none, ...threeMembers } = QR_STYLE_PLAIN
    const parsed = schema.safeParse(withQrStyle(threeMembers))
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.qrStyle).toEqual(QR_STYLE_PLAIN)
  })

  it('refuses an address the cabinet does not load, on the logo’s address, with the operator’s message', () => {
    for (const src of [
      'https://cdn.example.com/qr-logo.png',
      '/uploads/branding/../icons/qr-logo.png',
      '/uploads/branding/qr-logo.gif',
      'data:image/png;base64,iVBORw0KGgo=',
      '',
    ]) {
      expect(issues({ ...LOGO, src }), src).toEqual([['qrStyle.logo.src', messages.qrLogoInvalid]])
    }
  })

  it('refuses a size or plate it does not know, and a missing member', () => {
    expect(issues({ ...LOGO, size: 'huge' }).map(([path]) => path)).toEqual(['qrStyle.logo.size'])
    expect(issues({ ...LOGO, plate: 'glass' }).map(([path]) => path)).toEqual(['qrStyle.logo.plate'])
    expect(issues({ src: LOGO.src, size: LOGO.size }).map(([path]) => path)).toEqual(['qrStyle.logo.plate'])
    expect(issues('/uploads/branding/qr-logo.png').map(([path]) => path)).toEqual(['qrStyle.logo'])
  })

  it('uploads SVG logos under the ceiling the cabinet’s loader has — the API’s number is the kit’s', () => {
    // Over it the cabinet silently draws no logo, so an API that let a larger
    // SVG through would store a logo nobody ever sees. The kit is byte-frozen
    // against the cabinet, so this follows the cabinet on the next sync.
    expect(QR_LOGO_SVG_MAX_BYTES).toBe(LOGO_SVG_MAX_BYTES)
  })

  it('refuses exactly the addresses the cabinet would not load — form, API and cabinet agree', () => {
    const sources = [
      LOGO.src,
      '/uploads/branding/a.png',
      '/uploads/branding/A.PNG',
      '/uploads/branding/a.svg',
      '/uploads/branding/a.webp',
      '/uploads/branding/a.jpg',
      '/uploads/branding/a.jpeg',
      '/uploads/branding/a-b_c.d.png',
      '/uploads/branding/-a.png',
      '/uploads/branding/a b.png',
      '/uploads/branding/a/b.png',
      '/uploads/branding/a..png',
      '/uploads/branding/a.png ',
      '/uploads/branding/a.tiff',
      '/uploads/branding/.png',
      '/UPLOADS/branding/a.png',
      'https://cabinet.example.com/uploads/branding/a.png',
      `/uploads/branding/${'a'.repeat(256 - '/uploads/branding/.png'.length)}.png`,
      `/uploads/branding/${'a'.repeat(257 - '/uploads/branding/.png'.length)}.png`,
    ]
    const disagreements: string[] = []
    let loaded = 0
    let refused = 0
    for (const src of sources) {
      const cabinet = isQrLogoSrc(src)
      const api = readBrandingSettings({ qrStyle: { ...QR_STYLE_PLAIN, logo: { ...LOGO, src } } }).qrStyle.logo !== null
      const form = issues({ ...LOGO, src }).length === 0
      if (cabinet) loaded += 1
      else refused += 1
      if (api !== cabinet || form !== cabinet) disagreements.push(`${src}: cabinet ${cabinet}, api ${api}, form ${form}`)
    }
    // Anchor: agreement over a sweep that only ever went one way proves nothing.
    expect(loaded).toBeGreaterThanOrEqual(8)
    expect(refused).toBeGreaterThanOrEqual(8)
    expect(disagreements).toEqual([])
  })
})

describe('QR style — colour', () => {
  /** Every `#rgb` colour, the 7:1 boundary, and spellings a side could treat differently. */
  function colours(): readonly string[] {
    const digits = '0123456789abcdef'
    const out: string[] = []
    for (const r of digits) {
      for (const g of digits) {
        for (const b of digits) out.push(`#${r}${g}${b}`)
      }
    }
    out.push(
      '#595959',
      '#5a5a5a',
      // 6.999258:1 — the closest a colour gets to the floor from below, and the
      // one place two implementations of the same arithmetic would part ways.
      '#0050ca',
      '#767676',
      '#1e3a8a',
      '#1E3A8A',
      '#000000',
      '#ffffff',
      '  #595959  ',
      '#00000080',
      '#0000',
      '000000',
      '#12345',
      'black',
      '',
    )
    return out
  }

  it('refuses exactly the colours the cabinet would not draw — form, API and cabinet agree', () => {
    const disagreements: string[] = []
    let drawn = 0
    let refused = 0
    for (const dark of colours()) {
      const cabinet = isUsableDark(dark.trim())
      const api =
        readBrandingSettings({ qrStyle: { modules: 'dots', eyes: 'rounded', dark } }).qrStyle.dark ===
        dark.trim()
      const form = schema.safeParse(withQrStyle({ modules: 'dots', eyes: 'rounded', dark })).success
      if (cabinet) drawn += 1
      else refused += 1
      if (api !== cabinet || form !== cabinet) {
        disagreements.push(`${JSON.stringify(dark)}: cabinet ${cabinet}, api ${api}, form ${form}`)
      }
    }
    // Anchor: agreement over a sweep that only ever went one way proves nothing.
    expect(drawn).toBeGreaterThan(100)
    expect(refused).toBeGreaterThan(100)
    expect(disagreements).toEqual([])
  })

  it('puts the refusal on the colour, with the message the operator reads', () => {
    const issues = (dark: string): string[][] => {
      const result = schema.safeParse(withQrStyle({ modules: 'dots', eyes: 'rounded', dark }))
      return result.success
        ? []
        : result.error.issues.map((issue) => [issue.path.join('.'), issue.message])
    }
    // WCAG's 4.5:1 grey: well-formed, too light — the contrast is what is wrong.
    expect(issues('#767676')).toEqual([['qrStyle.dark', messages.qrDarkTooLight]])
    // Not a colour at all: said as that, not as "too light".
    expect(issues('#12')).toEqual([['qrStyle.dark', messages.hexInvalid]])
    expect(issues('#595959')).toEqual([])
  })

  it('refuses a partial block, as the API does', () => {
    expect(schema.safeParse(withQrStyle({ modules: 'dots' })).success).toBe(false)
  })
})

describe('QR style — the save carries it (gates 4 and 5, at run time as well as compile time)', () => {
  it('sees a changed style and sends it whole', () => {
    const baseline = createInitialBrandingDraft()
    const chosen = { modules: 'rounded', eyes: 'rounded', dark: '#1e3a8a', logo: null } as const
    const values: BrandingFormDraft = { ...baseline, qrStyle: chosen }
    const dirtyFields = getBrandingChangedFields(values, baseline)
    // Gate 4: a field the dirty check does not iterate never leaves the page.
    expect(dirtyFields).toEqual({ qrStyle: true })
    const result = createBrandingDirtyPatch({ values, dirtyFields, schema })
    expect(result.success).toBe(true)
    if (!result.success) return
    // Gate 5: a field the schema does not declare is stripped here, and the
    // request would carry `qrStyle: undefined` — which JSON sends as nothing.
    expect(result.data).toEqual({ qrStyle: chosen })
  })

  it('sees a logo added to an unchanged style, and sends it with the style', () => {
    const baseline = createInitialBrandingDraft()
    const values: BrandingFormDraft = { ...baseline, qrStyle: { ...baseline.qrStyle, logo: LOGO } }
    const dirtyFields = getBrandingChangedFields(values, baseline)
    expect(dirtyFields).toEqual({ qrStyle: true })
    const result = createBrandingDirtyPatch({ values, dirtyFields, schema })
    expect(result.success && JSON.parse(JSON.stringify(result.data))).toEqual({ qrStyle: { ...QR_STYLE_PLAIN, logo: LOGO } })
  })

  it('sends `logo: null` — not nothing — when the logo is taken away', () => {
    const baseline = createInitialBrandingDraft({ qrStyle: { ...QR_STYLE_PLAIN, logo: LOGO } })
    const values: BrandingFormDraft = { ...baseline, qrStyle: { ...baseline.qrStyle, logo: null } }
    const result = createBrandingDirtyPatch({ values, dirtyFields: getBrandingChangedFields(values, baseline), schema })
    expect(result.success && JSON.parse(JSON.stringify(result.data))).toEqual({ qrStyle: QR_STYLE_PLAIN })
  })
})

describe('QR style — every choice the tab offers has a label', () => {
  /**
   * The shape lists above are pinned to the API's, so a shape added there
   * arrives on this tab whether anybody wrote a label for it or not — and the
   * tab reads its labels by interpolated key (`brandingPage.qr.modules.${id}`),
   * which renders the key path itself at the operator when it is missing. A
   * renamed preset id does the same.
   */
  // Widened on purpose: the two bundles have different literal types, and a
  // missing label has to fail as a TEST, naming the id, rather than as a type
  // error in a file nobody reads while chasing an untranslated button.
  type QrCopy = Record<'modules' | 'eyes' | 'presets', Record<string, string | undefined>> & {
    readonly logo: Record<'sizes' | 'plates', Record<string, string | undefined>>
  }
  const labels = (copy: QrCopy): void => {
    for (const id of BRANDING_QR_MODULE_SHAPES) expect(copy.modules[id], id).toBeTruthy()
    for (const id of BRANDING_QR_EYE_SHAPES) expect(copy.eyes[id], id).toBeTruthy()
    for (const { id } of QR_STYLE_PRESETS) expect(copy.presets[id], id).toBeTruthy()
    for (const id of BRANDING_QR_LOGO_SIZES) expect(copy.logo.sizes[id], id).toBeTruthy()
    for (const id of BRANDING_QR_LOGO_PLATES) expect(copy.logo.plates[id], id).toBeTruthy()
  }

  it('in English', () => {
    labels(en.brandingPage.qr)
  })

  it('in Russian', () => {
    labels(ru.brandingPage.qr)
  })
})
