/**
 * «Подписки без привязки к Remnawave» — what the automatic check could not
 * prove, and why.
 * ──────────────────────────────────────────────────────────────────────────
 * The check that replaced «Починка привязки к панели» links a subscription to
 * its Remnawave profile by itself when it can PROVE the profile is that
 * subscription's. Everything it could not prove lands here, each row with the
 * reason in the operator's words and the facts behind it — which profile it
 * found, whose line names somebody else, which other subscription already
 * holds it — and one way forward: «Привязать профиль».
 *
 * A REASON IS A SENTENCE, NEVER A CODE. "ownedByOther" tells an operator
 * nothing; "profile 4471 belongs to another customer by its reiwa_id line"
 * tells them not to link it. A code this build does not know is shown by
 * name, with "this build does not know it", rather than dropped.
 *
 * `duplicatePair` IS NOT A LINKING PROBLEM. The profile is already linked, to
 * another live subscription of the same customer — that is a pair for the
 * merge, and the row says so and switches to that tab.
 */
import type { JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import type { TFunction } from 'i18next'
import { GitMerge, Unlink } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useHasPermission } from '@/features/rbac'
import { formatDate, formatDateTime } from '@/lib/utils'
import { LinkProfileDialog } from './link-profile-dialog'
import {
  fetchUnlinkedSubscriptions,
  isUnlinkedReasonCode,
  type UnlinkedSubscriptionRow,
} from './panel-link-check-api'
import { subscriptionToolsQueryKeys } from './query-keys'
import {
  CustomerCell,
  PanelLinkCheckStatusLine,
  SubscriptionStatusText,
  ToolLoadFailure,
} from './tool-parts'

const LOOKED_UP_BY = ['shortUuid', 'username'] as const

/** The row's reason as one sentence, with its facts in it. */
function reasonSentence(t: TFunction, row: UnlinkedSubscriptionRow): string {
  const missing = t('subscriptionTools.common.fieldMissing')
  if (!isUnlinkedReasonCode(row.reason)) {
    return t('subscriptionTools.unlinked.reasons.unknown', {
      code: row.reason.length > 0 ? row.reason : missing,
    })
  }
  const lookedUpBy = (LOOKED_UP_BY as readonly string[]).includes(row.lookedUpBy ?? '')
    ? t(`subscriptionTools.unlinked.lookedUpBy.${row.lookedUpBy}`)
    : t('subscriptionTools.unlinked.lookedUpBy.unknown')
  return t(`subscriptionTools.unlinked.reasons.${row.reason}`, {
    profileId: row.profileId ?? missing,
    otherSubscriptionId: row.otherSubscriptionId ?? missing,
    otherUserId: row.otherUserId ?? missing,
    lookedUpBy,
  })
}

/** How the subscription reads in the link dialog. */
function targetLabel(t: TFunction, row: UnlinkedSubscriptionRow): string {
  return t('subscriptionTools.linkDialog.subscriptionOption', {
    plan: row.planName ?? t('subscriptionTools.common.planMissing'),
    status: String(t(`subscriptionsPage.statuses.${row.status}`, { defaultValue: row.status })),
    created: formatDate(row.createdAt),
    id: row.subscriptionId,
  })
}

export function UnlinkedSubscriptionsTab({
  onOpenMerge,
}: {
  /** Switches the sheet to «Слияние подписок-дубликатов». */
  readonly onOpenMerge: () => void
}): JSX.Element | null {
  const { t } = useTranslation()
  const allowed = useHasPermission('subscriptions', 'edit')

  const query = useQuery({
    queryKey: subscriptionToolsQueryKeys.unlinked,
    queryFn: fetchUnlinkedSubscriptions,
    enabled: allowed,
    retry: false,
  })

  if (!allowed) return null

  const report = query.data

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <div className="max-w-3xl space-y-1">
          <p className="flex items-center gap-2 text-sm font-semibold">
            <Unlink className="h-4 w-4" aria-hidden="true" />
            {t('subscriptionTools.tabs.unlinked')}
          </p>
          <p className="text-xs text-muted-foreground">{t('subscriptionTools.unlinked.intro')}</p>
        </div>

        {query.isError ? (
          <ToolLoadFailure
            error={query.error}
            retrying={query.isFetching}
            onRetry={() => void query.refetch()}
          />
        ) : report === undefined ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, index) => (
              <Skeleton key={index} className="h-10 w-full" />
            ))}
          </div>
        ) : (
          <>
            <PanelLinkCheckStatusLine check={report.check} />

            {report.rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('subscriptionTools.unlinked.empty')}</p>
            ) : (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  {t('subscriptionTools.unlinked.count', {
                    total: report.total ?? report.rows.length,
                  })}
                  {report.truncated
                    ? ` ${t('subscriptionTools.common.truncated', {
                        shown: report.rows.length,
                        total: report.total ?? report.rows.length,
                      })}`
                    : ''}
                </p>
                <UnlinkedTable rows={report.rows} onOpenMerge={onOpenMerge} />
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}

function UnlinkedTable({
  rows,
  onOpenMerge,
}: {
  readonly rows: readonly UnlinkedSubscriptionRow[]
  readonly onOpenMerge: () => void
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('subscriptionTools.unlinked.table.customer')}</TableHead>
            <TableHead>{t('subscriptionTools.unlinked.table.subscription')}</TableHead>
            <TableHead>{t('subscriptionTools.unlinked.table.holds')}</TableHead>
            <TableHead>{t('subscriptionTools.unlinked.table.reason')}</TableHead>
            <TableHead>{t('subscriptionTools.unlinked.table.checkedAt')}</TableHead>
            <TableHead>
              <span className="sr-only">{t('subscriptionTools.common.actionColumn')}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.subscriptionId}>
              <TableCell className="align-top">
                <CustomerCell
                  userId={row.userId}
                  userName={row.userName}
                  userTelegramId={row.userTelegramId}
                />
              </TableCell>
              <TableCell className="align-top text-xs">
                <p className="text-sm">{row.planName ?? t('subscriptionTools.common.planMissing')}</p>
                <p className="text-muted-foreground">
                  <SubscriptionStatusText status={row.status} />
                </p>
                <p className="font-mono text-muted-foreground">{row.subscriptionId}</p>
              </TableCell>
              <TableCell className="max-w-[12rem] align-top text-xs">
                {row.storedRemnawaveId === null ? (
                  <Badge variant="outline">{t('subscriptionTools.unlinked.holdsEmpty')}</Badge>
                ) : (
                  <span className="break-all font-mono" title={row.storedRemnawaveId}>
                    {row.storedRemnawaveId}
                  </span>
                )}
              </TableCell>
              <TableCell className="max-w-md align-top text-xs">
                <p>{reasonSentence(t, row)}</p>
                {row.reason === 'duplicatePair' ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-1.5 h-7 gap-1.5 text-xs"
                    onClick={onOpenMerge}
                  >
                    <GitMerge className="h-3.5 w-3.5" aria-hidden="true" />
                    {t('subscriptionTools.unlinked.openMerge')}
                  </Button>
                ) : null}
              </TableCell>
              <TableCell className="whitespace-nowrap align-top text-xs text-muted-foreground">
                {row.checkedAt === null
                  ? t('subscriptionTools.unlinked.notCheckedYet')
                  : formatDateTime(row.checkedAt)}
              </TableCell>
              <TableCell className="align-top">
                <LinkProfileDialog
                  targets={[{ subscriptionId: row.subscriptionId, label: targetLabel(t, row) }]}
                  initialProfileId={row.profileId}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
