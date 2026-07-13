import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Loader2, RefreshCw, ShieldAlert } from 'lucide-react'

import { api } from '@/lib/api'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'

interface EntitlementSlo {
  objectiveMs: number
  alertMs: number
  strandedCapturedOverObjective: number
  strandedCapturedOverAlert: number
  oldestStrandedAgeMs: number | null
  pendingSyncOverObjective: number
  pendingSyncOverAlert: number
  oldestPendingSyncAgeMs: number | null
}

interface EntitlementMetrics {
  entitlementsByState: Record<string, number>
  projectionsByState: Record<string, number>
  deviceReductionPlansByState: Record<string, number>
  openIncidentsByKind: Record<string, number>
  slo: EntitlementSlo
}

function nonZero(record: Record<string, number>): Array<[string, number]> {
  return Object.entries(record).filter(([, count]) => count > 0)
}

export function AddOnEntitlementsTab() {
  const { t } = useTranslation()

  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ['admin', 'add-on-entitlements', 'metrics'],
    queryFn: async () =>
      (await api.get<EntitlementMetrics>('/admin/add-on-entitlements/metrics')).data,
  })

  if (isLoading) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full rounded-lg" />
        ))}
      </div>
    )
  }

  if (isError || !data) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-muted-foreground">
          <ShieldAlert className="mx-auto mb-3 h-8 w-8 text-destructive" />
          <p>{t('addOnsPage.entitlements.loadError')}</p>
          <Button variant="outline" className="mt-4" onClick={() => refetch()}>
            <RefreshCw className="mr-2 h-4 w-4" /> {t('addOnsPage.entitlements.refresh')}
          </Button>
        </CardContent>
      </Card>
    )
  }

  const minutes = (ms: number | null): string =>
    ms === null
      ? t('addOnsPage.entitlements.slo.none')
      : t('addOnsPage.entitlements.slo.minutes', { count: Math.round(ms / 60000) })

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">{t('addOnsPage.entitlements.title')}</h2>
          <p className="text-sm text-muted-foreground">{t('addOnsPage.entitlements.subtitle')}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
          {isFetching ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="mr-2 h-4 w-4" />
          )}
          {t('addOnsPage.entitlements.refresh')}
        </Button>
      </div>

      {/* SLO backlog */}
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
        <SloCard
          label={t('addOnsPage.entitlements.slo.stranded')}
          value={data.slo.strandedCapturedOverObjective}
          alert={data.slo.strandedCapturedOverAlert}
          alertLabel={t('addOnsPage.entitlements.slo.strandedAlert')}
          age={minutes(data.slo.oldestStrandedAgeMs)}
          ageLabel={t('addOnsPage.entitlements.slo.oldestStranded')}
        />
        <SloCard
          label={t('addOnsPage.entitlements.slo.pendingSync')}
          value={data.slo.pendingSyncOverObjective}
          alert={data.slo.pendingSyncOverAlert}
          alertLabel={t('addOnsPage.entitlements.slo.pendingAlert')}
          age={minutes(data.slo.oldestPendingSyncAgeMs)}
          ageLabel={t('addOnsPage.entitlements.slo.oldestPending')}
        />
        <div className="rounded-lg border bg-card p-3">
          <p className="text-xs text-muted-foreground">{t('addOnsPage.entitlements.slo.objective')}</p>
          <p className="text-xl font-bold">{minutes(data.slo.objectiveMs)}</p>
          <p className="mt-2 text-xs text-muted-foreground">{t('addOnsPage.entitlements.slo.alert')}</p>
          <p className="text-xl font-bold">{minutes(data.slo.alertMs)}</p>
        </div>
      </div>

      <StateBreakdown title={t('addOnsPage.entitlements.entitlementsByState')} record={data.entitlementsByState} />
      <StateBreakdown title={t('addOnsPage.entitlements.projectionsByState')} record={data.projectionsByState} />
      <StateBreakdown title={t('addOnsPage.entitlements.plansByState')} record={data.deviceReductionPlansByState} />

      <div>
        <h3 className="mb-2 text-sm font-semibold">{t('addOnsPage.entitlements.incidentsByKind')}</h3>
        {nonZero(data.openIncidentsByKind).length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('addOnsPage.entitlements.noIncidents')}</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {nonZero(data.openIncidentsByKind).map(([kind, count]) => (
              <Badge key={kind} variant="destructive" className="font-mono text-xs">
                {kind}: {count}
              </Badge>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function SloCard({
  label,
  value,
  alert,
  alertLabel,
  age,
  ageLabel,
}: {
  label: string
  value: number
  alert: number
  alertLabel: string
  age: string
  ageLabel: string
}) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-2xl font-bold ${value > 0 ? 'text-amber-500' : ''}`}>{value}</p>
      <p className={`text-xs ${alert > 0 ? 'text-destructive' : 'text-muted-foreground'}`}>
        {alertLabel}: {alert}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {ageLabel}: {age}
      </p>
    </div>
  )
}

function StateBreakdown({ title, record }: { title: string; record: Record<string, number> }) {
  const entries = nonZero(record)
  if (entries.length === 0) return null
  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold">{title}</h3>
      <div className="flex flex-wrap gap-2">
        {entries.map(([state, count]) => (
          <Badge key={state} variant="secondary" className="font-mono text-xs">
            {state}: {count}
          </Badge>
        ))}
      </div>
    </div>
  )
}
