import type { TFunction } from 'i18next'

import { translateApiError, translateServerSentence } from '@/lib/translate-error'

import { permissionName } from './action-permissions'
import { actionLabel } from './rule-action-labels'
import { blockProtectionText, rangeKindText } from './run-result-copy'

/**
 * What the automations screen tells an operator when the panel refuses a save,
 * a switch or a run.
 *
 * The panel writes these refusals in English and with no code — the safe
 * exception filter forwards a code only from its own allowlist — so they are
 * recognised here by their shape and said in the operator's language, with a
 * permission named the way the roles page names it and an action the way this
 * page names it. Everything else goes through the shared lookup
 * (`translate-error.ts`): a sentence the dictionaries hold is translated, an
 * unknown one is shown in the server's own words, and a request that never
 * reached the server gets the transport copy.
 *
 * The sentences are the server's (`automation-action-permissions.ts`,
 * `condition-validator.ts`, `common/net/outbound-url.ts`,
 * `block-ip-safety.service.ts`, `automations.service.ts`, and `RbacGuard` for a
 * route's own permission).
 * Each rule below that stops matching sends the server's English through
 * unchanged — never a key path, never nothing.
 */

type SentenceRule = (t: TFunction, sentence: string) => string | null

/** `"block_ip"`, `"block_ip, webhook_post"` → the page's own names, quoted. */
function actionNames(t: TFunction, types: string): string {
  return types
    .split(',')
    .map((type) => type.trim())
    .filter((type) => type.length > 0)
    .map((type) => quoted(t, actionLabel(t, type)))
    .join(', ')
}

function quoted(t: TFunction, name: string): string {
  return String(t('automationsPage.quotedName', { name }))
}

function permission(t: TFunction, resource: string, action: string): string {
  return quoted(t, permissionName(t, { resource, action }))
}

/** The English noun the panel puts before a range, back to the kind it names. */
const SERVER_RANGE_NOUNS: Readonly<Record<string, string>> = {
  'an unspecified address': 'unspecified',
  'a loopback address': 'loopback',
  'a link-local address, where cloud metadata services answer': 'link_local',
  'a multicast address': 'multicast',
  'a reserved address': 'reserved',
  'a cloud metadata address': 'cloud_metadata',
}

/** The English end of "… covers <this>", back to the protection it names. */
const SERVER_PROTECTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^your own address$/, 'your_address'],
  [
    /^the panel's internal network \((.+)\), where the panel itself, its reverse proxy and the services beside it connect from$/,
    'internal_network',
  ],
  [/^an address of the machine the panel runs on$/, 'this_panel'],
  [/^an address an administrator signed in or worked from in the last 24 hours$/, 'admin_session'],
  [/^an entry of the admin IP allowlist$/, 'admin_allowlist'],
  [
    /^the address of the panel's own domain or of a service it works with \(the cabinet, the subscription page\)$/,
    'panel_service',
  ],
]

function conditionProblem(t: TFunction, problem: string): string {
  const key = (name: string, options?: Record<string, unknown>): string =>
    String(t(`automationsPage.conditionProblems.${name}`, options))
  let match: RegExpExecArray | null
  if ((match = /^unknown operator "(.+)" \(known: .+\)$/.exec(problem)) !== null) {
    return key('unknownOperator', { operator: match[1] })
  }
  if (/^unknown operator \(known: .+\)$/.test(problem)) return key('unknownOperatorUnnamed')
  if (problem === 'expected an object with exactly one operator') return key('oneOperator')
  if ((match = /^"(.+)" takes exactly 2 operands, in a list$/.exec(problem)) !== null) {
    return key('twoOperands', { operator: match[1] })
  }
  if (problem === '"not" takes exactly one condition') return key('notOne')
  if ((match = /^"(.+)" needs a list of at least one condition$/.exec(problem)) !== null) {
    return key('emptyList', { operator: match[1] })
  }
  if (problem.startsWith('a plain value cannot stand for a condition')) return key('plainValue')
  if (problem === 'a list is allowed only as the second operand of "in"') return key('listPlace')
  if (problem === 'a list for "in" may hold only plain values') return key('listItems')
  if (problem === 'expected a plain value, a "$" variable or an operation') return key('operand')
  if (problem.startsWith('the variable is not a usable path')) return key('variable')
  if ((match = /^conditions are nested more than (\d+) levels deep$/.exec(problem)) !== null) {
    return key('tooDeep', { limit: Number(match[1]) })
  }
  if ((match = /^conditions have more than (\d+) parts$/.exec(problem)) !== null) {
    return key('tooLarge', { limit: Number(match[1]) })
  }
  return problem
}

function actionProblem(t: TFunction, problem: string): string {
  const key = (name: string, options?: Record<string, unknown>): string =>
    String(t(`automationsPage.actionProblems.${name}`, options))
  let match: RegExpExecArray | null
  if (problem === 'needs a URL') return key('urlMissing')
  if ((match = /^the URL is longer than (\d+) characters$/.exec(problem)) !== null) {
    return key('urlTooLong', { limit: Number(match[1]) })
  }
  if (problem === 'the URL must use the http or https scheme') return key('urlScheme')
  if (problem === 'the URL is not a valid address') return key('urlMalformed')
  if (problem === 'the URL names this machine itself (localhost)') return key('urlLocalName')
  if (problem === 'the URL names a cloud metadata service') return key('urlMetadataName')
  if ((match = /^the URL points at (.+) \((\S+)\)$/.exec(problem)) !== null) {
    const kind = Object.hasOwn(SERVER_RANGE_NOUNS, match[1]) ? SERVER_RANGE_NOUNS[match[1]] : 'unknown'
    return key('urlInternal', { kind: rangeKindText(t, kind), range: match[2] })
  }
  if (
    problem ===
    '"authorizationHeader" may hold only what an HTTP header can carry: printable ASCII and Latin-1 characters on one line — no line breaks, no Cyrillic'
  ) {
    return key('headerCharset')
  }
  if (problem === 'a rule may emit only its own events: "automation.custom", or a type that starts with "automation.custom."') {
    return key('eventTypeNotCustom')
  }
  if (problem === '"authorizationHeader" refers to a saved rule, and a new rule has none — enter the header itself') {
    return key('headerNewRule')
  }
  if (problem === 'the saved "authorizationHeader" it refers to is no longer on the rule — enter it again or remove it') {
    return key('headerGone')
  }
  if (problem === 'the saved "authorizationHeader" it refers to belongs to another action — enter it again or remove it') {
    return key('headerShifted')
  }
  if (problem === 'the URL changed, so the saved "authorizationHeader" was not carried over — enter it again or remove it') {
    return key('headerMoved')
  }
  if (problem === '"urlHidden" does not name a saved URL — read the rule again, or send the URL itself without "urlHidden"') {
    return key('urlHiddenNotReference')
  }
  if (problem === '"urlHidden" keeps the URL saved on a rule, and a new rule has none — enter the URL itself') {
    return key('urlHiddenNewRule')
  }
  if (problem === 'the saved URL "urlHidden" refers to belongs to another action — enter the URL again') {
    return key('urlHiddenShifted')
  }
  if (problem === 'the saved URL "urlHidden" refers to is no longer on the rule — enter the URL again') {
    return key('urlHiddenGone')
  }
  if (problem === '"url" and "urlHidden" disagree — send a new URL without "urlHidden", or "urlHidden" without a URL') {
    return key('urlHiddenDisagree')
  }
  if (problem === 'the URL is the shortened form the panel shows in place of a hidden one — enter the full URL') {
    return key('urlIsHiddenForm')
  }
  if (
    problem ===
    'no event or schedule carries an IP address, so a rule that runs on its own needs the address written into the action'
  ) {
    return key('blockAddressNeeded')
  }
  if (problem === '"address" is not an IP address or CIDR range') return key('addressInvalid')
  if (problem === '"expiresAt" is not a valid date') return key('expiresInvalid')
  if ((match = /^the address (\S+) covers (.+)$/.exec(problem)) !== null) {
    const address = match[1]
    const covered = match[2]
    for (const [pattern, protection] of SERVER_PROTECTIONS) {
      const found = pattern.exec(covered)
      if (found !== null) {
        return key('addressProtected', { address, protection: blockProtectionText(t, protection, found[1] ?? '') })
      }
    }
    return key('addressProtected', { address, protection: blockProtectionText(t, 'unknown', '') })
  }
  if (
    problem.startsWith('the address could not be checked') ||
    problem.startsWith("the administrators' addresses could not be read")
  ) {
    return key('addressUnverified')
  }
  return problem
}

const RULES: readonly SentenceRule[] = [
  (t, sentence) =>
    sentence === 'The rule changed while it was being switched on — reload it and try again'
      ? String(t('automationsPage.serverErrors.ruleChanged'))
      : null,
  (t, sentence) => {
    const match = /^Missing permission: ([a-z_]+):([a-z_]+) \(needed by the ([a-z_, ]+) actions?\)$/.exec(sentence)
    return match === null
      ? null
      : String(
          t('automationsPage.serverErrors.actionPermission', {
            permission: permission(t, match[1], match[2]),
            actions: actionNames(t, match[3]),
          }),
        )
  },
  (t, sentence) => {
    const match = /^Missing permission: ([a-z_]+):([a-z_]+)$/.exec(sentence)
    return match === null
      ? null
      : String(t('automationsPage.serverErrors.routePermission', { permission: permission(t, match[1], match[2]) }))
  },
  (t, sentence) => {
    const match = /^Conditions: at (.+?), (.+)$/.exec(sentence)
    if (match === null) return null
    const where =
      match[1] === 'the top level'
        ? String(t('automationsPage.serverErrors.conditionsTop'))
        : String(t('automationsPage.serverErrors.conditionsAt', { pointer: match[1] }))
    return String(t('automationsPage.serverErrors.conditions', { where, problem: conditionProblem(t, match[2]) }))
  },
  (t, sentence) => {
    const match = /^Action (\d+) \(([a-z_]+)\): (.+)$/.exec(sentence)
    if (match === null) return null
    return String(
      t('automationsPage.serverErrors.action', {
        index: Number(match[1]),
        action: quoted(t, actionLabel(t, match[2])),
        problem: actionProblem(t, match[3]),
      }),
    )
  },
]

function translateSentence(t: TFunction, sentence: string): string {
  for (const rule of RULES) {
    const translated = rule(t, sentence)
    if (translated !== null) return translated
  }
  return translateServerSentence(t, sentence)
}

/** `response.data.message` — one sentence, or the list a refusal of several things carries. */
function serverSentences(error: unknown): readonly string[] {
  if (typeof error !== 'object' || error === null) return []
  const message = (error as { response?: { data?: { message?: unknown } } }).response?.data?.message
  const list = Array.isArray(message) ? message : [message]
  return list.filter((item): item is string => typeof item === 'string' && item.length > 0)
}

/** The reason a request about a rule was refused, in the operator's language. */
export function translateAutomationError(t: TFunction, error: unknown): string {
  const sentences = serverSentences(error)
  if (sentences.length === 0) return translateApiError(t, error)
  return sentences.map((sentence) => translateSentence(t, sentence)).join(' ')
}
