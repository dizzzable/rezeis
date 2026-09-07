import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'

/**
 * Letting an operator SEE an effect their own system asked to silence.
 *
 * THE REPORT. "В превью не показывается сам эффект" — while the same effect
 * animated perfectly for subscribers. Both were true. The icon effects switch
 * off under `prefers-reduced-motion: reduce`, which is right for a subscriber's
 * dashboard and wrong for the one screen whose entire purpose is judging what
 * an effect looks like. Operators run the panel on a desktop, where that
 * setting is commonly on; subscribers open the cabinet on a phone, where it
 * usually is not. So the panel showed a still icon and said nothing about why.
 *
 * The setting is still honoured by default — this is a deliberate press, not a
 * quiet override, and it reaches nothing outside this browser. The cabinet has
 * no such attribute and `icon-effect-css-parity.test.ts` fails if it ever grows
 * one: a subscriber's setting is not an operator's to lift.
 */

/**
 * The attribute the panel's reduced-motion rules are scoped against.
 *
 * MUST stay the name in `icon-effects-preview.css`, which is generated with the
 * scope `:root:not([data-force-icon-motion])`. Two halves of one agreement, in
 * two languages; `icon-motion-override.test.ts` compares them.
 */
export const FORCE_ICON_MOTION_ATTRIBUTE = 'data-force-icon-motion'

/** The `dataset` spelling of the same attribute. */
const FORCE_ICON_MOTION_DATASET_KEY = 'forceIconMotion'

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

function readsReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia(REDUCED_MOTION_QUERY).matches
}

function subscribeToReducedMotion(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => undefined
  }
  const query = window.matchMedia(REDUCED_MOTION_QUERY)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

/**
 * Whether this browser is currently asking for less motion.
 *
 * `useSyncExternalStore` rather than state plus an effect: the media query IS
 * an external store, and the effect version had to re-read it on mount to close
 * the gap between the first render and the listener being attached — which is a
 * `setState` inside an effect, and the lint rule that flags it is right about
 * why. Here React closes that gap itself.
 */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeToReducedMotion,
    readsReducedMotion,
    // No window, no preference to read. The panel does not render on a server,
    // but a snapshot that throws there would be a crash rather than a default.
    () => false,
  )
}

export interface IconMotionOverride {
  /**
   * Whether the switch is worth showing at all.
   *
   * Only when the system is actually asking for less motion. Offering it
   * otherwise would be a control that visibly does nothing, which is its own
   * small version of the defect this fixes.
   */
  readonly offered: boolean
  readonly enabled: boolean
  readonly toggle: () => void
}

export function useIconMotionOverride(): IconMotionOverride {
  const offered = usePrefersReducedMotion()
  const [enabled, setEnabled] = useState(false)

  // The attribute goes on the document, not on this section: the phone preview
  // that shows the same icons is a sibling several levels up, and an operator
  // pressing this expects both to move.
  useEffect(() => {
    if (typeof document === 'undefined') return
    const root = document.documentElement
    if (enabled && offered) {
      root.dataset[FORCE_ICON_MOTION_DATASET_KEY] = 'on'
    } else {
      delete root.dataset[FORCE_ICON_MOTION_DATASET_KEY]
    }
    // Removed on unmount as well: the attribute belongs to this screen, and a
    // leftover would keep lifting the setting on every other page of the panel.
    return () => {
      delete root.dataset[FORCE_ICON_MOTION_DATASET_KEY]
    }
  }, [enabled, offered])

  const toggle = useCallback(() => setEnabled((previous) => !previous), [])

  return { offered, enabled, toggle }
}
