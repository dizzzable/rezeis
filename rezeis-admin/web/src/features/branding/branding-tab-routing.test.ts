import { describe, expect, it } from 'vitest'

import { DEFAULT_BRANDING_DRAFT } from './branding-form-schema'
import { BRANDING_FALLBACK_TAB, tabForBrandingField } from './branding-page'

/**
 * Every branding field opens the tab that actually renders it.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS. When a save fails validation the page
 * calls `tabForBrandingField(firstIssue.path[0])`, switches to that tab, and
 * sets the error at the issue's full path — `serversGlobe.props.speed`, say.
 * react-hook-form can only mark a field it can find by that path, so if the tab
 * does not render it, NOTHING is marked: the operator lands on an unrelated tab
 * with a toast and no highlighted control, and reports that Save does nothing.
 *
 * The routing is a chain of `if`s ending in a fallback, so a field nobody
 * thought about is not an error — it is silently sent to the fallback tab and
 * behaves exactly as described above. `serversGlobe` did that when the Servers
 * tab was added, which is what this file was written after.
 *
 * The list below is therefore the point: it is DERIVED from the draft, so a new
 * field fails here until somebody says where it belongs.
 */

/** Fields that genuinely belong to the fallback tab, rather than reaching it by accident. */
const DELIBERATELY_ON_THE_FALLBACK_TAB = new Set([
  'brandName',
  'tagline',
  'logoUrl',
  'pwaIconUrl',
  'brandLogo',
  'themePresetId',
  'themePresetVersion',
  'themeModePolicy',
  'themeDefaultMode',
  'themeVariants',
])

describe('branding tab routing', () => {
  const fields = Object.keys(DEFAULT_BRANDING_DRAFT)

  it('covers a draft that is not empty', () => {
    // Anchors everything below: without it, a `DEFAULT_BRANDING_DRAFT` that
    // stopped being written would leave this file iterating nothing and passing.
    expect(fields.length).toBeGreaterThan(20)
  })

  it('sends no field to the fallback tab by accident', () => {
    const accidental = fields.filter(
      (field) =>
        tabForBrandingField(field) === BRANDING_FALLBACK_TAB &&
        !DELIBERATELY_ON_THE_FALLBACK_TAB.has(field),
    )
    expect(
      accidental,
      'these fields fall through the routing chain — the page will jump to the wrong tab and mark no control when one of them fails validation',
    ).toEqual([])
  })

  it('routes the globe to the Servers tab', () => {
    expect(tabForBrandingField('serversGlobe')).toBe('servers')
  })

  it('keeps the tabs it already routed to', () => {
    // A spot check that the chain still means what it says, so a refactor that
    // reorders the `if`s cannot pass on the fallback test alone.
    expect(tabForBrandingField('primary')).toBe('colors')
    expect(tabForBrandingField('cardEffect')).toBe('card')
    expect(tabForBrandingField('appBackground')).toBe('appbg')
    expect(tabForBrandingField('iconDecor')).toBe('icons')
    expect(tabForBrandingField('planCardStyles')).toBe('planCards')
    expect(tabForBrandingField('navItems')).toBe('nav')
  })
})
