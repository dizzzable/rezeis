/**
 * Compact KPI tile used across every Remnawave tab. Designed for a 3- or
 * 4-column grid: title strip on top, big animated number in the middle,
 * optional subtext at the bottom.
 *
 * Numbers tween smoothly via `@number-flow/react` — no jarring jumps when
 * counters update from auto-refresh queries. Strings render as-is.
 */
import { Suspense, lazy } from 'react'
import type { ComponentType, SVGProps } from 'react'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'

// Number-flow ships an animated `<NumberFlow value={…}/>` widget; we lazy-load
// it so dashboards that don't render any tiles never pull the runtime.
const NumberFlow = lazy(() =>
  import('@number-flow/react').then((m) => ({ default: m.default })),
)

interface StatTileProps {
  readonly icon?: ComponentType<SVGProps<SVGSVGElement>>
  readonly title: string
  readonly value: number | string
  readonly subtitle?: string
  readonly tone?: 'default' | 'success' | 'warning' | 'destructive'
  readonly className?: string
  /**
   * If true, wraps the title in a smaller eyebrow style — useful for inline
   * sub-tiles inside drill-downs.
   */
  readonly compact?: boolean
}

const toneClasses: Record<NonNullable<StatTileProps['tone']>, string> = {
  default: 'text-foreground',
  success: 'text-emerald-500',
  warning: 'text-amber-500',
  destructive: 'text-destructive',
}

export function StatTile({
  icon: Icon,
  title,
  value,
  subtitle,
  tone = 'default',
  className,
  compact = false,
}: StatTileProps) {
  return (
    <Card className={cn('relative overflow-hidden', className)}>
      <CardHeader className={cn('flex flex-row items-center justify-between', compact ? 'pb-1' : 'pb-2')}>
        <CardTitle className={cn(compact ? 'text-xs font-medium' : 'text-sm font-medium', 'text-muted-foreground')}>
          {title}
        </CardTitle>
        {Icon ? <Icon className={cn('h-4 w-4 text-muted-foreground/70')} aria-hidden /> : null}
      </CardHeader>
      <CardContent>
        <div className={cn('font-bold tabular-nums leading-tight', compact ? 'text-xl' : 'text-2xl', toneClasses[tone])}>
          {typeof value === 'number' ? (
            <Suspense fallback={value.toLocaleString()}>
              <NumberFlow value={value} />
            </Suspense>
          ) : (
            value
          )}
        </div>
        {subtitle ? (
          <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>
        ) : null}
      </CardContent>
    </Card>
  )
}
