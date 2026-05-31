import type { CSSProperties } from 'react'

import { cn } from '@/lib/utils'

interface CustomIconViewProps {
  /** Public icon URL (`/uploads/icons/<file>`). */
  url: string
  /** Optional hex tint. When set, the glyph is recoloured via a CSS mask. */
  color?: string | null
  className?: string
  /** Accessible label; when omitted the icon is treated as decorative. */
  title?: string
}

/**
 * Renders an operator-uploaded custom icon.
 *
 * When `color` is set, the icon is drawn as a CSS `mask` filled with that
 * colour — so a single monochrome SVG/PNG recolours to any theme/use site
 * (this is how the menu-icon tinting works elsewhere). When `color` is null,
 * the asset renders as-is via a background image (keeps multicolour art
 * intact). Either way the element is a fixed square sized by `className`.
 */
export function CustomIconView({ url, color, className, title }: CustomIconViewProps) {
  const base: CSSProperties = {
    backgroundColor: color ?? undefined,
    backgroundImage: color ? undefined : `url("${url}")`,
    backgroundSize: 'contain',
    backgroundRepeat: 'no-repeat',
    backgroundPosition: 'center',
  }
  const masked: CSSProperties = color
    ? {
        WebkitMaskImage: `url("${url}")`,
        maskImage: `url("${url}")`,
        WebkitMaskSize: 'contain',
        maskSize: 'contain',
        WebkitMaskRepeat: 'no-repeat',
        maskRepeat: 'no-repeat',
        WebkitMaskPosition: 'center',
        maskPosition: 'center',
      }
    : {}

  return (
    <span
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      title={title}
      className={cn('inline-block h-4 w-4 shrink-0', className)}
      style={{ ...base, ...masked }}
    />
  )
}
