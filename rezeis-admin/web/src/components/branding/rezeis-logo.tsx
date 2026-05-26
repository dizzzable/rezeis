/**
 * Brand mark for the Rezeis admin panel.
 *
 * The SVG itself lives in `web/public/rezeis-logo.svg` so it can also serve
 * as the favicon and as a stable URL for any markdown / external embed.
 * We render it as a plain `<img>` to avoid an svgr dependency — the gradient
 * inside the SVG handles its own colors, so we never need `currentColor`.
 *
 * `aria-hidden` is the default since the wordmark "Rezeis Admin" is
 * almost always rendered next to it. Pass `aria-label` (and `role="img"`
 * implicitly via a non-empty `alt`) when the logo stands alone.
 */
import { cn } from '@/lib/utils'

interface RezeisLogoProps {
  readonly className?: string
  readonly alt?: string
}

export function RezeisLogo({ className, alt = '' }: RezeisLogoProps) {
  return (
    <img
      src="/rezeis-logo.svg"
      alt={alt}
      aria-hidden={alt === '' ? true : undefined}
      draggable={false}
      className={cn('select-none', className)}
    />
  )
}
