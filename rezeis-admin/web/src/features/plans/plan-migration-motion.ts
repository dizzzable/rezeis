/**
 * Whether the operator's system asks for reduced motion — for the migration
 * animations of the plan delete dialog.
 *
 * ── WHY NOT `usePrefersReducedMotion` FROM `@/lib/theme/effects-active` ──────
 *
 * That hook answers the same question, and importing it from here cost the
 * LOGIN ROUTE two render-blocking requests. `effects-active.ts` imports the two
 * persisted zustand stores (`appearance-store`, `effects-store`); both live in
 * the entry chunk, and once this lazy route also reached them, rolldown lifted
 * each into a shared chunk of its own that the entry then loads eagerly —
 * 14 → 16 eager chunks against the ceiling of 15 in
 * `scripts/check-build-graph.mjs` (measured against a build of the base commit).
 * This copy needs `matchMedia` and nothing else, so it cannot pull a store.
 *
 * `useSyncExternalStore` for the reason the original gives: the preference can
 * change while the dialog is open.
 */
import { useSyncExternalStore } from 'react'

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {}
  const query = window.matchMedia(REDUCED_MOTION)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

function read(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia(REDUCED_MOTION).matches
}

export function useReducedMotionPreference(): boolean {
  return useSyncExternalStore(subscribe, read, () => false)
}
