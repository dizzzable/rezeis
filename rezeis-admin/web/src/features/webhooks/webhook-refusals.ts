import type { TFunction } from 'i18next'

import { getErrorMessage } from '@/lib/http-errors'

/**
 * Where the panel does not send a webhook, in the operator's language.
 *
 * The panel refuses a subscription URL that points at the machine itself or at
 * a cloud metadata service (`common/net/outbound-url.ts`), at save and again at
 * send. It says so in English with no code, in two places this page shows:
 *
 *   a refused save   "The panel does not send webhooks there: <problem>"
 *   a delivery log   "Refused before sending: <problem>", or
 *                    "Refused before sending: <host> resolves to <noun> (<range>): <address>"
 *
 * Each is recognised by shape here. Anything else — every other delivery error
 * and every other refusal — reads exactly as it did: the server's own words.
 */

/**
 * The server's range nouns (`RANGE_NOUNS` in `common/net/outbound-url.ts`),
 * back to the kind each names. A copy, held to the server's table by
 * `webhook-refusals.test.ts`.
 */
const SERVER_RANGE_NOUNS: Readonly<Record<string, string>> = {
  'an unspecified address': 'unspecified',
  'a loopback address': 'loopback',
  'a link-local address, where cloud metadata services answer': 'link_local',
  'a multicast address': 'multicast',
  'a reserved address': 'reserved',
  'a cloud metadata address': 'cloud_metadata',
}

function kindText(t: TFunction, noun: string): string {
  const kind = Object.hasOwn(SERVER_RANGE_NOUNS, noun) ? SERVER_RANGE_NOUNS[noun] : 'unknown'
  return String(t(`errors.webhookRange_${kind}`))
}

/** "the URL …" from the server, in words — or null when it is not one of the policy's. */
function problemText(t: TFunction, problem: string): string | null {
  if (problem === 'the URL names this machine itself (localhost)') return String(t('errors.webhookUrlLocalhost'))
  if (problem === 'the URL names a cloud metadata service') return String(t('errors.webhookUrlMetadataName'))
  const match = /^the URL points at (.+) \((\S+)\)$/.exec(problem)
  if (match === null) return null
  return String(t('errors.webhookUrlPointsAt', { kind: kindText(t, match[1]), range: match[2] }))
}

const SAVE_PREFIX = 'The panel does not send webhooks there: '
const DELIVERY_PREFIX = 'Refused before sending: '

/** A delivery's `errorMessage` as this page shows it. */
export function deliveryErrorText(t: TFunction, message: string): string {
  if (!message.startsWith(DELIVERY_PREFIX)) return message
  const rest = message.slice(DELIVERY_PREFIX.length)
  const resolved = /^(\S+) resolves to (.+) \((\S+)\): (\S+)$/.exec(rest)
  if (resolved !== null) {
    return String(
      t('errors.webhookRefusedResolved', { host: resolved[1], kind: kindText(t, resolved[2]), address: resolved[4] }),
    )
  }
  const problem = problemText(t, rest)
  return problem === null ? message : String(t('errors.webhookRefusedDelivery', { problem }))
}

/** A refused create or edit of a subscription, in words; anything else as `getErrorMessage` puts it. */
export function subscriptionErrorText(t: TFunction, error: unknown, fallback: string): string {
  const message = serverMessage(error)
  if (message !== null && message.startsWith(SAVE_PREFIX)) {
    const problem = problemText(t, message.slice(SAVE_PREFIX.length))
    if (problem !== null) return String(t('errors.webhookRefusedSave', { problem }))
  }
  return getErrorMessage(error, fallback)
}

function serverMessage(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null
  const message = (error as { response?: { data?: { message?: unknown } } }).response?.data?.message
  const first = Array.isArray(message) ? message[0] : message
  return typeof first === 'string' ? first : null
}
