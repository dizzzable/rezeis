import { describe, expect, it } from 'vitest'

import { en as coreEn } from '@/i18n/en'
import { ru as coreRu } from '@/i18n/ru'
import { en as brandingEn } from '@/i18n/features/branding.en'
import { ru as brandingRu } from '@/i18n/features/branding.ru'

import { CARD_EFFECT_CATALOG } from './card-effect-catalog'
import {
  resolveControlLabel,
  resolveOptionLabel,
  type LabelLookup,
} from './card-effect-control-labels'

/**
 * Select values deliberately left in their raw form: CSS font-family tokens, the
 * dither matrix sizes, and CSS numeric font weights. All three are technical
 * identifiers that read the same in every language, and translating them would
 * imply they are display names an operator can reason about differently.
 */
const UNTRANSLATED_OPTIONS = new Set([
  'Inter',
  'system-ui',
  'sans-serif',
  'serif',
  'monospace',
  '2x2',
  '4x4',
  '8x8',
  '300',
  '400',
  '500',
  '600',
  '700',
  '800',
])

type Dict = Record<string, unknown>

/**
 * The card-effect blocks live in the lazy `branding` feature bundle (see
 * i18n/features/branding.{ru,en}.ts), loaded by the web-reiwa route before
 * the page renders. Recreate what `loadFeatureBundle('branding')` does at
 * runtime — `i18n.addResourceBundle(lng, ns, dict, deep=true, overwrite=true)`
 * — so these tests resolve against the same merged dictionary the app uses.
 */
function deepMerge(base: Dict, overlay: Dict): Dict {
  const out: Dict = { ...base }
  for (const [key, value] of Object.entries(overlay)) {
    const existing = out[key]
    if (
      typeof value === 'object' && value !== null && !Array.isArray(value) &&
      typeof existing === 'object' && existing !== null && !Array.isArray(existing)
    ) {
      out[key] = deepMerge(existing as Dict, value as Dict)
    } else {
      out[key] = value
    }
  }
  return out
}

function makeLookup(dict: Dict): LabelLookup {
  return (key, fallback) => {
    let node: unknown = dict
    for (const part of key.split('.')) {
      if (typeof node !== 'object' || node === null) return fallback
      node = (node as Dict)[part]
    }
    return typeof node === 'string' ? node : fallback
  }
}

const en = deepMerge(coreEn as unknown as Dict, brandingEn as unknown as Dict)
const ru = deepMerge(coreRu as unknown as Dict, brandingRu as unknown as Dict)

const lookupEn = makeLookup(en)
const lookupRu = makeLookup(ru)

const entries = Object.entries(CARD_EFFECT_CATALOG)

describe('card effect control translations', () => {
  it('resolves every control label in English exactly as the catalogue states it', () => {
    // The English side is a mirror of the catalogue, so drift between the two —
    // a renamed label, or a reused prop that needs a new effect-scoped override
    // — fails here rather than showing an operator the wrong word.
    const wrong: string[] = []
    for (const [effect, def] of entries) {
      for (const control of def.controls) {
        const resolved = resolveControlLabel(lookupEn, effect, control)
        if (resolved !== control.label) {
          wrong.push(`${effect}.${control.prop}: "${resolved}" != "${control.label}"`)
        }
      }
    }
    expect(wrong).toEqual([])
  })

  it('translates every control label into Russian', () => {
    // Every control used to render its raw English label; a prop missing from
    // the map silently reverts to exactly that, which is invisible in review.
    const untranslated: string[] = []
    for (const [effect, def] of entries) {
      for (const control of def.controls) {
        const resolved = resolveControlLabel(lookupRu, effect, control)
        if (resolved === control.label || resolved.trim() === '') {
          untranslated.push(`${effect}.${control.prop} ("${control.label}")`)
        }
      }
    }
    expect(untranslated).toEqual([])
  })

  it('translates every select option an operator reads', () => {
    const untranslated: string[] = []
    for (const [, def] of entries) {
      for (const control of def.controls) {
        if (control.type !== 'select') continue
        for (const option of control.options ?? []) {
          if (UNTRANSLATED_OPTIONS.has(option)) continue
          if (resolveOptionLabel(lookupRu, control.prop, option) === option) {
            untranslated.push(`${control.prop}.${option}`)
          }
        }
      }
    }
    expect(untranslated).toEqual([])
  })

  it('gives an unknown control the catalogue label rather than a raw key', () => {
    const label = resolveControlLabel(lookupRu, 'notAnEffect', {
      prop: 'notAProp',
      label: 'Brand New Knob',
      type: 'slider',
      default: 1,
    })
    expect(label).toBe('Brand New Knob')
    expect(resolveOptionLabel(lookupRu, 'notAProp', 'notAnOption')).toBe('notAnOption')
  })

  it('keeps origin options distinct from heading options', () => {
    // `appearFrom` names where a thing comes FROM; `direction` names where it
    // goes. One shared word for `left` would be wrong in one of the two.
    expect(resolveOptionLabel(lookupRu, 'appearFrom', 'left')).toBe('Слева')
    expect(resolveOptionLabel(lookupRu, 'direction', 'left')).toBe('Влево')
  })
})
