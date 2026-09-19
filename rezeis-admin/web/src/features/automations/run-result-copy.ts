import type { TFunction } from 'i18next'

import type { AutomationActionResult, ManualRunResult } from './automations-api'
import { actionLabel } from './rule-action-labels'

/**
 * run-result-copy
 * ───────────────
 * What a run did, in the operator's words.
 *
 * The server keeps writing an English `message` beside every action result —
 * for its logs and for clients older than this file — and, where it has one, a
 * `code` with the values that sentence needs. The code is what is worded here;
 * the message is the fallback for a row written before codes existed, for an
 * action type that has none, and for a code this panel does not know yet.
 *
 * It was the other way round: «Запустить сейчас» toasted the raw `SUCCEEDED`,
 * and the run log printed "hint "tpl-welcome" was not queued for … (inactive,
 * already delivered, or superseded)" — three possible reasons in English for
 * one outcome, under a Russian interface.
 */

/**
 * The codes the panel words, and the details each sentence reads (contract §2).
 *
 * PINNED TO THE SERVER'S UNION by `run-result-codes-contract.test.ts`, which
 * reads `AutomationActionResultCode` out of the panel's own source. A code the
 * server started writing and this list never learnt reaches the operator twice
 * in English — once as the result's own message, once as the joined line the run
 * log stops suppressing — which is exactly what `audience_partial` did.
 */
export const RESULT_CODES = [
  'hint_queued',
  'hint_already_delivered',
  'hint_inactive',
  'hint_missing',
  'hint_key_missing',
  'customer_missing',
  'customer_not_found',
  'audience_queued',
  'audience_partial',
  'audience_empty',
  'audience_blind',
  'block_address_missing',
  'block_address_invalid',
  'block_address_protected',
  'block_address_unverified',
  'webhook_url_refused',
  'webhook_address_refused',
  'webhook_header_invalid',
  'system_event_type_refused',
] as const

export type ResultCode = (typeof RESULT_CODES)[number]

function isResultCode(code: string): code is ResultCode {
  return (RESULT_CODES as readonly string[]).includes(code)
}

type Details = NonNullable<AutomationActionResult['details']>

function text(details: Details, name: string): string {
  const value = details[name]
  return value === null || value === undefined ? '' : String(value)
}

function count(details: Details, name: string): number {
  const value = Number(details[name])
  return Number.isFinite(value) ? value : 0
}

/** The audience's operator name, or its key when the panel has none. */
function audienceName(t: TFunction, audience: string): string {
  return String(t(`automationsPage.audiences.${audience}`, { defaultValue: audience }))
}

/**
 * A word from a closed table, or the table's own `unknown` entry.
 *
 * The values come off a row the server wrote, possibly by a newer panel, so a
 * value this bundle has no word for must still land on a sentence — never on a
 * key path.
 */
function tableWord(t: TFunction, table: string, value: string, options: Record<string, unknown> = {}): string {
  const key = `automationsPage.${table}.${value}`
  const worded = value.length > 0 ? String(t(key, { ...options, defaultValue: '' })) : ''
  return worded.length > 0 ? worded : String(t(`automationsPage.${table}.unknown`, options))
}

/** An address range's kind in words — "a loopback address". */
export function rangeKindText(t: TFunction, kind: string): string {
  return tableWord(t, 'rangeKinds', kind)
}

/** What a refused block would have locked out, in words. */
export function blockProtectionText(t: TFunction, protection: string, range: string): string {
  return tableWord(t, 'blockProtections', protection, { range })
}

/**
 * The longest URL a webhook action takes — `OUTBOUND_URL_MAX_LENGTH` on the
 * panel, the same ceiling its webhook subscriptions have.
 */
export const WEBHOOK_URL_MAX_LENGTH = 2048

/** Why a webhook URL was refused, in words, from the reason the panel names. */
export function urlRefusalText(t: TFunction, reason: string, kind: string, range: string): string {
  switch (reason) {
    case 'missing':
      return String(t('automationsPage.actionProblems.urlMissing'))
    case 'too_long':
      return String(t('automationsPage.actionProblems.urlTooLong', { limit: WEBHOOK_URL_MAX_LENGTH }))
    case 'scheme':
      return String(t('automationsPage.actionProblems.urlScheme'))
    case 'malformed':
      return String(t('automationsPage.actionProblems.urlMalformed'))
    case 'local_name':
      return String(t('automationsPage.actionProblems.urlLocalName'))
    case 'metadata_name':
      return String(t('automationsPage.actionProblems.urlMetadataName'))
    case 'internal_address':
      return String(t('automationsPage.actionProblems.urlInternal', { kind: rangeKindText(t, kind), range }))
    default:
      return String(t('automationsPage.actionProblems.urlRefused'))
  }
}

/** The sentence for a result's code, or `null` when it has none the panel knows. */
export function resultCodeText(t: TFunction, result: AutomationActionResult): string | null {
  const code = result.code
  if (typeof code !== 'string' || !isResultCode(code)) return null
  const details: Details = result.details ?? {}
  const key = `automationsPage.runResults.${code}`
  switch (code) {
    case 'hint_queued':
    case 'hint_already_delivered':
    case 'hint_inactive':
    case 'hint_missing':
      return String(t(key, { hintKey: text(details, 'hintKey') }))
    case 'hint_key_missing':
    case 'customer_missing':
      return String(t(key))
    case 'customer_not_found':
      return String(t(key, { userId: text(details, 'userId') }))
    case 'audience_queued': {
      // i18next agrees a noun with ONE number per key, `count`. The customers
      // matched is the one a noun follows («из 40 клиентов»); how many were
      // queued is a bare number beside it.
      const sentence = String(
        t(key, {
          count: count(details, 'matched'),
          queued: count(details, 'queued'),
          hintKey: text(details, 'hintKey'),
          audience: audienceName(t, text(details, 'audience')),
        }),
      )
      return details.capped === true
        ? `${sentence} ${String(t('automationsPage.runResults.audienceCapped'))}`
        : sentence
    }
    case 'audience_partial': {
      // A partial run has four numbers to report and up to three notes, and
      // i18next agrees a noun with ONE number per key (`count`) — so every
      // number a noun follows gets a sentence of its own, joined here.
      //
      // The run stops for one of two reasons (contract §2) and `stoppedBy`
      // says which: three failed raises in a row, or a minute of wall clock.
      // The second one fires with nothing failed at all, so the failure
      // sentence is left out when `failed` is 0 rather than reading "0 failed".
      // A row written before `stoppedBy` existed keeps the neutral wording.
      const sentence = String(
        t(key, {
          count: count(details, 'matched'),
          queued: count(details, 'queued'),
          hintKey: text(details, 'hintKey'),
          audience: audienceName(t, text(details, 'audience')),
        }),
      )
      const failed = count(details, 'failed')
      const stoppedBy = text(details, 'stoppedBy')
      const stopKey =
        stoppedBy === 'failures'
          ? 'audienceStoppedFailures'
          : stoppedBy === 'time'
            ? 'audienceStoppedTime'
            : 'audienceStopped'
      const notes = [
        failed > 0 ? String(t('automationsPage.runResults.audienceFailed', { count: failed })) : null,
        details.stoppedEarly === true
          ? String(
              t(`automationsPage.runResults.${stopKey}`, {
                count: count(details, 'notAttempted'),
              }),
            )
          : null,
        details.capped === true ? String(t('automationsPage.runResults.audienceCapped')) : null,
      ].filter((note): note is string => note !== null)
      return [sentence, ...notes].join(' ')
    }
    case 'audience_empty':
      return String(t(key, { audience: audienceName(t, text(details, 'audience')) }))
    case 'audience_blind':
      // The audience was not worked out and nobody was hinted; `cause` says
      // why (contract: `show_hint_to_audience` in `action-registry.ts`). A
      // row without one — written before causes, or by a panel that has a cause
      // this one does not know — falls back to the server's own reason.
      switch (text(details, 'cause')) {
        case 'signal_blind':
          return String(t(`${key}_signal`))
        case 'too_large':
          return String(
            t(`${key}_too_large`, {
              audience: audienceName(t, text(details, 'audience')),
              limit: count(details, 'limit'),
            }),
          )
        case 'timeout':
          return String(t(`${key}_timeout`, { audience: audienceName(t, text(details, 'audience')) }))
        default:
          return String(t(key, { reason: text(details, 'reason') }))
      }
    case 'block_address_missing':
      return String(t(key))
    case 'block_address_invalid':
      // The rule's own address and one a run brought in are different fixes:
      // the first is edited in the action, the second in whatever sent it.
      return String(t(text(details, 'source') === 'rule' ? `${key}_rule` : key))
    case 'block_address_protected':
      return String(
        t(key, {
          address: text(details, 'address'),
          protection: blockProtectionText(t, text(details, 'protection'), text(details, 'range')),
        }),
      )
    case 'block_address_unverified':
      return String(t(key, { address: text(details, 'address') }))
    case 'webhook_url_refused':
      return String(
        t(key, {
          problem: urlRefusalText(t, text(details, 'reason'), text(details, 'kind'), text(details, 'range')),
        }),
      )
    case 'webhook_address_refused':
      return String(
        t(key, {
          host: text(details, 'host'),
          address: text(details, 'address'),
          kind: rangeKindText(t, text(details, 'kind')),
        }),
      )
    case 'webhook_header_invalid':
      return String(t(key))
    case 'system_event_type_refused':
      return String(t(key, { type: text(details, 'type') }))
  }
}

/** A result in words: its code when the panel knows it, else the server's message, else nothing. */
export function actionResultText(t: TFunction, result: AutomationActionResult): string | null {
  const worded = resultCodeText(t, result)
  if (worded !== null) return worded
  return typeof result.message === 'string' && result.message.trim().length > 0 ? result.message : null
}

/**
 * The executor's own reason for a run that reached no action, in words.
 *
 * Two literal sentences from `automation-executor.service.ts`, the ones a run
 * with no action results carries; anything else is shown as written.
 */
export function executionNoteText(t: TFunction, errorMessage: string | null): string | null {
  if (errorMessage === null || errorMessage.trim().length === 0) return null
  switch (errorMessage.trim()) {
    case 'conditions did not match':
      return String(t('automationsPage.runResults.conditionsNotMatched'))
    case 'rule disabled':
      return String(t('automationsPage.runResults.ruleDisabled'))
    case "the rule's actions are not a list, so none of them ran":
      return String(t('automationsPage.runResults.actionsNotList'))
    default:
      return errorMessage
  }
}

/**
 * The line a run log row prints above its per-action lines, or `null`.
 *
 * The executor's `errorMessage` is English: its two reasons for reaching no
 * action — worded by `executionNoteText` — or, for a FAILED run, the failed
 * actions' own messages joined into one line. When every failed action carries
 * a code the panel words, that joined line only repeats in English what the
 * lines below already say in the operator's language, so it is not printed.
 */
export function executionLogNote(
  t: TFunction,
  execution: { readonly errorMessage: string | null; readonly actionResults: readonly AutomationActionResult[] },
): string | null {
  const failed = execution.actionResults.filter((entry) => entry.status === 'failed')
  if (failed.length > 0 && failed.every((entry) => resultCodeText(t, entry) !== null)) return null
  return executionNoteText(t, execution.errorMessage)
}

/**
 * Whether a manual run went unanswered rather than refused.
 *
 * A run executes inside its request. When the request times out (408 from the
 * panel, 504 from the proxy in front of it) or no answer arrives at all, the
 * run was not refused.
 *
 * WHAT FOLLOWS IS NOT ONE STATE. A timeout means the request left and the run
 * may be going; `ERR_NETWORK` may mean the request never left the browser, so
 * no run started and nothing will ever appear in the log — and axios cannot
 * tell, inside that code, "never connected" from "cut after the bytes went
 * out". So the copy this feeds says both are possible and sends the operator to
 * the rule's «Запуски» before pressing again.
 */
export function runHadNoAnswer(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  if ((error as { isAxiosError?: unknown }).isAxiosError !== true) return false
  const response = (error as { response?: { status?: unknown } }).response
  if (response === undefined || response === null) return true
  return response.status === 408 || response.status === 504
}

/** An execution status in the operator's language. */
export function statusText(t: TFunction, status: string): string {
  return String(t(`automationsPage.statuses.${status}`, { defaultValue: status }))
}

/**
 * The one line a run is toasted with: its status, and what went wrong first.
 *
 * The first FAILED action wins over the first skipped one — a failure is what
 * the operator has to act on. A run that reached no action says why instead.
 */
export function runToastText(t: TFunction, result: ManualRunResult): string {
  const status = statusText(t, result.status)
  const notable =
    result.actionResults.find((entry) => entry.status === 'failed') ??
    result.actionResults.find((entry) => entry.status === 'skipped')
  if (notable !== undefined) {
    const note = actionResultText(t, notable)
    if (note !== null) {
      return String(
        t('automationsPage.toast.runFinishedAction', {
          status,
          action: actionLabel(t, notable.type),
          note,
        }),
      )
    }
  }
  if (result.actionResults.length === 0) {
    const note = executionNoteText(t, result.errorMessage)
    if (note !== null) return String(t('automationsPage.toast.runFinishedNote', { status, note }))
  }
  return String(t('automationsPage.toast.runFinished', { status }))
}
