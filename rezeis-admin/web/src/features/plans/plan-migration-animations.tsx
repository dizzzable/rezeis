/**
 * The two animations of the migration steps: synchronisation while subscriptions
 * move, and success once they all have. CSS and SVG only — no dependency.
 *
 * ── REDUCED MOTION IS HONOURED TWICE, ON PURPOSE ───────────────────────────
 *
 * The caller passes `usePrefersReducedMotion()`, and under it these render a
 * STATIC icon: nothing moves, and the step's text status says what is
 * happening. That branch is what a spec can drive (jsdom evaluates no media
 * query in a class name). The animated branch still puts every animation behind
 * `motion-safe:`, so a preference that changes between renders — or a browser
 * that answers the media query differently from `matchMedia` — never gets
 * motion either. The in-app "animations off" switch needs nothing here:
 * `index.css` collapses every CSS animation under `data-animations="off"`, and
 * the success drawing ends on its final, fully drawn frame (`both`).
 *
 * The keyframes are scoped by name and emitted inline, so this file owns them
 * rather than `index.css`, which is shared by the whole panel.
 */
import type { CSSProperties } from 'react'
import { CheckCircle2, RefreshCw } from 'lucide-react'

import { cn } from '@/lib/utils'

const KEYFRAMES = `
@keyframes plan-migration-orbit { to { transform: rotate(360deg); } }
@keyframes plan-migration-halo {
  0%, 100% { transform: scale(0.86); opacity: 0.45; }
  50% { transform: scale(1); opacity: 1; }
}
@keyframes plan-migration-pop {
  0% { transform: scale(0.6); opacity: 0; }
  70% { transform: scale(1.04); opacity: 1; }
  100% { transform: scale(1); opacity: 1; }
}
@keyframes plan-migration-draw { from { stroke-dashoffset: var(--plan-migration-stroke); } to { stroke-dashoffset: 0; } }
`

/** `--plan-migration-stroke` is the drawn length of the path it is set on. */
function strokeLength(length: number): CSSProperties {
  return { strokeDasharray: length, ['--plan-migration-stroke' as string]: length }
}

export function MigrationSyncAnimation({ reducedMotion }: { readonly reducedMotion: boolean }) {
  if (reducedMotion) {
    return (
      <div
        data-motion="static"
        aria-hidden="true"
        className="flex h-20 w-20 items-center justify-center rounded-full bg-primary/10"
      >
        <RefreshCw className="h-8 w-8 text-primary" strokeWidth={2.25} />
      </div>
    )
  }
  return (
    <div data-motion="animated" aria-hidden="true" className="relative flex h-20 w-20 items-center justify-center">
      <style>{KEYFRAMES}</style>
      <span className="absolute inset-0 rounded-full bg-primary/10 motion-safe:animate-[plan-migration-halo_2.4s_ease-in-out_infinite]" />
      <svg viewBox="0 0 80 80" className="absolute inset-0 h-20 w-20">
        <circle cx="40" cy="40" r="35" fill="none" className="stroke-primary/15" strokeWidth="3" />
        <g
          className="motion-safe:animate-[plan-migration-orbit_1.8s_linear_infinite]"
          style={{ transformOrigin: '40px 40px' }}
        >
          <path
            d="M40 5 A35 35 0 0 1 75 40"
            fill="none"
            className="stroke-primary"
            strokeWidth="3"
            strokeLinecap="round"
          />
          <path
            d="M40 75 A35 35 0 0 1 5 40"
            fill="none"
            className="stroke-primary/50"
            strokeWidth="3"
            strokeLinecap="round"
          />
        </g>
      </svg>
      <RefreshCw
        className="relative h-8 w-8 text-primary motion-safe:animate-[plan-migration-orbit_3.6s_linear_infinite]"
        strokeWidth={2.25}
      />
    </div>
  )
}

export function MigrationSuccessAnimation({ reducedMotion }: { readonly reducedMotion: boolean }) {
  if (reducedMotion) {
    return (
      <div
        data-motion="static"
        aria-hidden="true"
        className="flex h-20 w-20 items-center justify-center rounded-full bg-emerald-500/10"
      >
        <CheckCircle2 className="h-10 w-10 text-emerald-600 dark:text-emerald-400" />
      </div>
    )
  }
  return (
    <div data-motion="animated" aria-hidden="true" className="relative flex h-20 w-20 items-center justify-center">
      <style>{KEYFRAMES}</style>
      <span
        className={cn(
          'absolute inset-0 rounded-full bg-emerald-500/10',
          'motion-safe:animate-[plan-migration-pop_480ms_cubic-bezier(0.2,0.8,0.2,1)_both]',
        )}
      />
      <svg viewBox="0 0 52 52" className="relative h-14 w-14 text-emerald-600 dark:text-emerald-400">
        <circle
          cx="26"
          cy="26"
          r="23"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          transform="rotate(-90 26 26)"
          style={strokeLength(145)}
          className="motion-safe:animate-[plan-migration-draw_620ms_ease-out_both]"
        />
        <path
          d="M15.5 27 L22.5 34 L37 19"
          fill="none"
          stroke="currentColor"
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={strokeLength(34)}
          className="motion-safe:animate-[plan-migration-draw_380ms_ease-out_520ms_both]"
        />
      </svg>
    </div>
  )
}
