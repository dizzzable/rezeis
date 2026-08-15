/**
 * PageTitle — the one `<h1>` every section of the panel renders.
 *
 * WHY IT EXISTS. The "Text animation" control in Settings → Appearance offers
 * thirteen options, and until this component existed the renderer behind it
 * (`components/effects/TitleEffect`) had exactly ONE call site in the whole
 * app: the dashboard heading. The other 45 files carrying an `<h1>` each spelt
 * their own heading out by hand. So an operator picked an animation, saw it in
 * the preview, and then never met it again on any screen they work on.
 *
 * Fixing that by editing 46 files would leave the same hole open for file 47.
 * There was no shared page-header component to edit instead — this is it, kept
 * deliberately narrow: it owns the heading element and nothing else. Page
 * headers differ too much in their surroundings (some are a bare `<div>`, some
 * a `<header>` with an action button, some sit inside `FadeIn`) for a
 * whole-header component to be droppable without moving pixels on thirty
 * screens; the heading itself is identical everywhere and is the only part the
 * setting has to reach.
 *
 * WHY `title` IS A STRING AND NOT `children`. Ten of the thirteen animations
 * cannot animate arbitrary JSX and fall back to plain text without one — see
 * `STRING_ONLY_ANIMATIONS` in `TitleEffect`. Taking `ReactNode` here would make
 * "the setting silently does nothing on this page" a one-character mistake at
 * every call site. Trailing decorations (a count badge, a status pill) go in
 * `children`, which renders AFTER the animated text and is never fed to it.
 *
 * The class list is fixed on purpose. The 46 hand-written headings had drifted
 * across `font-bold`/`font-semibold`, with and without `tracking-tight`, and
 * with the icon before or after the flex utilities; `text-2xl font-bold
 * tracking-tight` is the majority spelling and is now the only one.
 * `className` remains for genuinely different contexts (the sign-in card's
 * `text-xl`), not for re-introducing the drift.
 */
import type { ComponentType, ReactNode, SVGProps } from 'react'

import { TitleEffect } from '@/components/effects/TitleEffect'
import { cn } from '@/lib/utils'

interface PageTitleProps {
  /**
   * The section name, already translated. A plain string — see the note above
   * on why this is not `ReactNode`.
   */
  readonly title: string
  /**
   * Lucide (or any SVG) icon component rendered before the text.
   *
   * Typed to the props actually passed rather than `ElementType`: that is a
   * union over every intrinsic tag, so TypeScript intersects their prop types
   * and `className` collapses to `never` at the call below. It compiled only
   * because `tsc -b` PRINTS such an error and still exits 0 — the same trap
   * that let a broken build report clean earlier today.
   */
  readonly icon?: ComponentType<SVGProps<SVGSVGElement>>
  /** Extra classes for the `<h1>` itself. */
  readonly className?: string
  /** Extra classes for the icon; the default is the panel-wide `h-6 w-6`. */
  readonly iconClassName?: string
  /** Rendered after the animated text — badges, counts, status pills. */
  readonly children?: ReactNode
  readonly id?: string
}

export function PageTitle({
  title,
  icon: Icon,
  className,
  iconClassName,
  children,
  id,
}: PageTitleProps) {
  return (
    <h1
      id={id}
      className={cn('flex items-center gap-2 text-2xl font-bold tracking-tight', className)}
    >
      {Icon ? (
        // `shrink-0`: several animations (`split`, `blur`, `shuffle`) turn the
        // title into per-character boxes that wrap, and a flex icon without it
        // gives up its own width to them first.
        <Icon className={cn('h-6 w-6 shrink-0', iconClassName)} aria-hidden="true" />
      ) : null}
      <TitleEffect>{title}</TitleEffect>
      {children}
    </h1>
  )
}
