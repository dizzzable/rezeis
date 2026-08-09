/**
 * Costs tab — the `GET /api/infra-billing/providers` slice.
 *
 * WHAT THIS TABLE CAN HONESTLY SHOW. The panel sends, per provider, a lifetime
 * bill tally (`billingHistory.totalAmount` / `.totalBills`) and the list of
 * nodes it bills for (`billingNodes`). It sends NO provider type, NO monthly
 * figure and — checked against both 2.7.4 and 2.8.0 — NO currency anywhere.
 * The table used to have a Type column, a Nodes column and a Monthly-cost
 * column reading fields that exist in neither spec, so every row read
 * `— / 0 / (blank)`. Those three are replaced by the three the panel does
 * send, and the amount is deliberately printed WITHOUT a currency symbol,
 * because inventing one would be the same class of lie in a costlier place.
 */
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { CircleDollarSign, ExternalLink, Loader2 } from 'lucide-react'

import { DataUnavailable } from '@/components/data-unavailable'
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
import { NodeFlag } from '../remnawave-flags'
import { KEYS } from '../remnawave-query-keys'
import { EndpointDegraded } from '../shared/endpoint-degraded'
import { TabHeader } from '../shared/tab-header'

export function CostsTab() {
  const { t } = useTranslation()
  const { data: providers, isLoading, isError, refetch } = useQuery({
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
          ) : isError || !providers ? (
            <DataUnavailable
              className="mx-6 mb-4"
              message={t('remnaWavePage.costs.providers.unavailable')}
              onRetry={() => void refetch()}
            />
          ) : providers.length === 0 ? (
            <p className="px-6 pb-4 text-sm text-muted-foreground">{t('remnaWavePage.costs.providers.empty')}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('remnaWavePage.costs.providers.name')}</TableHead>
                  <TableHead className="text-right">{t('remnaWavePage.costs.providers.nodes')}</TableHead>
                  <TableHead className="text-right">{t('remnaWavePage.costs.providers.bills')}</TableHead>
                  <TableHead className="text-right">{t('remnaWavePage.costs.providers.billedTotal')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {providers.map((p) => (
                  <TableRow key={p.uuid}>
                    <TableCell>
                      {p.loginUrl ? (
                        <a
                          href={p.loginUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="inline-flex items-center gap-1 font-medium hover:underline"
                        >
                          {p.name}
                          <ExternalLink className="h-3 w-3 text-muted-foreground" aria-hidden />
                        </a>
                      ) : (
                        <p className="font-medium">{p.name}</p>
                      )}
                      <p className="font-mono text-[10px] text-muted-foreground/70">{p.uuid.slice(0, 8)}…</p>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="ml-auto flex max-w-fit items-center gap-1">
                        <span className="tabular-nums">{p.billingNodes.length}</span>
                        {p.billingNodes.length > 0 ? (
                          <div className="flex items-center -space-x-1">
                            {p.billingNodes.slice(0, 4).map((n, i) => (
                              // `nodeUuid` is null on an orphaned 2.8.0 billing
                              // line, so it cannot carry the key on its own.
                              <NodeFlag
                                key={n.nodeUuid ?? `${p.uuid}:${i}`}
                                code={n.countryCode}
                                title={n.name}
                                className="h-3 w-4"
                              />
                            ))}
                          </div>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{p.billsCount}</TableCell>
                    {/* No currency: the panel reports none on either version. */}
                    <TableCell className="text-right tabular-nums">{p.billedTotalAmount.toFixed(2)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {providers && providers.length > 0 ? (
            <p className="px-6 pb-4 pt-3 text-xs text-muted-foreground">
              {t('remnaWavePage.costs.providers.amountNote')}
            </p>
          ) : null}
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
