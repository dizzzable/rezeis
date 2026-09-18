import { useTranslation } from 'react-i18next'
import { AlertTriangle, CircleCheck, CircleSlash } from 'lucide-react'

import { matchesKnownEvent, type CatalogEvent } from './event-catalog-api'
import { popupEventName } from './popup-audience'

/**
 * trigger-catalog-hint
 * ────────────────────
 * What the trigger an operator has just typed will actually do.
 *
 * ── The failure this is for ──────────────────────────────────────────────────
 *
 * The trigger field is free text against a panel that declares 115 event types
 * and emits fewer. A rule bound to one nothing emits is never selected by the
 * pattern filter, so it produces no execution row, no error and no log line —
 * it reads "enabled" in the list for ever, and the only way to find out is that
 * the thing it was written for never happens. Four shipped pop-up templates
 * were in that state.
 *
 * ── Why it counts rather than asserts ────────────────────────────────────────
 *
 * "This event is never emitted" is not a claim this panel can make. The source
 * cannot be scanned for it reliably — an event emitted through a variable or an
 * aliased constant is invisible to any regex — and a warning that calls a live
 * event dead is worse than none, because the operator then avoids a trigger
 * that works.
 *
 * So it reports the operator's own history instead: how many times this fired
 * HERE in the last ninety days. Zero is not a verdict, it is a fact, and it is
 * the fact somebody about to save a rule needs.
 */
export function TriggerCatalogHint({
  spec,
  events,
  windowDays,
}: {
  readonly spec: string
  readonly events: readonly CatalogEvent[]
  readonly windowDays: number
}) {
  const { t } = useTranslation()
  const trimmed = spec.trim()
  if (trimmed.length === 0 || events.length === 0) return null

  const matched = events.filter((event) => matchesKnownEvent(trimmed, event.type))

  // Nothing in the catalogue answers to it. Not necessarily wrong — a custom
  // type raised through the internal events endpoint is legitimate — so this
  // says what it knows rather than refusing.
  if (matched.length === 0) {
    return (
      <p className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        {t('automationsPage.config.triggerUnknown')}
      </p>
    )
  }

  const fired = matched.filter((event) => event.seen > 0)
  const popup = matched.filter((event) => event.popupCapable)

  // WHAT THE EVENT IS, in the operator's words — for one exact event a hint can
  // ride. The field holds a code string, and the code string is how the owner
  // bound a welcome for the browser to the Telegram sign-up: `user.registered`
  // reads like "somebody registered", which is not what it means here. A
  // wildcard names no one event, so it gets no name.
  const exact = matched.length === 1 && matched[0]?.type === trimmed ? matched[0] : undefined
  const operatorName = exact?.popupCapable ? popupEventName(t, exact.type) : null
  const nameLine =
    operatorName === null ? null : (
      <p className="text-xs font-medium text-foreground">{operatorName}</p>
    )

  // THE ROW THAT MATTERS. Everything it matches exists in the catalogue and
  // none of it has happened here — which is what a rule that will never fire
  // looks like from the outside, before it is saved rather than months after.
  // Both numbers below are counts, and both sit in front of a noun that has to
  // agree with them. i18next pluralises on ONE variable per key — `count` —
  // so each is rendered by its own key and interpolated as finished text.
  // Without this the panel said "in the last 1 days", and the operator can set
  // that window to 1: it is `AUDIT_RETENTION_DAYS`.
  const windowText = t('automationsPage.config.triggerWindowDays', { count: windowDays })

  // THE CAPABILITY, WHEREVER IT IS TRUE. That a hint can ride this event is a
  // property of the event, not of whether it has happened here yet — and it was
  // printed only beside a count above zero. The operator binding a rule to an
  // event that has never fired is exactly the one asking whether a pop-up is
  // possible on it at all, and got no answer.
  const popupLine =
    popup.length === 0 ? null : (
      <p className="text-xs text-muted-foreground">{t('automationsPage.config.triggerPopupCapable')}</p>
    )

  if (fired.length === 0) {
    return (
      <>
        {nameLine}
        <p className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
          <CircleSlash className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {/* COUNT, not the pre-rendered window: Russian agrees the ADJECTIVE
              with the number too («за последний 1 день» / «за последние 90
              дней»), and a window pasted in as finished text leaves the sentence
              around it fixed. The one string in this file that needs it. */}
          {t('automationsPage.config.triggerNeverFired', { count: windowDays })}
        </p>
        {popupLine}
      </>
    )
  }

  const total = fired.reduce((sum, event) => sum + event.seen, 0)
  return (
    <>
      {nameLine}
      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <CircleCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
        <span>
          {t('automationsPage.config.triggerFired', {
            count: total,
            window: windowText,
            matched: t('automationsPage.config.triggerMatchedTypes', { count: matched.length }),
          })}
          {popup.length > 0 && ` · ${t('automationsPage.config.triggerPopupCapable')}`}
        </span>
      </p>
    </>
  )
}
