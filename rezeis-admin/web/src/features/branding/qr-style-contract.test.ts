import { describe, expect, it } from 'vitest'

import { en } from '@/i18n/en'
import { ru } from '@/i18n/ru'
import { QR_STYLE_PLAIN, isUsableDark, resolveQrStyle } from '@/lib/qr/kit/qr-style'

import {
  BRANDING_QR_EYE_SHAPES,
  BRANDING_QR_MODULE_SHAPES,
  DEFAULT_BRANDING_DRAFT,
  QR_STYLE_PRESETS,
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
  QR_MODULE_SHAPES,
} from '../../../../src/modules/settings/interfaces/branding-settings.interface'
import { readBrandingSettings } from '../../../../src/modules/settings/utils/branding-settings.util'

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
} as const

const schema = createBrandingFormSchema(messages)

function withQrStyle(qrStyle: unknown): BrandingFormDraft {
  return { ...createInitialBrandingDraft(), qrStyle: qrStyle as BrandingFormDraft['qrStyle'] }
}

describe('QR style — defaults', () => {
  it('starts every installation on the plain code, on all three sides', () => {
    expect(QR_STYLE_PLAIN).toEqual({ modules: 'square', eyes: 'square', dark: '#000000' })
    expect(DEFAULT_BRANDING_DRAFT.qrStyle).toEqual(QR_STYLE_PLAIN)
    expect(DEFAULT_BRANDING.qrStyle).toEqual(QR_STYLE_PLAIN)
    // What a fresh page, and an API answer that carries no block, both show.
    expect(createInitialBrandingDraft().qrStyle).toEqual(QR_STYLE_PLAIN)
    expect(createInitialBrandingDraft({}).qrStyle).toEqual(QR_STYLE_PLAIN)
  })

  it('reads a stored block back the way the cabinet draws it', () => {
    // The tab has to show what subscribers see. A block no API save could
    // produce — a restored backup, a hand edit — reads back as the cabinet
    // would draw it: garbage as plain, a colour it would not draw as black.
    expect(createInitialBrandingDraft({ qrStyle: 'dots' as never }).qrStyle).toEqual(QR_STYLE_PLAIN)
    expect(
      createInitialBrandingDraft({ qrStyle: { modules: 'dots', eyes: 'rounded', dark: '#cccccc' } })
        .qrStyle,
    ).toEqual({ modules: 'dots', eyes: 'rounded', dark: '#000000' })
    const navy = { modules: 'rounded', eyes: 'rounded', dark: '#1e3a8a' } as const
    expect(createInitialBrandingDraft({ qrStyle: navy }).qrStyle).toEqual(navy)
  })
})

describe('QR style — shapes', () => {
  it('offers the shapes the API accepts, no more and no fewer', () => {
    expect([...BRANDING_QR_MODULE_SHAPES]).toEqual([...QR_MODULE_SHAPES])
    expect([...BRANDING_QR_EYE_SHAPES]).toEqual([...QR_EYE_SHAPES])
  })

  it('offers only shapes the cabinet renderer draws as chosen', () => {
    for (const modules of BRANDING_QR_MODULE_SHAPES) {
      expect(resolveQrStyle({ modules, eyes: 'square', dark: '#000000' }).modules).toBe(modules)
    }
    for (const eyes of BRANDING_QR_EYE_SHAPES) {
      expect(resolveQrStyle({ modules: 'square', eyes, dark: '#000000' }).eyes).toBe(eyes)
    }
  })

  it('offers only presets the cabinet draws exactly as offered, plain first', () => {
    expect(QR_STYLE_PRESETS[0]?.style).toEqual(QR_STYLE_PLAIN)
    for (const { id, style } of QR_STYLE_PRESETS) {
      expect(resolveQrStyle(style), id).toEqual(style)
      expect(schema.safeParse(withQrStyle(style)).success, id).toBe(true)
    }
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
    const chosen = { modules: 'rounded', eyes: 'rounded', dark: '#1e3a8a' } as const
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
  type QrCopy = Record<'modules' | 'eyes' | 'presets', Record<string, string | undefined>>
  const labels = (copy: QrCopy): void => {
    for (const id of BRANDING_QR_MODULE_SHAPES) expect(copy.modules[id], id).toBeTruthy()
    for (const id of BRANDING_QR_EYE_SHAPES) expect(copy.eyes[id], id).toBeTruthy()
    for (const { id } of QR_STYLE_PRESETS) expect(copy.presets[id], id).toBeTruthy()
  }

  it('in English', () => {
    labels(en.brandingPage.qr)
  })

  it('in Russian', () => {
    labels(ru.brandingPage.qr)
  })
})
