import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  FORCE_ICON_MOTION_ATTRIBUTE,
  useIconMotionOverride,
} from './icon-motion-override'

/**
 * Seeing an effect the operator's own system asked to silence.
 *
 * THE REPORT: "в превью не показывается сам эффект" — while the same effect
 * animated perfectly for subscribers. Both true at once. The icon effects stop
 * under `prefers-reduced-motion: reduce`, which is right for a subscriber's
 * dashboard and wrong for the one screen whose purpose is judging what an
 * effect looks like: operators run the panel on a desktop, where that setting
 * is commonly on, and subscribers open the cabinet on a phone, where it is not.
 * The panel showed a still icon and explained nothing.
 *
 * Three properties, and each fails in a way nobody would see:
 *
 *   1. the switch is offered ONLY when the setting is on — otherwise it is a
 *      control that visibly does nothing;
 *   2. it writes the attribute the stylesheet is actually scoped against;
 *   3. it takes the attribute back off — on unmount too, or every other page of
 *      the panel keeps running with the operator's setting quietly lifted.
 */

let container: HTMLDivElement
let root: Root

/** Answers the reduced-motion query however a case wants it answered. */
function stubMatchMedia(reduced: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: query.includes('prefers-reduced-motion') ? reduced : false,
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }) as unknown as MediaQueryList,
  )
}

function Probe(): React.JSX.Element {
  const motion = useIconMotionOverride()
  return (
    <button type="button" data-offered={String(motion.offered)} onClick={motion.toggle}>
      {String(motion.enabled)}
    </button>
  )
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete document.documentElement.dataset.forceIconMotion
  vi.unstubAllGlobals()
})

function mount(): HTMLButtonElement {
  act(() => root.render(<Probe />))
  return container.querySelector('button') as HTMLButtonElement
}

describe('the panel motion switch', () => {
  it('is not offered when the system is not asking for less motion', () => {
    // A control that does nothing is a small version of the defect it fixes.
    stubMatchMedia(false)
    expect(mount().dataset.offered).toBe('false')
  })

  it('is offered when the system is asking for less motion', () => {
    stubMatchMedia(true)
    expect(mount().dataset.offered).toBe('true')
  })

  it('lifts the setting only when pressed, and puts it back', () => {
    stubMatchMedia(true)
    const button = mount()
    expect(document.documentElement.hasAttribute(FORCE_ICON_MOTION_ATTRIBUTE)).toBe(false)

    act(() => button.click())
    expect(document.documentElement.hasAttribute(FORCE_ICON_MOTION_ATTRIBUTE)).toBe(true)

    act(() => button.click())
    expect(document.documentElement.hasAttribute(FORCE_ICON_MOTION_ATTRIBUTE)).toBe(false)
  })

  it('cannot lift anything when the setting is not on in the first place', () => {
    // Belt and braces: nothing renders the switch then, but a caller that
    // toggled it anyway must not leave the attribute on a document where it
    // means "override a preference nobody expressed".
    stubMatchMedia(false)
    const button = mount()
    act(() => button.click())
    expect(document.documentElement.hasAttribute(FORCE_ICON_MOTION_ATTRIBUTE)).toBe(false)
  })

  it('takes the attribute off when the screen goes away', () => {
    // Otherwise every other page of the panel keeps running with the
    // operator's own accessibility setting silently lifted.
    stubMatchMedia(true)
    const button = mount()
    act(() => button.click())
    expect(document.documentElement.hasAttribute(FORCE_ICON_MOTION_ATTRIBUTE)).toBe(true)
    act(() => root.unmount())
    expect(document.documentElement.hasAttribute(FORCE_ICON_MOTION_ATTRIBUTE)).toBe(false)
    root = createRoot(container)
  })
})

describe('the switch and the stylesheet agree', () => {
  // Two halves of one agreement written in two languages: an attribute name in
  // TypeScript and a selector in CSS. A rename on either side leaves both
  // halves running and the switch doing nothing at all — silently, and only for
  // the operators who need it.
  const css = readFileSync(join(__dirname, 'icon-effects-preview.css'), 'utf8')

  it('scopes every reduced-motion rule against the attribute the hook writes', () => {
    const scoped = css
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.includes('.icon-effect-') && line.includes('animation: none'))
    expect(scoped.length, 'no reduced-motion rules found in the panel copy').toBeGreaterThan(0)
    for (const rule of scoped) {
      expect(rule, `this rule ignores the motion switch: ${rule}`).toContain(
        `:root:not([${FORCE_ICON_MOTION_ATTRIBUTE}])`,
      )
    }
  })
})
