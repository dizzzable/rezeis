import { type JSX } from 'react'
import { useTranslation } from 'react-i18next'

import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

import type { DashboardSummaryInterface } from './dashboard-api'

const SEVERITY_BADGE_VARIANT = {
  INFO: 'secondary',
  WARNING: 'default',
  CRITICAL: 'destructive',
} as const

export function DashboardAttentionSection({
  summary,
}: {
  readonly summary: DashboardSummaryInterface
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('dashboardPage.attention.title')}</CardTitle>
        <CardDescription>{t('dashboardPage.attention.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {summary.attentionItems.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t('dashboardPage.attention.empty')}
          </p>
        ) : (
          summary.attentionItems.map((item) => (
            <div
              key={item.safeKey}
              className="flex flex-col gap-1 rounded-md border p-3"
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{item.title}</span>
                <Badge variant={SEVERITY_BADGE_VARIANT[item.severity]}>
                  {String(t(`dashboardPage.severities.${item.severity}`, item.severity))}
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground">{item.description}</p>
              <p className="text-xs text-muted-foreground">
                {new Date(item.occurredAt).toLocaleString()}
              </p>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  )
}
