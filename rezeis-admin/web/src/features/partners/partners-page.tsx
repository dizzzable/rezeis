import { useTranslation } from 'react-i18next'
import { useMemo } from 'react'
import {
  Activity,
  BarChart3,
  CircleDollarSign,
  Clock,
  Download,
  Handshake,
  Settings,
  TrendingUp,
} from 'lucide-react'
import { toast } from 'sonner'

import PartnerSettingsPage from '@/features/settings/partner-settings-page'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { FadeIn, StaggerList } from '@/lib/motion'
import { useTabSync } from '@/lib/use-tab-sync'
import { useRealtimeUpdates } from '@/lib/realtime/use-realtime-updates'

import {
  formatKopecks,
  formatKopecksCompact,
  formatNumber,
} from './partner-formatters'
import { AnimatedCounter } from './animated-counter'
import { Sparkline } from './sparkline'
import PartnersAnalyticsTab from './partners-analytics-tab'
import PartnersListTab from './partners-list-tab'
import PartnersWithdrawalsTab from './partners-withdrawals-tab'
import { downloadCsv } from './csv-download'
import { usePartnerStats, useTimeseries } from './partners-queries'

const ALLOWED_TABS = ['partners', 'withdrawals', 'analytics', 'settings'] as const
type PartnersTab = (typeof ALLOWED_TABS)[number]

export default function PartnersPage() {
  const { t } = useTranslation()
  const { activeTab, setTab } = useTabSync<PartnersTab>(ALLOWED_TABS, 'partners')
  const { data: stats, isLoading: statsLoading } = usePartnerStats()
  const range30d = useMemo(() => {
    const to = new Date()
    const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000)
    return { from: from.toISOString(), to: to.toISOString(), granularity: 'day' as const }
  }, [])
  const { data: timeseries } = useTimeseries(range30d)
  const sparkValues = useMemo(
    () => (timeseries?.points ?? []).map((p) => p.earnings),
    [timeseries],
  )
  const sparkApprovedValues = useMemo(
    () => (timeseries?.points ?? []).map((p) => p.withdrawalsApproved),
    [timeseries],
  )

  // Live partner.earning toasts while the operator has the partners
  // page open. The global hook (mounted in `<AdminShell>`) only surfaces
  // WARNING/ERROR; we hook a page-local handler for partner-program
  // INFO events that operators care about.
  useRealtimeUpdates({
    showToasts: false,
    topics: ['PARTNER'],
    onEvent: (event) => {
      if (event.type === 'partner.earning') {
        const earning =
          typeof event.metadata?.earning === 'number' ? event.metadata.earning : null
        if (earning !== null) {
          toast.success(
            t('partnersPage.realtime.earning', {
              amount: formatKopecksCompact(earning),
            }),
            { description: event.message },
          )
        }
      } else if (event.type === 'partner.withdrawal_requested') {
        toast.info(t('partnersPage.realtime.withdrawalRequested'), {
          description: event.message,
        })
      }
    },
  })

  async function handleExportPartners() {
    try {
      await downloadCsv({
        path: '/admin/partners/export/partners.csv',
        filename: `partners-${new Date().toISOString().slice(0, 10)}.csv`,
      })
      toast.success(t('partnersAnalytics.export.success'))
    } catch {
      toast.error(t('partnersAnalytics.export.failed'))
    }
  }

  async function handleExportWithdrawals() {
    try {
      await downloadCsv({
        path: '/admin/partners/export/withdrawals.csv',
        filename: `partner-withdrawals-${new Date().toISOString().slice(0, 10)}.csv`,
      })
      toast.success(t('partnersAnalytics.export.success'))
    } catch {
      toast.error(t('partnersAnalytics.export.failed'))
    }
  }

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Handshake className="h-6 w-6" />
              {t('partnersPage.title')}
            </h1>
            <p className="text-muted-foreground">{t('partnersPage.subtitle')}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={handleExportPartners}>
              <Download className="h-3.5 w-3.5 mr-1.5" />
              {t('partnersPage.export.partners')}
            </Button>
            <Button variant="outline" size="sm" onClick={handleExportWithdrawals}>
              <Download className="h-3.5 w-3.5 mr-1.5" />
              {t('partnersPage.export.withdrawals')}
            </Button>
          </div>
        </div>
      </FadeIn>

      {/* Stats hero */}
      <StaggerList className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <StatCard
          icon={<Handshake className="h-4 w-4 text-muted-foreground" />}
          label={t('partnersPage.stats.total')}
          numericValue={statsLoading ? null : stats?.totalPartners ?? 0}
          formatter={formatNumber}
        />
        <StatCard
          icon={<TrendingUp className="h-4 w-4 text-emerald-500" />}
          label={t('partnersPage.stats.active')}
          numericValue={statsLoading ? null : stats?.activePartners ?? 0}
          formatter={formatNumber}
        />
        <StatCard
          icon={<CircleDollarSign className="h-4 w-4 text-blue-500" />}
          label={t('partnersPage.stats.totalBalance')}
          numericValue={statsLoading ? null : (stats?.totalBalance ?? 0) / 100}
          formatter={(v) => formatKopecksCompact(v * 100)}
        />
        <StatCard
          icon={<Activity className="h-4 w-4 text-emerald-500" />}
          label={t('partnersPage.stats.earnings30d')}
          numericValue={statsLoading ? null : (stats?.earningsLast30d ?? 0) / 100}
          formatter={(v) => formatKopecksCompact(v * 100)}
          accent="emerald"
          sparkline={sparkValues}
        />
        <StatCard
          icon={<Activity className="h-4 w-4 text-blue-500" />}
          label={t('partnersPage.stats.earnings7d')}
          numericValue={statsLoading ? null : (stats?.earningsLast7d ?? 0) / 100}
          formatter={(v) => formatKopecksCompact(v * 100)}
          sparkline={sparkApprovedValues}
        />
        <StatCard
          icon={<Clock className="h-4 w-4 text-yellow-500" />}
          label={t('partnersPage.stats.pendingWithdrawals')}
          numericValue={statsLoading ? null : stats?.pendingWithdrawals ?? 0}
          formatter={formatNumber}
          accent={stats && stats.pendingWithdrawals > 0 ? 'warning' : undefined}
        />
      </StaggerList>

      {stats && stats.totalEarned > 0 && (
        <Card>
          <CardContent className="pt-4 grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <ProgramSummaryRow
              label={t('partnersPage.summary.totalEarned')}
              value={formatKopecks(stats.totalEarned)}
            />
            <ProgramSummaryRow
              label={t('partnersPage.summary.totalWithdrawn')}
              value={formatKopecks(stats.totalWithdrawn)}
            />
            <ProgramSummaryRow
              label={t('partnersPage.summary.completed30d')}
              value={formatNumber(stats.completedLast30d)}
            />
            <ProgramSummaryRow
              label={t('partnersPage.summary.rejectedTotal')}
              value={formatNumber(stats.rejectedWithdrawals)}
            />
          </CardContent>
        </Card>
      )}

      <Tabs value={activeTab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="partners">
            <Handshake className="h-3.5 w-3.5 mr-1.5" />
            {t('partnersPage.tabs.partners')}
          </TabsTrigger>
          <TabsTrigger value="withdrawals">
            <CircleDollarSign className="h-3.5 w-3.5 mr-1.5" />
            {t('partnersPage.tabs.withdrawals')}
          </TabsTrigger>
          <TabsTrigger value="analytics">
            <BarChart3 className="h-3.5 w-3.5 mr-1.5" />
            {t('partnersPage.tabs.analytics')}
          </TabsTrigger>
          <TabsTrigger value="settings">
            <Settings className="h-3.5 w-3.5 mr-1.5" />
            {t('partnersPage.tabs.settings')}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="partners">
          <PartnersListTab />
        </TabsContent>
        <TabsContent value="withdrawals">
          <PartnersWithdrawalsTab />
        </TabsContent>
        <TabsContent value="analytics">
          <PartnersAnalyticsTab />
        </TabsContent>
        <TabsContent value="settings" className="pt-4">
          <PartnerSettingsPage />
        </TabsContent>
      </Tabs>
    </div>
  )
}

function StatCard({
  icon,
  label,
  numericValue,
  formatter,
  accent,
  sparkline,
}: {
  readonly icon: React.ReactNode
  readonly label: string
  readonly numericValue: number | null
  readonly formatter: (value: number) => string
  readonly accent?: 'emerald' | 'warning'
  readonly sparkline?: ReadonlyArray<number>
}) {
  const accentClass =
    accent === 'emerald'
      ? 'text-emerald-500'
      : accent === 'warning'
        ? 'text-yellow-500'
        : ''
  return (
    <Card>
      <CardContent className="pt-4">
        <div className="flex items-center gap-2 text-muted-foreground">
          {icon}
          <p className="text-[10px] uppercase tracking-wide">{label}</p>
        </div>
        {numericValue === null ? (
          <Skeleton className="h-8 w-24 mt-2" />
        ) : (
          <div className="flex items-end justify-between gap-2">
            <p className={`text-2xl font-bold tabular-nums mt-1 ${accentClass}`}>
              <AnimatedCounter value={numericValue} format={formatter} />
            </p>
            {sparkline && sparkline.length > 1 && (
              <Sparkline
                values={sparkline}
                stroke={accent === 'warning' ? '#facc15' : 'hsl(var(--primary))'}
                fill={
                  accent === 'warning'
                    ? 'hsl(48 95% 60% / 0.15)'
                    : 'hsl(var(--primary) / 0.15)'
                }
              />
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function ProgramSummaryRow({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <p className="text-[11px] text-muted-foreground uppercase">{label}</p>
      <p className="text-base font-semibold tabular-nums mt-1">{value}</p>
    </div>
  )
}
