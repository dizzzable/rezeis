/**
 * Tiny status indicator with a subtle pulsing dot for live states.
 *
 * Used wherever we need to show "node connected", "host disabled",
 * "service offline" without the weight of a full Badge component.
 */
import { cn } from '@/lib/utils'

type Status = 'online' | 'offline' | 'disabled' | 'warning' | 'unknown'

interface StatusDotProps {
  readonly status: Status
  readonly label?: string
  readonly className?: string
}

const colorClasses: Record<Status, string> = {
  online: 'bg-emerald-500',
  offline: 'bg-muted-foreground/40',
  disabled: 'bg-amber-500',
  warning: 'bg-amber-500',
  unknown: 'bg-muted-foreground/30',
}

const ringClasses: Record<Status, string> = {
  online: 'ring-emerald-500/30',
  offline: 'ring-muted-foreground/10',
  disabled: 'ring-amber-500/30',
  warning: 'ring-amber-500/30',
  unknown: 'ring-muted-foreground/10',
}

export function StatusDot({ status, label, className }: StatusDotProps) {
  const ariaLabel = label ?? status
  return (
    <span
      className={cn('inline-flex items-center gap-2 text-xs', className)}
      aria-label={ariaLabel}
    >
      <span className="relative flex h-2.5 w-2.5" aria-hidden>
        {status === 'online' ? (
          <span
            className={cn(
              'absolute inline-flex h-full w-full animate-ping rounded-full opacity-60',
              colorClasses.online,
            )}
          />
        ) : null}
        <span
          className={cn(
            'relative inline-flex h-2.5 w-2.5 rounded-full ring-4',
            colorClasses[status],
            ringClasses[status],
          )}
        />
      </span>
      {label ? <span>{label}</span> : null}
    </span>
  )
}
