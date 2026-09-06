/**
 * What the operator reads after pressing «Отправить тест».
 *
 * Its own module rather than a helper inside the page: it is a pure function
 * with a test of its own, and a component file that also exports functions
 * loses fast refresh for everything in it.
 */

import { toast } from 'sonner'

/** What `POST .../telegram/test` answers. Mirrors the panel API's own type. */
export interface TelegramTestResult {
  readonly delivered: boolean
  readonly via: 'primary' | 'dev' | 'legacy'
  readonly outcome: 'sent' | 'queued' | 'relayed' | 'failed'
  readonly reason: string | null
}

/** Refusals this screen has words of its own for. */
const KNOWN_REASONS: Readonly<Record<string, string>> = {
  TELEGRAM_TEST_EVENT_NOT_SELECTED: 'notificationsPage.toasts.testNotSelected',
  TELEGRAM_TRANSPORT_UNAVAILABLE: 'notificationsPage.toasts.testNoTransport',
}

/**
 * Turn one probe result into the sentence the operator needs.
 *
 * The handler used to toast success on any 200, and the endpoint answered 200
 * for a revoked token, a bot kicked from the group and a wrong topic id
 * alike. This button is the ONLY verification surface for the whole operator
 * alerting pipeline, which is what makes a lying one worse than none:
 * whoever presses it and reads "отправлено" stops looking.
 *
 * Three outcomes, three different next steps, and folding them into one
 * success is exactly what made the control useless:
 *   - delivered → the channel works;
 *   - queued / relayed → handed on; nothing is known YET (split deployment);
 *   - failed → Telegram's own words, which name the thing to fix.
 */
export function reportTelegramTest(
  result: TelegramTestResult,
  t: (key: string, opts?: Record<string, unknown>) => string,
): void {
  if (result.delivered) {
    toast.success(t('notificationsPage.toasts.testSent'))
    return
  }
  if (result.outcome === 'queued' || result.outcome === 'relayed') {
    toast.info(t('notificationsPage.toasts.testHandedOn'))
    return
  }
  const known = result.reason === null ? undefined : KNOWN_REASONS[result.reason]
  toast.error(
    known !== undefined
      ? t(known)
      : t('notificationsPage.toasts.testRefused', {
          reason: result.reason ?? t('notificationsPage.toasts.testNoReason'),
        }),
  )
}
