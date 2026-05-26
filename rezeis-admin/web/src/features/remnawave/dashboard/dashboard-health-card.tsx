/**
 * Compact health badge for Dashboard top-row. Shows Remnawave's own
 * `/api/system/health` status as one of three rings:
 *   - green: status="ok" (or healthy / up / running)
 *   - amber: status="degraded" (or warning)
 *   - red:   anything else, or `null` (endpoint inaccessible).
 *
 * Width is fixed at one card slot; never grows.
 */
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Activity, ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-react'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'

import { remnawaveApi } from '../remnawave-api'
import { KEYS } from '../remnawave-query-keys'

type Tone = 'ok' | 'degraded' | 'down'

const toneClasses: Record<Tone, { ring: string; text: string; bg: string; Icon: typeof ShieldCheck }> = {
  ok: { ring: 'ring-emerald-500/40', text: 'text-emerald-500', bg: 'bg-emerald-500/10', Icon: ShieldCheck },
  degraded: { ring: 'ring-amber-500/40', text: 'text-amber-500', bg: 'bg-amber-500/10', Icon: ShieldAlert },
  down: { ring: 'ring-destructive/40', text: 'text-destructive', bg: 'bg-destructive/10', Icon: ShieldQuestion },
}

function classifyStatus(raw: string | undefined): Tone {
  const s = (raw ?? '').toString().toLowerCase()
  if (['ok', 'healthy', 'up', 'running', 'available'].includes(s)) return 'ok'
  if (['degraded', 'warning', 'partial'].includes(s)) return 'degraded'
  return 'down'
}

export function DashboardHealthCard() {
  const { t } = useTranslation()
  const { data: health, isLoading } = useQuery({
    queryKey: KEYS.health,
    queryFn: remnawaveApi.getHealth,
    refetchInterval: 60_000,
  })

  // null = endpoint not exposed in this Remnawave version. Treat as "unknown"
  // (down tone) but with a different message — operator should be told the
  // truth, not a fake green light.
  const tone: Tone = health === undefined || isLoading ? 'down' : classifyStatus(health?.status)
  const { Icon, text, bg, ring } = toneClasses[tone]

  return (
    <Card className={cn('relative overflow-hidden ring-1 transition-colors', ring)}>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{t('remnaWavePage.dashboard.health.title')}</CardTitle>
        <Activity className="h-4 w-4 text-muted-foreground/70" aria-hidden />
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-3">
          <div className={cn('flex h-10 w-10 items-center justify-center rounded-full', bg)}>
            <Icon className={cn('h-5 w-5', text)} aria-hidden />
          </div>
          <div>
            <p className={cn('text-base font-semibold leading-tight', text)}>
              {health === null
                ? t('remnaWavePage.dashboard.health.unknown')
                : tone === 'ok'
                  ? t('remnaWavePage.dashboard.health.healthy')
                  : tone === 'degraded'
                    ? t('remnaWavePage.dashboard.health.degraded')
                    : t('remnaWavePage.dashboard.health.down')}
            </p>
            {health?.version ? (
              <p className="text-xs text-muted-foreground">v{health.version}</p>
            ) : (
              <p className="text-xs text-muted-foreground">{t('remnaWavePage.dashboard.health.noVersion')}</p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
