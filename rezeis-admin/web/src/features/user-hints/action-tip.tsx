import type { ReactElement, ReactNode } from 'react'

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

/**
 * What pressing a button will do, shown on hover and on keyboard focus.
 *
 * ── Why the disabled branch wraps ─────────────────────────────────────────
 *
 * A disabled `<button>` receives no pointer events, so a tooltip bound to it
 * never opens — and a button is disabled exactly when somebody is most likely
 * to wonder what it is waiting for. The focusable `<span>` takes the hover and
 * the focus in its place. An enabled button is its own trigger, so it stays a
 * single tab stop.
 *
 * ── Why it carries its own provider ───────────────────────────────────────
 *
 * The same reason `InfoTip` does: the app shell mounts one, but a tab rendered
 * outside it — a test, a portal — would throw without it, and a missing
 * explanation must never take the form down.
 */
export function ActionTip({
  tip,
  disabled = false,
  side = 'top',
  children,
}: {
  readonly tip: ReactNode
  /** Whether the wrapped button is disabled right now. */
  readonly disabled?: boolean
  readonly side?: 'top' | 'right' | 'bottom' | 'left'
  readonly children: ReactElement
}) {
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          {disabled ? (
            <span
              tabIndex={0}
              className="inline-flex rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {children}
            </span>
          ) : (
            children
          )}
        </TooltipTrigger>
        <TooltipContent
          side={side}
          collisionPadding={8}
          className="max-w-xs whitespace-pre-line text-xs leading-snug"
        >
          {tip}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
