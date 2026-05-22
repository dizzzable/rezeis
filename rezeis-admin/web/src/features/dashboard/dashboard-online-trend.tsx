import { type JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Activity } from 'lucide-react'

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'

import { dashboardApi, type OnlineTrendPoint } from './dashboard-api'

export function DashboardOnlineTrend(): JSX.Element {
  const { t } = useTranslation()

  const { data: trend, isLoading } = useQuery({
    queryKey: ['admin', 'remnawave', 'online-trend'],
    queryFn: () => dashboardApi.getOnlineTrend(24),
    refetchInterval: 60_000,
  })

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="h-4 w-4" />
            {t('dashboardPage.onlineTrend.title')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-48 w-full" />
        </CardContent>
      </Card>
    )
  }

  if (!trend || trend.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="h-4 w-4" />
            {t('dashboardPage.onlineTrend.title')}
          </CardTitle>
          <CardDescription>{t('dashboardPage.onlineTrend.noData')}</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground py-8 text-center">
            {t('dashboardPage.onlineTrend.collectingData')}
          </p>
        </CardContent>
      </Card>
    )
  }

  const chartData = trend.map((point: OnlineTrendPoint) => ({
    time: new Date(point.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    online: point.onlineNow,
    nodes: point.nodesOnline,
  }))

  const maxOnline = Math.max(...trend.map((p) => p.onlineNow), 1)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="h-4 w-4" />
          {t('dashboardPage.onlineTrend.title')}
        </CardTitle>
        <CardDescription>
          {t('dashboardPage.onlineTrend.description', { max: maxOnline })}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-48">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="onlineGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="hsl(142, 71%, 45%)" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="hsl(142, 71%, 45%)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis
                dataKey="time"
                className="text-xs"
                tick={{ fontSize: 10 }}
                interval="preserveStartEnd"
              />
              <YAxis className="text-xs" tick={{ fontSize: 10 }} width={30} />
              <Tooltip
                contentStyle={{
                  borderRadius: '8px',
                  border: '1px solid hsl(var(--border))',
                  backgroundColor: 'hsl(var(--background))',
                  fontSize: '12px',
                }}
              />
              <Area
                type="monotone"
                dataKey="online"
                stroke="hsl(142, 71%, 45%)"
                fill="url(#onlineGradient)"
                strokeWidth={2}
                name={t('dashboardPage.onlineTrend.onlineLabel')}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  )
}
