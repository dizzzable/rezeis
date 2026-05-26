/**
 * Country flag rendering helpers.
 *
 * Flags are bundled at build-time as raw SVG strings, then inlined into the
 * DOM. Inlining (rather than serving each flag as a separate `<img src>`)
 * avoids 200+ extra HTTP requests on first paint and keeps the markup
 * styleable through CSS — the flag SVGs are <2KB each and gzip-compress
 * very well.
 *
 * Resolution flow:
 *   1. `import.meta.glob` walks `country-flag-icons/3x2/*.svg` and embeds
 *      every file's *contents* as a string in the bundle.
 *   2. We build `FLAG_SVGS["DE"] → "<svg…>"` once at module load.
 *   3. `<NodeFlag />` does an O(1) lookup and renders via
 *      `dangerouslySetInnerHTML` — the strings come from a vetted npm
 *      package, never from user input.
 *
 * Unknown / blank codes fall back to a discreet two-letter monogram so the
 * row layout never collapses, and Windows' patchy emoji support never
 * leaks through as broken regional indicators.
 */
import { cn } from '@/lib/utils'

interface NodeFlagProps {
  readonly code: string | null | undefined
  readonly className?: string
  readonly title?: string
}

// `eager: true` inlines the file *contents* directly into the bundle —
// equivalent to writing one `import '../../flags/DE.svg?raw'` line per
// country. We vendor the flag SVGs under `src/flags/` rather than relying
// on a bare-package glob across `node_modules` because Vite strips those
// in production builds — vendoring removes the moving target.
const FLAG_SVGS = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>('../../flags/*.svg', {
      eager: true,
      query: '?raw',
      import: 'default',
    }),
  )
    .map(([path, svg]) => {
      const match = /\/flags\/([A-Z]{2})\.svg$/i.exec(path)
      return [match ? match[1].toUpperCase() : '', svg] as const
    })
    .filter(([code]) => code !== ''),
) as Record<string, string>

export function NodeFlag({ code, className, title }: NodeFlagProps) {
  const normalized = typeof code === 'string' ? code.trim().toUpperCase() : ''
  const svg = normalized.length === 2 ? FLAG_SVGS[normalized] : undefined

  // Always emit a sized, square wrapper so the row layout doesn't shift
  // between known/unknown countries.
  const wrapperClass = cn(
    'inline-flex h-4 w-6 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-muted/30 ring-1 ring-border/40',
    className,
  )

  if (svg) {
    return (
      <span
        className={cn(wrapperClass, 'rezeis-flag')}
        title={title ?? normalized}
        aria-label={title ?? normalized}
        // SVG strings are static, package-vendored data — no XSS surface.
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    )
  }

  // No SVG → render a tight 2-letter monogram. Discreet, font-aligned with
  // the rest of the row, no emoji-font dependency.
  return (
    <span
      className={cn(wrapperClass, 'font-mono text-[8px] font-semibold uppercase tracking-tight text-muted-foreground')}
      title={title ?? (normalized || 'unknown')}
      aria-label={title ?? 'unknown country'}
    >
      {normalized || '??'}
    </span>
  )
}
