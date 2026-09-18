/**
 * What either side of the online card says instead of a chart or a list when
 * it has nothing true to draw: nothing measured in the window, or the answer
 * did not arrive. It takes the space the chart would, so turning the card over
 * or switching the window does not make the card jump.
 */
import type { JSX, ReactNode } from 'react'
import { AlertTriangle, Radio, RefreshCw } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * One line over the numbers or the lists when they are not current: the last
 * refresh failed, or none has arrived for three intervals. The old answer stays
 * readable — it is the last thing known — but says what it is, with a retry.
 */
export function OnlineStaleNotice({
  message,
  retryLabel,
  retrying,
  onRetry,
}: {
  readonly message: string
  readonly retryLabel: string
  readonly retrying: boolean
  readonly onRetry: () => void
}): JSX.Element {
  return (
    <div
      role="status"
      data-online-stale=""
      className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-700 dark:text-amber-300"
    >
      <AlertTriangle aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">{message}</span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 gap-1 px-2 text-xs text-amber-800 hover:bg-amber-500/15 dark:text-amber-200"
        disabled={retrying}
        onClick={onRetry}
      >
        <RefreshCw aria-hidden="true" className={cn('size-3', retrying && 'motion-safe:animate-spin')} />
        {retryLabel}
      </Button>
    </div>
  )
}

export function OnlineNotice({
  tone,
  title,
  hint,
  action,
  onAction,
}: {
  readonly tone: 'empty' | 'error'
  readonly title: ReactNode
  readonly hint?: ReactNode
  readonly action?: string
  readonly onAction?: () => void
}): JSX.Element {
  const Icon = tone === 'error' ? AlertTriangle : Radio
  return (
    <div
      role={tone === 'error' ? 'alert' : undefined}
      data-online-notice={tone}
      className="flex min-h-48 flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-6 py-8 text-center"
    >
      <Icon
        aria-hidden="true"
        className={cn('size-5', tone === 'error' ? 'text-destructive' : 'text-muted-foreground')}
      />
      <p className="text-sm font-medium">{title}</p>
      {hint ? <p className="max-w-sm text-xs text-muted-foreground">{hint}</p> : null}
      {action && onAction ? (
        <Button type="button" variant="outline" size="sm" className="mt-1 h-7 text-xs" onClick={onAction}>
          {action}
        </Button>
      ) : null}
    </div>
  )
}
