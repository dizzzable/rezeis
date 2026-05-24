import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Users2 } from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'

import { formatPercent } from './partner-formatters'
import { useCohortRetention } from './partners-queries'

const HORIZON = 8

interface Props {
  readonly from: string
  readonly to: string
}

/**
 * Weekly cohort retention heatmap. Each row is a cohort (partners that
 * registered in week W); each column is a week-N window after activation.
 * Cell color encodes retention percentage (0–100%). Cells where the
 * cohort has not been alive long enough are rendered greyed out.
 */
export function CohortHeatmap({ from, to }: Props) {
  const { t } = useTranslation()
  const { data, isLoading } = useCohortRetention({ from, to, horizonWeeks: HORIZON })

  const headerCells = useMemo(
    () => Array.from({ length: HORIZON }, (_, idx) => `W${idx}`),
    [],
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Users2 className="h-4 w-4" />
          {t('partnersAnalytics.cohorts.title')}
        </CardTitle>
        <CardDescription>{t('partnersAnalytics.cohorts.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading || !data ? (
          <Skeleton className="h-64 w-full" />
        ) : data.rows.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            {t('partnersAnalytics.empty')}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr>
                  <th className="text-left px-2 py-1.5 text-[10px] uppercase text-muted-foreground font-medium">
                    {t('partnersAnalytics.cohorts.cohort')}
                  </th>
                  <th className="text-right px-2 py-1.5 text-[10px] uppercase text-muted-foreground font-medium">
                    {t('partnersAnalytics.cohorts.size')}
                  </th>
                  {headerCells.map((label) => (
                    <th
                      key={label}
                      className="text-center px-2 py-1.5 text-[10px] uppercase text-muted-foreground font-medium"
                    >
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <tr key={row.cohortLabel}>
                    <td className="px-2 py-1.5 font-mono text-[11px]">
                      {formatCohortLabel(row.cohortLabel)}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{row.cohortSize}</td>
                    {row.retention.map((value, idx) => (
                      <td
                        key={`${row.cohortLabel}-${idx}`}
                        className="px-1 py-1.5 text-center tabular-nums"
                      >
                        <RetentionCell value={value} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function RetentionCell({ value }: { readonly value: number | null }) {
  if (value === null) {
    return (
      <span className="inline-block w-12 rounded-sm bg-muted/40 py-1 text-[10px] text-muted-foreground">
        —
      </span>
    )
  }
  const intensity = Math.min(1, value)
  const bg = `hsl(160 80% ${Math.round(80 - intensity * 40)}% / ${0.15 + intensity * 0.55})`
  const textClass = intensity > 0.65 ? 'text-emerald-50' : 'text-foreground'
  return (
    <span
      className={`inline-block w-12 rounded-sm py-1 text-[10px] font-semibold ${textClass}`}
      style={{ background: bg }}
    >
      {formatPercent(value, 0)}
    </span>
  )
}

function formatCohortLabel(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return `${date.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' })}`
}
