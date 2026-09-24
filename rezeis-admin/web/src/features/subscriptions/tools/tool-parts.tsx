/**
 * Pieces the tabs of «Подписки» → «Инструменты» share: the automatic check's
 * status, a customer cell, a subscription's status, and the "did not load"
 * notice.
 */
import type { JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { Loader2, RefreshCw } from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatDateTime } from '@/lib/utils'
import { describeFailure } from './describe-failure'
import {
  PANEL_LINK_CHECK_OUTCOMES,
  PANEL_LINK_CHECK_TRIGGERS,
  type PanelLinkCheckStatus,
} from './panel-link-check-api'

function isKnown<T extends string>(known: readonly T[], value: string | null): value is T {
  return value !== null && (known as readonly string[]).includes(value)
}

/**
 * When the automatic check last ran, how it went, and when it runs next.
 *
 * This replaces a button. «Починка привязки к панели» was pressed by hand; the
 * check now runs by itself, and an operator looking at a row it could not
 * prove needs to know whether it has even looked yet and when it will look
 * again — otherwise "not linked" reads as "given up on".
 */
export function PanelLinkCheckStatusLine({
  check,
}: {
  readonly check: PanelLinkCheckStatus
}): JSX.Element {
  const { t } = useTranslation()
  const trigger = isKnown(PANEL_LINK_CHECK_TRIGGERS, check.lastRunTrigger)
    ? t(`subscriptionTools.check.triggers.${check.lastRunTrigger}`)
    : t('subscriptionTools.check.triggers.unknown')
  const outcome = isKnown(PANEL_LINK_CHECK_OUTCOMES, check.lastRunOutcome)
    ? t(`subscriptionTools.check.outcomes.${check.lastRunOutcome}`)
    : t('subscriptionTools.check.outcomes.unknown')
  return (
    <div className="space-y-1 rounded-lg border p-3 text-xs">
      <p className="flex flex-wrap items-center gap-2 font-medium">
        <span>
          {check.lastRunAt === null
            ? t('subscriptionTools.check.neverRan')
            : t('subscriptionTools.check.lastRun', {
                when: formatDateTime(check.lastRunAt),
                trigger,
              })}
        </span>
        {check.running ? <Badge variant="info">{t('subscriptionTools.check.running')}</Badge> : null}
      </p>
      {check.lastRunAt === null ? null : <p>{outcome}</p>}
      <p className="text-muted-foreground">
        {check.nextRunAt === null
          ? t('subscriptionTools.check.nextRunUnknown')
          : t('subscriptionTools.check.nextRun', { when: formatDateTime(check.nextRunAt) })}
      </p>
      <p className="text-muted-foreground">{t('subscriptionTools.check.howItRuns')}</p>
    </div>
  )
}

/**
 * A customer: their name as a link to their card, and their Telegram id.
 *
 * The card is addressed by the reiwa user id, which every customer has — a
 * web-only customer has no Telegram id to address it by.
 */
export function CustomerCell({
  userId,
  userName,
  userTelegramId,
}: {
  readonly userId: string
  readonly userName: string | null
  readonly userTelegramId: string | null
}): JSX.Element {
  const { t } = useTranslation()
  const name = userName ?? t('subscriptionTools.common.customerUnnamed')
  return (
    <div className="space-y-0.5">
      {userId.length > 0 ? (
        <Link
          to={`/users/${encodeURIComponent(userId)}`}
          className="text-sm font-medium underline-offset-2 hover:underline"
          title={t('subscriptionTools.common.openCustomer')}
        >
          {name}
        </Link>
      ) : (
        <p className="text-sm font-medium">{name}</p>
      )}
      <p className="font-mono text-xs text-muted-foreground">
        {userTelegramId ?? t('subscriptionTools.common.noTelegram')}
      </p>
    </div>
  )
}

/** A subscription's status in the words the rest of the page uses. */
export function SubscriptionStatusText({ status }: { readonly status: string }): JSX.Element {
  const { t } = useTranslation()
  if (status.length === 0) return <>{t('subscriptionTools.common.fieldMissing')}</>
  return <>{String(t(`subscriptionsPage.statuses.${status}`, { defaultValue: status }))}</>
}

/**
 * A list that did not load is said to have not loaded.
 *
 * Never an empty table: on every tab of this sheet an empty list is the
 * all-clear ("nothing unlinked", "no extra profiles"), and a failed read must
 * not be able to say that.
 */
export function ToolLoadFailure({
  error,
  retrying,
  onRetry,
}: {
  readonly error: unknown
  readonly retrying: boolean
  readonly onRetry: () => void
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <Alert variant="destructive">
      <AlertTitle>{t('subscriptionTools.common.loadFailedTitle')}</AlertTitle>
      <AlertDescription className="space-y-2">
        <p>{describeFailure(t, error)}</p>
        <p>{t('subscriptionTools.common.loadFailedBody')}</p>
        <Button size="sm" variant="outline" className="h-8 gap-1.5" disabled={retrying} onClick={onRetry}>
          {retrying ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          {t('common.retry')}
        </Button>
      </AlertDescription>
    </Alert>
  )
}
