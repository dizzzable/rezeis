import type { JSX } from 'react'
import { Activity, BadgeDollarSign, CreditCard, Users } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { PageTabs } from '@/components/layout/page-tabs'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'

interface DashboardPanelContent {
  readonly badge: string
  readonly title: string
  readonly description: string
  readonly highlightOneTitle: string
  readonly highlightOneDescription: string
  readonly highlightTwoTitle: string
  readonly highlightTwoDescription: string
  readonly tableDescription: string
}

const DASHBOARD_TAB_KEYS = ['userStatistics', 'transactionStatistics', 'subscriptionStatistics', 'planStatistics'] as const

type DashboardTabKey = (typeof DASHBOARD_TAB_KEYS)[number]

function isDashboardTabKey(value: string): value is DashboardTabKey {
  return DASHBOARD_TAB_KEYS.includes(value as DashboardTabKey)
}

export function DashboardPage(): JSX.Element {
  const { t } = useTranslation()
  const [searchParams, setSearchParams] = useSearchParams()
  const tabValue: string = searchParams.get('tab') ?? 'userStatistics'
  const activeTab: DashboardTabKey = isDashboardTabKey(tabValue) ? tabValue : 'userStatistics'
  const activePanel: DashboardPanelContent = t(`dashboard.tabPanels.${activeTab}`, { returnObjects: true }) as DashboardPanelContent
  const tabItems = DASHBOARD_TAB_KEYS.map((tabKey: DashboardTabKey) => ({
    to: `/dashboard?tab=${tabKey}`,
    label: t(`pageTabs.dashboard.${tabKey}`),
  }))
  const statCards = [
    { icon: Users, key: 'totalUsers' },
    { icon: Activity, key: 'activeSessions' },
    { icon: BadgeDollarSign, key: 'grossVolume' },
    { icon: CreditCard, key: 'conversion' },
  ] as const
  const operationCards = ['access', 'moderation', 'growth'] as const
  function handleTabChange(nextTab: DashboardTabKey): void {
    setSearchParams({ tab: nextTab })
  }

  function handleDashboardTabValueChange(nextValue: string): void {
    if (!isDashboardTabKey(nextValue)) {
      return
    }

    handleTabChange(nextValue)
  }

  return (
    <div className="space-y-4">
      <Card className="overflow-hidden bg-[linear-gradient(140deg,oklch(0.995_0.004_84.6)_0%,oklch(0.938_0.03_206.87/0.68)_50%,oklch(0.56_0.147_248.72/0.08)_100%)]">
        <CardHeader className="gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl">
            <Badge className="w-fit">{t('dashboard.badge')}</Badge>
            <CardTitle className="mt-4 text-3xl">{t('dashboard.hero.title')}</CardTitle>
            <CardDescription className="mt-3 max-w-2xl text-base">{t('dashboard.hero.description')}</CardDescription>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:min-w-[360px]">
            <div className="rounded-3xl border border-border/70 bg-background/70 p-4">
              <p className="text-sm text-muted-foreground">{t('dashboard.hero.primaryMetricLabel')}</p>
              <p className="mt-2 text-2xl font-semibold">{t('dashboard.hero.primaryMetricValue')}</p>
            </div>
            <div className="rounded-3xl border border-border/70 bg-background/70 p-4">
              <p className="text-sm text-muted-foreground">{t('dashboard.hero.secondaryMetricLabel')}</p>
              <p className="mt-2 text-2xl font-semibold">{t('dashboard.hero.secondaryMetricValue')}</p>
            </div>
          </div>
        </CardHeader>
      </Card>
      <PageTabs items={tabItems.map((item) => ({ ...item, to: item.to }))} />
      <div className="grid gap-4 xl:grid-cols-4">
        {statCards.map(({ icon: Icon, key }) => (
          <Card key={key} className="bg-card/95">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <CardDescription>{t(`dashboard.stats.${key}.label`)}</CardDescription>
                  <CardTitle className="mt-2 text-2xl">{t(`dashboard.stats.${key}.value`)}</CardTitle>
                </div>
                <div className="flex size-11 items-center justify-center rounded-2xl bg-accent text-primary">
                  <Icon className="size-5" />
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">{t(`dashboard.stats.${key}.change`)}</p>
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-3">
        {operationCards.map((key) => (
          <Card key={key}>
            <CardHeader>
              <CardTitle>{t(`dashboard.operations.${key}.title`)}</CardTitle>
              <CardDescription>{t(`dashboard.operations.${key}.description`)}</CardDescription>
            </CardHeader>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader className="gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <Badge className="w-fit" variant="secondary">
              {activePanel.badge}
            </Badge>
            <CardTitle className="mt-4 text-2xl">{activePanel.title}</CardTitle>
            <CardDescription className="mt-2 max-w-3xl">{activePanel.description}</CardDescription>
          </div>
          <div className="hidden rounded-2xl border border-border/70 bg-background/70 px-4 py-3 text-sm text-muted-foreground xl:block">
            {t('dashboard.description')}
          </div>
        </CardHeader>
        <CardContent className="grid gap-4 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-1">
            <div className="rounded-3xl border border-border/70 bg-background/70 p-5">
              <p className="text-base font-semibold">{activePanel.highlightOneTitle}</p>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">{activePanel.highlightOneDescription}</p>
            </div>
            <div className="rounded-3xl border border-border/70 bg-background/70 p-5">
              <p className="text-base font-semibold">{activePanel.highlightTwoTitle}</p>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">{activePanel.highlightTwoDescription}</p>
            </div>
          </div>
          <div className="rounded-3xl border border-dashed border-border/80 bg-background/70 p-5">
            <Tabs value={activeTab} onValueChange={handleDashboardTabValueChange} className="gap-5">
              <TabsList variant="line" className="flex h-auto flex-wrap justify-start gap-2 bg-transparent p-0">
                {DASHBOARD_TAB_KEYS.map((tabKey: DashboardTabKey) => (
                  <TabsTrigger
                    key={tabKey}
                    value={tabKey}
                    className="rounded-full border border-border px-3 py-1.5 text-sm text-muted-foreground after:hidden data-[state=active]:border-transparent data-[state=active]:bg-accent data-[state=active]:text-accent-foreground dark:data-[state=active]:border-transparent dark:data-[state=active]:bg-accent"
                  >
                    {t(`pageTabs.dashboard.${tabKey}`)}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            <div className="mt-5 rounded-3xl border border-border/70 bg-card px-5 py-10 text-center">
              <p className="text-base font-semibold">{activePanel.title}</p>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">{activePanel.tableDescription}</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
