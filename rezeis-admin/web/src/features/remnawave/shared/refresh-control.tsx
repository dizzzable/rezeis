/**
 * Per-card refresh control: lets the operator pick between off / 5s / 30s,
 * and shows when the data was last fetched.
 *
 * The actual refetching is owned by TanStack Query — this widget just toggles
 * the local interval state (passed back via `onChange`) and renders a manual
 * "refresh now" button that forwards to `onRefresh()`.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

export type RefreshInterval = 'off' | '5s' | '30s'

const intervalToMs: Record<RefreshInterval, number | false> = {
  off: false,
  '5s': 5_000,
  '30s': 30_000,
}

interface RefreshControlProps {
  readonly interval: RefreshInterval
  readonly onIntervalChange: (next: RefreshInterval) => void
  readonly onRefresh: () => void
  readonly isFetching?: boolean
  readonly lastUpdatedAt?: Date | null
  readonly className?: string
}

export function intervalToRefetchMs(interval: RefreshInterval): number | false {
  return intervalToMs[interval]
}

export function RefreshControl({
  interval,
  onIntervalChange,
  onRefresh,
  isFetching = false,
  lastUpdatedAt,
  className,
}: RefreshControlProps) {
  const { t } = useTranslation()
  const labels: Record<RefreshInterval, string> = {
    off: t('remnaActions.refresh.off'),
    '5s': t('remnaActions.refresh.fiveSec'),
    '30s': t('remnaActions.refresh.thirtySec'),
  }
  return (
    <div className={cn('flex items-center gap-1.5 text-xs text-muted-foreground', className)}>
      {lastUpdatedAt ? <RelativeTime date={lastUpdatedAt} /> : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs">
            {labels[interval]}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => onIntervalChange('off')}>{labels.off}</DropdownMenuItem>
          <DropdownMenuItem onClick={() => onIntervalChange('5s')}>{labels['5s']}</DropdownMenuItem>
          <DropdownMenuItem onClick={() => onIntervalChange('30s')}>{labels['30s']}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={onRefresh}
        aria-label={t('remnaActions.refresh.now')}
      >
        <RefreshCw className={cn('h-3.5 w-3.5', isFetching && 'animate-spin')} aria-hidden />
      </Button>
    </div>
  )
}

function RelativeTime({ date }: { date: Date }) {
  // Re-render every 10s so the relative time stays roughly accurate without
  // wasting a frame budget on more frequent updates.
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 10_000)
    return () => window.clearInterval(id)
  }, [])

  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000))
  let label = `${seconds}s`
  if (seconds >= 60) {
    label = `${Math.floor(seconds / 60)}m`
  }
  if (seconds >= 3600) {
    label = `${Math.floor(seconds / 3600)}h`
  }
  return <span className="tabular-nums">{label}</span>
}
