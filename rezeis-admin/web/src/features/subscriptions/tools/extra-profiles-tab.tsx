/**
 * «Лишние профили в Remnawave» — profiles a customer owns that none of their
 * subscriptions uses.
 * ──────────────────────────────────────────────────────────────────────────
 * The automatic check compares Remnawave with the database customer by
 * customer: a profile is EXTRA when its `reiwa_id` line names a customer and
 * none of that customer's live subscriptions links it. That is usually the
 * other half of «Подписки без привязки»: the customer's profile exists, their
 * subscription lost the link. Where exactly one pairing is provable the check
 * links it by itself; every other case is listed here with what it did and
 * why, and «Привязать профиль» for the operator to decide.
 *
 * NOTHING IS DELETED FROM HERE, and there is no button that would. A profile
 * that looks spare may be the one a customer's devices are connected through;
 * the comparison cannot know, and neither can this screen.
 *
 * AN EMPTY LIST IS ONLY AN ALL-CLEAR AFTER A COMPLETE READ. "No extra
 * profiles" from a comparison that never ran, or from a Remnawave that handed
 * over part of its list, is not good news, and the header says which it is.
 */
import type { JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import type { TFunction } from 'i18next'
import { UserSearch } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useHasPermission } from '@/features/rbac'
import { formatBytes, formatDate, formatDateTime } from '@/lib/utils'
import { LinkProfileDialog, type LinkTarget } from './link-profile-dialog'
import {
  fetchExtraProfiles,
  isAutoLinkOutcome,
  type ExtraProfile,
  type ExtraProfileCustomer,
  type ExtraProfilesReport,
  type ExtraProfileUnknownOwner,
  type SubscriptionWithoutLink,
} from './panel-link-check-api'
import { subscriptionToolsQueryKeys } from './query-keys'
import { CustomerCell, PanelLinkCheckStatusLine, ToolLoadFailure } from './tool-parts'

const PROFILE_STATUSES = ['ACTIVE', 'DISABLED', 'LIMITED', 'EXPIRED'] as const

/** What the automatic link did with this profile, as one sentence. */
function autoLinkSentence(t: TFunction, profile: ExtraProfile): string {
  const missing = t('subscriptionTools.common.fieldMissing')
  if (!isAutoLinkOutcome(profile.autoLink)) {
    return t('subscriptionTools.extraProfiles.autoLink.unknown', {
      code: profile.autoLink.length > 0 ? profile.autoLink : missing,
    })
  }
  return t(`subscriptionTools.extraProfiles.autoLink.${profile.autoLink}`, {
    // The subscription the sentence names: the one the check linked it to, or
    // the deleted one that still holds it.
    subscriptionId:
      (profile.autoLink === 'namedByDeletedSubscription'
        ? profile.linkedBySubscriptionId
        : profile.autoLinkedSubscriptionId) ?? missing,
    when: formatDateTime(profile.autoLinkedAt),
  })
}

function subscriptionLabel(t: TFunction, subscription: SubscriptionWithoutLink): string {
  return t('subscriptionTools.linkDialog.subscriptionOption', {
    plan: subscription.planName ?? t('subscriptionTools.common.planMissing'),
    status: String(t(`subscriptionsPage.statuses.${subscription.status}`, { defaultValue: subscription.status })),
    created: formatDate(subscription.createdAt),
    id: subscription.subscriptionId,
  })
}

function countOrUnknown(t: TFunction, value: number | null): string {
  return value === null ? t('subscriptionTools.extraProfiles.countUnknown') : String(value)
}

export function ExtraProfilesTab(): JSX.Element | null {
  const { t } = useTranslation()
  const allowed = useHasPermission('subscriptions', 'edit')

  const query = useQuery({
    queryKey: subscriptionToolsQueryKeys.extraProfiles,
    queryFn: fetchExtraProfiles,
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
            <UserSearch className="h-4 w-4" aria-hidden="true" />
            {t('subscriptionTools.tabs.extraProfiles')}
          </p>
          <p className="text-xs text-muted-foreground">{t('subscriptionTools.extraProfiles.intro')}</p>
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
            <ComparisonSummary report={report} />

            {report.customers.length === 0 && report.unknownOwners.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {report.comparedAt === null
                  ? t('subscriptionTools.extraProfiles.emptyNeverCompared')
                  : t('subscriptionTools.extraProfiles.empty')}
              </p>
            ) : (
              <div className="space-y-4">
                {report.truncated ? (
                  <p className="text-xs text-muted-foreground">
                    {t('subscriptionTools.extraProfiles.truncated', { shown: report.customers.length })}
                  </p>
                ) : null}
                {report.customers.map((customer) => (
                  <CustomerBlock key={customer.userId} customer={customer} />
                ))}
                {report.unknownOwners.length > 0 ? <UnknownOwners report={report} /> : null}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}

/** When the comparison read Remnawave, whether it got everything, and the counts. */
function ComparisonSummary({ report }: { readonly report: ExtraProfilesReport }): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="space-y-1 rounded-lg border p-3 text-xs">
      <p className="font-medium">
        {report.comparedAt === null
          ? t('subscriptionTools.extraProfiles.neverCompared')
          : t('subscriptionTools.extraProfiles.comparedAt', { when: formatDateTime(report.comparedAt) })}
      </p>
      {report.readOutcome === 'partial' ? (
        <p className="font-medium text-destructive">{t('subscriptionTools.extraProfiles.readPartial')}</p>
      ) : report.readOutcome === 'complete' ? (
        <p>{t('subscriptionTools.extraProfiles.readComplete')}</p>
      ) : null}
      {report.comparedAt === null ? null : (
        <p className="text-muted-foreground">
          {t('subscriptionTools.extraProfiles.counts', {
            read: countOrUnknown(t, report.profilesRead),
            withoutOwner: countOrUnknown(t, report.profilesWithoutOwner),
            autoLinked: countOrUnknown(t, report.autoLinked),
          })}
        </p>
      )}
    </div>
  )
}

/**
 * The owners the panel does not have (review R3b-03), APART from the customers
 * and after them: a customer deleted here whose profile outlived the deletion,
 * or another panel's customer on the same Remnawave. Nothing to link, so no
 * «Привязать профиль» and no subscriptions to list — only the profiles, and,
 * when the audit has it, the day the customer was deleted here.
 */
function UnknownOwners({ report }: { readonly report: ExtraProfilesReport }): JSX.Element {
  const { t } = useTranslation()
  const shown = report.unknownOwners.length
  const total = report.unknownOwnersTotal ?? shown
  return (
    <div className="space-y-2">
      <div className="max-w-3xl space-y-1">
        <p className="text-sm font-semibold">{t('subscriptionTools.extraProfiles.unknownOwners.title')}</p>
        <p className="text-xs text-muted-foreground">{t('subscriptionTools.extraProfiles.unknownOwners.intro')}</p>
        {total > shown ? (
          <p className="text-xs text-muted-foreground">
            {t('subscriptionTools.extraProfiles.unknownOwners.shown', { shown, total })}
          </p>
        ) : null}
      </div>
      {report.unknownOwners.map((owner) => (
        <CustomerBlock key={owner.userId} customer={asMissingCustomer(owner)} apart={{ deletedAt: owner.deletedAt }} />
      ))}
    </div>
  )
}

/** An owner the panel does not have, in the shape a customer block draws. */
function asMissingCustomer(owner: ExtraProfileUnknownOwner): ExtraProfileCustomer {
  return {
    userId: owner.userId,
    userExists: false,
    userName: null,
    userTelegramId: null,
    profiles: owner.profiles,
    subscriptionsWithoutLink: [],
  }
}

/**
 * One customer: who they are, their extra profiles, and their unlinked
 * subscriptions. `apart` marks an owner the panel does not have at all (see
 * {@link UnknownOwners}).
 */
function CustomerBlock({
  customer,
  apart,
}: {
  readonly customer: ExtraProfileCustomer
  readonly apart?: { readonly deletedAt: string | null }
}): JSX.Element {
  const { t } = useTranslation()
  const targets: LinkTarget[] = customer.subscriptionsWithoutLink.map((subscription) => ({
    subscriptionId: subscription.subscriptionId,
    label: subscriptionLabel(t, subscription),
  }))
  return (
    <section className="space-y-2 rounded-lg border p-3">
      {customer.userExists ? (
        <CustomerCell
          userId={customer.userId}
          userName={customer.userName}
          userTelegramId={customer.userTelegramId}
        />
      ) : (
        <div className="space-y-0.5">
          <p className="text-sm font-medium text-destructive">
            {t('subscriptionTools.extraProfiles.customerMissing')}
          </p>
          {apart !== undefined && apart.deletedAt !== null ? (
            <p className="text-xs text-muted-foreground">
              {t('subscriptionTools.extraProfiles.unknownOwners.deletedAt', { when: formatDateTime(apart.deletedAt) })}
            </p>
          ) : null}
          <p className="font-mono text-xs text-muted-foreground">{customer.userId}</p>
        </div>
      )}

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('subscriptionTools.extraProfiles.table.profile')}</TableHead>
              <TableHead>{t('subscriptionTools.extraProfiles.table.status')}</TableHead>
              <TableHead>{t('subscriptionTools.extraProfiles.table.created')}</TableHead>
              <TableHead>{t('subscriptionTools.extraProfiles.table.traffic')}</TableHead>
              <TableHead>{t('subscriptionTools.extraProfiles.table.marker')}</TableHead>
              <TableHead>{t('subscriptionTools.extraProfiles.table.autoLink')}</TableHead>
              <TableHead>
                <span className="sr-only">{t('subscriptionTools.common.actionColumn')}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {customer.profiles.map((profile) => (
              <TableRow key={profile.profileId}>
                <TableCell className="align-top text-xs">
                  <p className="font-mono text-sm">{profile.username || t('subscriptionTools.common.fieldMissing')}</p>
                  <p className="font-mono text-muted-foreground">
                    {t('subscriptionTools.extraProfiles.profileId', { id: profile.profileId })}
                  </p>
                  {profile.linkedNow ? (
                    <Badge variant="success" className="mt-1">
                      {t('subscriptionTools.extraProfiles.linkedNow')}
                    </Badge>
                  ) : null}
                  {profile.linkedBySubscriptionId === null ? null : (
                    // Two different holders, never described alike: a live
                    // subscription of another customer, or a DELETED one that
                    // still names the profile (possibly this customer's own).
                    <p className="mt-1 text-destructive">
                      {profile.autoLink === 'namedByDeletedSubscription'
                        ? t('subscriptionTools.extraProfiles.namedByDeleted', { id: profile.linkedBySubscriptionId })
                        : t('subscriptionTools.extraProfiles.linkedByOther', { id: profile.linkedBySubscriptionId })}
                    </p>
                  )}
                </TableCell>
                <TableCell className="align-top text-xs">
                  {profile.status === null
                    ? t('subscriptionTools.common.fieldMissing')
                    : (PROFILE_STATUSES as readonly string[]).includes(profile.status)
                      ? t(`subscriptionTools.extraProfiles.profileStatus.${profile.status}`)
                      : profile.status}
                </TableCell>
                <TableCell className="whitespace-nowrap align-top text-xs">
                  {formatDateTime(profile.createdAt)}
                </TableCell>
                <TableCell className="whitespace-nowrap align-top text-xs">
                  {formatBytes(profile.usedTrafficBytes)}
                </TableCell>
                <TableCell className="align-top font-mono text-xs">
                  {profile.subscriptionMarker ?? t('subscriptionTools.extraProfiles.markerNone')}
                </TableCell>
                <TableCell className="max-w-sm align-top text-xs">{autoLinkSentence(t, profile)}</TableCell>
                <TableCell className="align-top">
                  <ProfileAction customer={customer} profile={profile} targets={targets} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {apart !== undefined ? null : (
        <div className="space-y-1 text-xs">
          <p className="font-medium">{t('subscriptionTools.extraProfiles.withoutLinkTitle')}</p>
          {customer.subscriptionsWithoutLink.length === 0 ? (
            <p className="text-muted-foreground">{t('subscriptionTools.extraProfiles.withoutLinkNone')}</p>
          ) : (
            <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
              {customer.subscriptionsWithoutLink.map((subscription) => (
                <li key={subscription.subscriptionId}>
                  {t('subscriptionTools.extraProfiles.withoutLinkItem', {
                    plan: subscription.planName ?? t('subscriptionTools.common.planMissing'),
                    status: String(
                      t(`subscriptionsPage.statuses.${subscription.status}`, {
                        defaultValue: subscription.status,
                      }),
                    ),
                    created: formatDate(subscription.createdAt),
                    holds:
                      subscription.storedRemnawaveId === null
                        ? t('subscriptionTools.unlinked.holdsEmpty')
                        : subscription.storedRemnawaveId,
                    id: subscription.subscriptionId,
                  })}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}

/**
 * «Привязать профиль», offered only where a link can land: a customer the
 * panel knows, a profile nobody links now, and at least one of the customer's
 * subscriptions without a link to give it to. Where none of that holds, the
 * cell says why instead of offering a button the server would refuse.
 */
function ProfileAction({
  customer,
  profile,
  targets,
}: {
  readonly customer: ExtraProfileCustomer
  readonly profile: ExtraProfile
  readonly targets: readonly LinkTarget[]
}): JSX.Element | null {
  const { t } = useTranslation()
  if (!customer.userExists || profile.linkedNow || profile.linkedBySubscriptionId !== null) return null
  if (targets.length === 0) {
    return (
      <span className="text-xs text-muted-foreground">
        {t('subscriptionTools.extraProfiles.noLinkTarget')}
      </span>
    )
  }
  return <LinkProfileDialog targets={targets} initialProfileId={profile.profileId} />
}
