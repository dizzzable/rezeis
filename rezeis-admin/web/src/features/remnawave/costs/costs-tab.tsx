/**
 * Costs tab — infra-billing surface. Right now Remnawave 2.7.x exposes only
 * the `providers` slice; deeper `billing-nodes` and `bill-records` endpoints
 * 404 here, so we render a "coming with a panel upgrade" notice for those
 * detail breakdowns instead of fabricating zeros.
 */
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { CircleDollarSign, Loader2 } from 'lucide-react'

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

import { remnawaveApi } from '../remnawave-api'
import { KEYS } from '../remnawave-query-keys'
import { EndpointDegraded } from '../shared/endpoint-degraded'
import { TabHeader } from '../shared/tab-header'

export function CostsTab() {
  const { t } = useTranslation()
  const { data: providers, isLoading } = useQuery({
    queryKey: KEYS.infraProviders,
    queryFn: remnawaveApi.getInfraProviders,
  })

  return (
    <div className="space-y-4">
      <TabHeader
        title={t('remnaWavePage.tabs.costs')}
        subtitle={t('remnaWavePage.costs.subtitle')}
      />

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <CircleDollarSign className="h-4 w-4 text-muted-foreground" aria-hidden />
            {t('remnaWavePage.costs.providers.title')}
          </CardTitle>
          <CardDescription className="text-xs">
            {t('remnaWavePage.costs.providers.description', { count: providers?.length ?? 0 })}
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {isLoading ? (
            <div className="flex h-24 items-center justify-center">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden />
            </div>
          ) : !providers || providers.length === 0 ? (
            <p className="px-6 pb-4 text-sm text-muted-foreground">{t('remnaWavePage.costs.providers.empty')}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('remnaWavePage.costs.providers.name')}</TableHead>
                  <TableHead>{t('remnaWavePage.costs.providers.type')}</TableHead>
                  <TableHead className="text-right">{t('remnaWavePage.costs.providers.nodes')}</TableHead>
                  <TableHead className="text-right">{t('remnaWavePage.costs.providers.monthly')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {providers.map((p) => (
                  <TableRow key={p.uuid}>
                    <TableCell>
                      <p className="font-medium">{p.name}</p>
                      <p className="font-mono text-[10px] text-muted-foreground/70">{p.uuid.slice(0, 8)}…</p>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{p.type ?? '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">{p.nodesCount}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {p.monthlyCost !== null
                        ? `${p.monthlyCost.toFixed(2)} ${p.currency ?? ''}`.trim()
                        : '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <EndpointDegraded
        title={t('remnaWavePage.costs.detail.title')}
        description={t('remnaWavePage.costs.detail.description')}
        compact
      />
    </div>
  )
}
