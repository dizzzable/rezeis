/**
 * The one answer to "should a decorative effect run right now".
 *
 * WHY IT EXISTS. Two independent flags gate effects in this app, and until this
 * module every consumer picked one of them by hand:
 *
 *   - `appearance-store.visualEffects` — the appearance-level flag. It also
 *     drives `root.dataset.effects`, which the `:root[data-effects="off"]` block
 *     in `index.css` selects on.
 *   - `effects-store.effectsEnabled`  — the switch the operator actually sees,
 *     on the "Визуальные эффекты" card in Settings → Appearance.
 *
 * `EffectsProvider` combined both. Six components — SpotlightCard, GlareHover,
 * Noise, Aurora, SplitText, AnimatedList — read only `visualEffects`. Since
 * nothing in the UI ever calls `setVisualEffects`, that flag is permanently
 * true, so those six ignored the operator's switch entirely: turning effects off
 * left the KPI tiles glowing, the quick actions glinting, the sign-in aurora
 * running and the wordmark animating per character. An audit reproduced all six.
 *
 * So the fix is not a second switch — the appearance tab already has a label for
 * one, and adding it would put two controls named "Визуальные эффекты" in the
 * same settings screen. It is this: one derived value, every consumer reads it,
 * and the single switch the operator has means what it says.
 *
 * WHY A HOOK AND NOT A CONSTANT. Both stores are zustand; subscribing through
 * their selectors is what makes a component re-render when the operator flips
 * the switch. A module-scope read would latch the value at import time.
 *
 * Note for callers that also have an effect of their own to check: this answers
 * only "are effects on at all". `hoverEffect !== 'none'` and friends stay the
 * caller's business — see `HoverEffect`, which asks both questions.
 */
import { useSyncExternalStore } from 'react'
import { useAppearanceStore } from './appearance-store'
import { useEffectsStore } from './effects-store'

export function useEffectsActive(): boolean {
  const visualEffects = useAppearanceStore((s) => s.visualEffects)
  const effectsEnabled = useEffectsStore((s) => s.effectsEnabled)
  return visualEffects && effectsEnabled
}

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'

function subscribeToReducedMotion(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {}
  }
  const query = window.matchMedia(REDUCED_MOTION)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

function readReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia(REDUCED_MOTION).matches
}

/**
 * Whether the operator has asked their system to reduce motion.
 *
 * SEPARATE FROM `useEffectsActive` ON PURPOSE. That one answers "did the
 * operator switch effects off"; this one answers "does this person get hurt by
 * movement". They are different questions with different owners, and a caller
 * that suppresses on this must not thereby report the switch as off.
 *
 * WHAT IT IS FOR, precisely. The app already honours the preference twice over:
 * `MotionRoot` passes `reducedMotion="user"` to motion/react, and `index.css`
 * has a `prefers-reduced-motion` block that kills the CSS animations by name.
 * Neither reaches an effect driven by `requestAnimationFrame` or WebGL —
 * `animation: none` has nothing to switch off in a shader. The global cursor
 * and click effects are exactly that set, and an audit found all of them
 * running at full speed with the preference set.
 *
 * WHY CENTRALLY AND NOT IN EACH EFFECT. Because the components say so: the
 * gates the vendored sources shipped with were deliberately removed —
 * "card artwork is gated centrally, not per component" (see `Tornado.tsx`,
 * `WordGlobe.tsx`). Scattering the check again would re-create what was cleaned
 * up, and the per-component versions froze on a held frame instead of not
 * rendering, which is worse than either alternative.
 *
 * `useSyncExternalStore` rather than an effect + state: the preference can
 * change while the panel is open, and this is exactly the external-source shape
 * that hook exists for.
 */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribeToReducedMotion, readReducedMotion, () => false)
}
