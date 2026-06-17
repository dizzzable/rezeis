/**
 * `<RemnashopIcon />` — Remnashop brand mark (headphones + equaliser bars).
 *
 * Rendered as a plain `<img>` against the static, transparent-background SVG at
 * `/icons/remnashop.svg` (cyan strokes, no fill behind). Sized via Tailwind
 * `className` (e.g. `h-3.5 w-3.5`). Mirrors `RemnawaveIcon` so it can sit on
 * the imports source tab next to the other brand marks.
 */
import type { SVGProps } from 'react'

import { cn } from '@/lib/utils'

interface RemnashopIconProps extends Omit<SVGProps<SVGSVGElement>, 'className' | 'children'> {
  readonly className?: string
  /** Accessible label; pass an empty string when paired with a visible label. */
  readonly alt?: string
}

export function RemnashopIcon({ className, alt = 'Remnashop' }: RemnashopIconProps) {
  return (
    <img
      src="/icons/remnashop.svg"
      alt={alt}
      aria-hidden={alt === '' ? true : undefined}
      draggable={false}
      className={cn('inline-block select-none', className)}
    />
  )
}
