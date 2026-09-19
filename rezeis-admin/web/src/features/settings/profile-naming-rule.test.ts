import { describe, expect, it } from 'vitest'

import { effectiveNamingPart } from './profile-naming-rule'

/**
 * The repair the settings page shows for a stored naming value — what the
 * server puts into new profile names meanwhile. The server suite holds this
 * file to the server's own reader (`test/profile-naming-repair-contract.spec.ts`);
 * these pin the rule itself, one behaviour each.
 */
describe('effectiveNamingPart', () => {
  it('keeps a valid stored value exactly as stored', () => {
    expect(effectiveNamingPart('_rz-', 'prefix')).toBe('_rz-')
    expect(effectiveNamingPart('--', 'separator')).toBe('--')
  })

  it('turns a run of invalid characters into ONE underscore, and trims underscores and hyphens off both ends', () => {
    expect(effectiveNamingPart('my _shop', 'prefix')).toBe('my_shop')
    expect(effectiveNamingPart(' my shop!', 'prefix')).toBe('my_shop')
  })

  it('replaces a separator with any invalid character by the default instead of cutting it down', () => {
    expect(effectiveNamingPart('x.', 'separator')).toBe('_')
  })

  it('folds accented and full-width letters to their Latin base before anything is dropped', () => {
    expect(effectiveNamingPart(`caf${String.fromCharCode(0xe9)}`, 'prefix')).toBe('cafe')
    expect(effectiveNamingPart(`${String.fromCharCode(0xff21)}nna`, 'suffixBase')).toBe('Anna')
  })

  it('falls back to the default when nothing valid is left, or the value is too long to be read', () => {
    expect(effectiveNamingPart('Магазин', 'prefix')).toBe('rz')
    expect(effectiveNamingPart('x'.repeat(17), 'prefix')).toBe('rz')
    expect(effectiveNamingPart(undefined, 'suffixBase')).toBe('sub')
  })
})
