/**
 * `<RemnawaveIcon />` — official Remnawave brand mark.
 *
 * Rendered as a plain `<img>` against the static asset at
 * `/icons/remnawave.svg`. The SVG carries its own colours (radial gradient
 * + dark fill bars), so we never need `currentColor` here. The wrapper is
 * sized with Tailwind classes — pass any `className` that conveys the
 * desired square dimensions (e.g. `h-3.5 w-3.5`).
 *
 * Compatible with the lucide-icon prop signature (`SVGProps<SVGSVGElement>`)
 * so the sidebar's `<ItemIcon />` slot can use it as a drop-in replacement
 * for `Server` / `HardDrive` etc. We swallow the strokeWidth/color props
 * silently because the brand SVG carries its own colours.
 */
import type { SVGProps } from 'react'

import { cn } from '@/lib/utils'

interface RemnawaveIconProps extends Omit<SVGProps<SVGSVGElement>, 'className' | 'children'> {
  readonly className?: string
  /**
   * Defaults to "Remnawave" so screen readers announce the brand. Pass an
   * empty string when the icon is paired with a visible label.
   */
  readonly alt?: string
}

export function RemnawaveIcon({ className, alt = 'Remnawave' }: RemnawaveIconProps) {
  return (
    <img
      src="/icons/remnawave.svg"
      alt={alt}
      aria-hidden={alt === '' ? true : undefined}
      draggable={false}
      className={cn('inline-block select-none', className)}
    />
  )
}
