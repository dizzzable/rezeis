/**
 * Lightweight horizontal "X of Y" bar used in tables (traffic used vs limit,
 * memory used vs total, etc.). Always renders a tabular number row above
 * the bar so columns align across rows.
 */
import { cn } from '@/lib/utils'

interface MetricBarProps {
  readonly value: number
  readonly max: number
  readonly format?: (n: number) => string
  readonly className?: string
  /**
   * When true the bar tone shifts to amber/destructive once usage approaches
   * the limit. Defaults to `true`.
   */
  readonly toneByThreshold?: boolean
}

export function MetricBar({
  value,
  max,
  format = (n) => n.toLocaleString(),
  className,
  toneByThreshold = true,
}: MetricBarProps) {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0
  const pct = ratio * 100

  const barTone = !toneByThreshold
    ? 'bg-primary'
    : ratio >= 0.95
      ? 'bg-destructive'
      : ratio >= 0.8
        ? 'bg-amber-500'
        : 'bg-emerald-500'

  return (
    <div className={cn('space-y-1', className)}>
      <div className="flex items-baseline justify-between gap-2 text-[11px] tabular-nums text-muted-foreground">
        <span className="font-medium text-foreground">{format(value)}</span>
        <span>{format(max)}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn('h-full rounded-full transition-[width] duration-500 ease-out', barTone)}
          style={{ width: `${pct.toFixed(1)}%` }}
          aria-hidden
        />
      </div>
    </div>
  )
}
