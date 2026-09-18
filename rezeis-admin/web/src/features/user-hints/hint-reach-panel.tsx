import { useId, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { TFunction } from 'i18next'
import { AlertTriangle, CircleHelp, Info, Users } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Badge } from '@/components/ui/badge'
import { InfoTip } from '@/components/ui/info-tip'
import { listRules } from '@/features/automations/automations-api'
import { popupEventName } from '@/features/automations/popup-audience'
import { cn } from '@/lib/utils'

import { hintReach, type ReachNotice, type ReachWhom } from './hint-reach'
import { quotedList, surfaceNames } from './surface-names'

/**
 * «Кто увидит» — the block in the hint editor that answers WHOM, next to the
 * «Где показывать» block that only ever answered WHERE.
 *
 * Live status and warnings are visible text: they are computed from the rules
 * and the draft and change while the operator edits. The explanation of the
 * difference between the two blocks is behind the (i), per the panel's rule
 * that operator prose lives there.
 */
export function HintReachPanel({
  draftKey,
  savedKey,
  otherKeys,
  surfaces,
  isActive,
  ttlHours,
}: {
  readonly draftKey: string
  /** The key as saved, or `null` for a hint not saved yet. */
  readonly savedKey: string | null
  /** The keys of every OTHER hint in the library. */
  readonly otherKeys: readonly string[]
  readonly surfaces: readonly string[]
  readonly isActive: boolean
  readonly ttlHours: number
}) {
  const { t } = useTranslation()
  const headingId = useId()
  // The key the rules tab and the map use, so the three share one cache and an
  // edit to a rule is reflected here without a request of this block's own.
  const rulesQuery = useQuery({ queryKey: ['admin', 'automations', 'rules'], queryFn: listRules })
  const rules =
    rulesQuery.data !== undefined ? rulesQuery.data : rulesQuery.isError ? 'unreadable' : 'loading'

  const reach = hintReach({ key: draftKey, savedKey, otherKeys, surfaces, isActive, rules })

  return (
    <section aria-labelledby={headingId} className="space-y-2 rounded-lg border p-3">
      <div className="flex items-center gap-1.5">
        <Users className="h-4 w-4 text-muted-foreground" aria-hidden />
        <h3 id={headingId} className="text-sm font-medium leading-none">
          {t('userHints.reach.title')}
        </h3>
        <InfoTip label={t('automationsPage.infoAria', { subject: t('userHints.reach.title') })}>
          {t('userHints.reach.info')}
        </InfoTip>
      </div>

      {rules === 'loading' && (
        <p className="text-xs text-muted-foreground">{t('userHints.reach.loading')}</p>
      )}

      {reach.lines.length > 0 && (
        <ul className="space-y-1">
          {reach.lines.map(({ use, whom, status }) => (
            <li
              key={`${use.ruleId}:${use.action}`}
              data-status={status === 'working' ? undefined : status}
              className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm"
            >
              <span className="font-medium">{use.ruleName}</span>
              <Badge
                variant="outline"
                className={cn(
                  'font-normal',
                  use.isEnabled && status === 'working'
                    ? 'border-emerald-500/40 text-emerald-700 dark:text-emerald-300'
                    : 'text-muted-foreground',
                )}
              >
                {use.isEnabled ? t('userHints.reach.enabled') : t('userHints.reach.disabled')}
              </Badge>
              {status === 'unverified' && (
                // Uncertain, not failing: amber like the surface-gap marker, and
                // worded as "not checked", never as "will not show".
                <Badge
                  variant="outline"
                  className="border-amber-500/50 bg-amber-500/10 font-normal text-amber-700 dark:text-amber-300"
                >
                  <CircleHelp className="mr-1 h-3 w-3" aria-hidden />
                  {t('userHints.reach.notChecked')}
                </Badge>
              )}
              <span
                className={
                  status === 'failing' ? 'text-amber-800 dark:text-amber-200' : 'text-muted-foreground'
                }
              >
                {status === 'failing' && (
                  <AlertTriangle className="mr-1 inline h-3.5 w-3.5 align-[-2px]" aria-hidden />
                )}
                {whomText(t, whom)}
              </span>
            </li>
          ))}
        </ul>
      )}

      {reach.notices.map((notice) => {
        const warning = WARNINGS.has(notice.kind)
        const Icon = warning ? AlertTriangle : Info
        return (
          <div
            key={notice.kind === 'surface-gap' ? `surface-gap:${notice.ruleId}` : notice.kind}
            data-notice={notice.kind}
            className={cn(
              'flex gap-2 rounded-md border px-2.5 py-2 text-xs leading-snug',
              warning
                ? 'border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200'
                : 'bg-muted/40 text-muted-foreground',
            )}
          >
            <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <p>{noticeText(t, notice, ttlHours)}</p>
          </div>
        )
      })}
    </section>
  )
}

/** Notices that mean customers may not get the hint. The rest are information. */
const WARNINGS: ReadonlySet<ReachNotice['kind']> = new Set([
  'key-taken',
  'no-rule',
  'no-working-rule',
  'only-unverified',
  'surface-gap',
  'inactive',
  'renamed',
  'renamed-client-moment',
])

function audienceName(t: TFunction, audience: string): string {
  return String(t(`automationsPage.audiences.${audience}`, { defaultValue: audience }))
}

function whomText(t: TFunction, whom: ReachWhom): ReactNode {
  switch (whom.kind) {
    case 'event': {
      // The raw type when the panel has no words for it, never the key path.
      const name = popupEventName(t, whom.event)
      return name ?? <code className="text-xs">{whom.event}</code>
    }
    case 'wildcard':
      return t('userHints.reach.whomWildcard', { pattern: whom.pattern })
    case 'manual':
      return t('userHints.reach.whomManual')
    case 'audience':
      return t(
        whom.when === 'manual'
          ? 'userHints.reach.whomAudienceManual'
          : 'userHints.reach.whomAudienceSchedule',
        { audience: audienceName(t, whom.audience) },
      )
    case 'unverified':
      return t('userHints.reach.whomUnverified', { event: whom.event })
    case 'schedule-names-nobody':
      return t('userHints.reach.whomScheduleNamesNobody')
    case 'audience-on-event':
      return t('userHints.reach.whomAudienceOnEvent')
    case 'audience-invalid':
      return t('userHints.reach.whomAudienceInvalid')
  }
}

function noticeText(t: TFunction, notice: ReachNotice, ttlHours: number): string {
  switch (notice.kind) {
    case 'key-taken':
      return String(t('userHints.reach.keyTaken', { key: notice.key }))
    case 'no-working-rule':
      return String(t('userHints.reach.noWorkingRule'))
    case 'only-unverified':
      return String(t('userHints.reach.onlyUnverified'))
    case 'rules-unreadable':
      return String(t('userHints.reach.unreadable'))
    case 'blank-key':
      return String(t('userHints.reach.blankKey'))
    case 'client-moment':
      return String(t('userHints.reach.clientMoment'))
    case 'renamed-client-moment':
      return String(t('userHints.reach.renamedClientMoment', { key: notice.savedKey }))
    case 'renamed':
      return String(
        t('userHints.reach.renamed', {
          key: notice.savedKey,
          rules: quotedList(t, notice.ruleNames),
        }),
      )
    case 'no-rule':
      return String(t('userHints.reach.noRule'))
    case 'inactive':
      return String(t('userHints.reach.inactive'))
    case 'surface-gap': {
      const main = t('userHints.reach.gap', {
        rule: notice.ruleName,
        event: popupEventName(t, notice.event) ?? notice.event,
        home: surfaceNames(t, notice.home),
        ticked: surfaceNames(t, notice.ticked),
      })
      // The lifetime the draft carries. A cleared or out-of-range field would
      // put "0 hours" in the sentence, so that case says it without a number.
      const lapse =
        Number.isInteger(ttlHours) && ttlHours >= 1
          ? t('userHints.reach.gapLapse', {
              hours: t('userHints.reach.hours', { count: ttlHours }),
            })
          : t('userHints.reach.gapLapseUnknown')
      return `${String(main)} ${String(lapse)}`
    }
  }
}
