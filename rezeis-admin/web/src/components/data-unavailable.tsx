/**
 * "This list did not load" marker.
 *
 * WHY THIS EXISTS. A list endpoint that fails now throws (see `expectArray`
 * in `@/lib/api-utils`) instead of handing a non-array to `.map`. That fixes
 * the crash, but on its own it converts a crash into a lie everywhere the
 * component only looks at `data?.length ?? 0`: the operator is shown
 * "No squads available" / "No icons uploaded yet" and concludes their
 * infrastructure is empty, when in fact nobody ever got an answer. A silent
 * empty state is a confident false claim, and on the icon library it is worse
 * than a false claim — an empty draft that gets saved destroys the library.
 *
 * So the sections that speak about infrastructure say "unavailable" out loud,
 * with a retry. Same shape as `InlineError` in advertising-page.tsx and
 * `MetricsUnavailable` in dashboard-system-health.tsx, which chose the same
 * trade-off before this.
 */
import { useTranslation } from 'react-i18next'
import { AlertTriangle, RefreshCw } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface DataUnavailableProps {
  /** What did not load, in the operator's words. Not the raw error. */
  readonly message: string
  /** Omit to render the marker without a retry affordance. */
  readonly onRetry?: () => void
  readonly className?: string
}

export function DataUnavailable({ message, onRetry, className }: DataUnavailableProps) {
  const { t } = useTranslation()
  return (
    <div
      role="status"
      className={cn(
        'flex flex-wrap items-center gap-2 rounded-md border border-dashed border-amber-500/40 bg-amber-500/5 px-3 py-2',
        className,
      )}
    >
      <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" aria-hidden />
      <span className="text-sm text-muted-foreground">{message}</span>
      {onRetry ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto h-7 px-2 text-xs"
          onClick={onRetry}
        >
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden />
          {t('common.retry')}
        </Button>
      ) : null}
    </div>
  )
}
