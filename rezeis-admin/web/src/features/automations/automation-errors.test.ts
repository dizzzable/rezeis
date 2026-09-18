/**
 * The panel's refusals of a rule, in the operator's language.
 *
 * Every refusal a save, a switch or a run can now meet carries values — the
 * permission an action needs, where in the conditions the problem is, what a
 * URL or an address points at — and so cannot be an entry in the exact-sentence
 * table the rest of the panel's errors go through. Each is recognised by shape
 * here. A shape that stops matching must fall back to the server's own English,
 * never to a key path and never to nothing; the last block holds the SPA's copy
 * of the server's range nouns to the server's own table, so a reworded noun
 * breaks a test rather than a sentence.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createInstance, type TFunction } from 'i18next'
import { describe, expect, it } from 'vitest'

import { en as coreEn } from '@/i18n/en'
import { ru as coreRu } from '@/i18n/ru'
import { en } from '@/i18n/features/automations.en'
import { ru } from '@/i18n/features/automations.ru'

import { translateAutomationError } from './automation-errors'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..', '..', '..')

function translator(lng: 'en' | 'ru'): TFunction {
  const i18n = createInstance()
  void i18n.init({
    lng,
    fallbackLng: 'en',
    resources: {
      en: { translation: { ...(coreEn as unknown as Record<string, unknown>), ...(en as unknown as Record<string, unknown>) } },
      ru: { translation: { ...(coreRu as unknown as Record<string, unknown>), ...(ru as unknown as Record<string, unknown>) } },
    },
    interpolation: { escapeValue: false },
    initAsync: false,
  })
  return i18n.t.bind(i18n) as TFunction
}

const RU = translator('ru')
const EN = translator('en')

/** A refusal as axios hands it to a mutation's `onError`. */
function refused(status: number, message: string | string[]): unknown {
  return {
    isAxiosError: true,
    message: `Request failed with status code ${status}`,
    response: { status, data: { statusCode: status, message } },
  }
}

/** A sentence this module worded: in Russian, with no key path, no brace and not the input. */
function expectRussian(shown: string, sentence: string): void {
  expect(shown, sentence).not.toBe(sentence)
  expect(shown, sentence).not.toContain('automationsPage.')
  expect(shown, sentence).not.toContain('{{')
  expect(shown, sentence).toMatch(/[а-яА-Я]/)
}

describe('a permission an action needs', () => {
  it('names the permission as the roles page does, and the action as this page does', () => {
    const shown = translateAutomationError(
      RU,
      refused(403, ['Missing permission: blocked_ips:create (needed by the block_ip action)']),
    )
    expect(shown).toBe('У вашей роли нет права «Заблокированные IP: Создание», а оно нужно для действия «Заблокировать IP».')
    expect(
      translateAutomationError(EN, refused(403, ['Missing permission: webhooks:create (needed by the webhook_post action)'])),
    ).toBe('Your role does not have "Outgoing webhooks: Create", and "POST webhook" needs it.')
  })

  it('says every missing permission when there are several', () => {
    const shown = translateAutomationError(
      RU,
      refused(403, [
        'Missing permission: users:edit (needed by the block_user action)',
        'Missing permission: blocked_ips:create (needed by the block_ip action)',
      ]),
    )
    expect(shown).toContain('«Пользователи: Изменение»')
    expect(shown).toContain('«Заблокированные IP: Создание»')
    expect(shown).toContain('«Заблокировать пользователя»')
  })

  it('names the route’s own permission too, which RbacGuard words without an action', () => {
    expect(translateAutomationError(RU, refused(403, 'Missing permission: automations:create'))).toBe(
      'У вашей роли нет права «Автоматизации: Создание».',
    )
  })
})

describe('the rest of what a save can be refused for', () => {
  const sentences = [
    'Conditions: at the top level, unknown operator "equals" (known: ==, !=, >, >=, <, <=, in, and, or, not)',
    'Conditions: at the top level, expected an object with exactly one operator',
    'Conditions: at /==, "==" takes exactly 2 operands, in a list',
    'Conditions: at /and, "and" needs a list of at least one condition',
    'Conditions: at /and/0, a plain value cannot stand for a condition: it is always true or always false; compare it, for example with "=="',
    'Conditions: at /==/0, a list is allowed only as the second operand of "in"',
    'Conditions: at /in/1/0, a list for "in" may hold only plain values',
    'Conditions: at /==/0, the variable is not a usable path: "$" and names separated by dots',
    'Conditions: at /not, "not" takes exactly one condition',
    'Conditions: at /not/not, conditions are nested more than 16 levels deep',
    'Conditions: at /and/2499/==/0, conditions have more than 10000 parts',
    'Action 1 (webhook_post): the URL points at a loopback address (127.0.0.0/8)',
    'Action 2 (webhook_post): the URL points at a link-local address, where cloud metadata services answer (169.254.0.0/16)',
    'Action 1 (webhook_post): the URL names this machine itself (localhost)',
    'Action 1 (webhook_post): the URL names a cloud metadata service',
    'Action 1 (webhook_post): the URL points at a cloud metadata address (fd00:ec2::254/128)',
    'Action 1 (webhook_post): "authorizationHeader" refers to a saved rule, and a new rule has none — enter the header itself',
    'Action 2 (webhook_post): the saved "authorizationHeader" it refers to is no longer on the rule — enter it again or remove it',
    'Action 2 (webhook_post): the URL changed, so the saved "authorizationHeader" was not carried over — enter it again or remove it',
    'Action 1 (block_ip): no event or schedule carries an IP address, so a rule that runs on its own needs the address written into the action',
    'Action 1 (webhook_post): the URL must use the http or https scheme',
    'Action 1 (webhook_post): the URL is not a valid address',
    'Action 1 (webhook_post): the URL is longer than 2048 characters',
    'Action 1 (webhook_post): needs a URL',
    'Action 1 (webhook_post): "authorizationHeader" may hold only what an HTTP header can carry: printable ASCII and Latin-1 characters on one line — no line breaks, no Cyrillic',
    'Action 1 (system_event): a rule may emit only its own events: "automation.custom", or a type that starts with "automation.custom."',
    'Action 2 (webhook_post): the saved "authorizationHeader" it refers to belongs to another action — enter it again or remove it',
    'The rule changed while it was being switched on — reload it and try again',
    'Action 1 (block_ip): "address" is not an IP address or CIDR range',
    'Action 1 (block_ip): "expiresAt" is not a valid date',
    'Action 1 (block_ip): the address 203.0.113.0/24 covers your own address',
    "Action 1 (block_ip): the address 10.0.0.0/8 covers the panel's internal network (10.0.0.0/8), where the panel itself, its reverse proxy and the services beside it connect from",
    'Action 1 (block_ip): the address 198.51.100.60 covers an address an administrator signed in or worked from in the last 24 hours',
    'Action 1 (block_ip): the address 198.51.100.0/24 covers an entry of the admin IP allowlist',
    'Action 1 (block_ip): the address 198.51.100.9 covers an address of the machine the panel runs on',
    "Action 1 (block_ip): the address 192.0.2.10 covers the address of the panel's own domain or of a service it works with (the cabinet, the subscription page)",
    "Action 1 (block_ip): the administrators' addresses could not be read to check the address against, so the rule was not saved; try again",
    'Actions must be a list',
  ]

  it.each(sentences)('reaches a Russian operator in Russian: %s', (sentence) => {
    expectRussian(translateAutomationError(RU, refused(400, sentence)), sentence)
  })

  it('keeps the place in the conditions and the address it refused', () => {
    expect(
      translateAutomationError(RU, refused(400, 'Conditions: at /and/1, expected an object with exactly one operator')),
    ).toBe('Условия не приняты — в /and/1: ожидался объект ровно с одним оператором')
    expect(
      translateAutomationError(
        RU,
        refused(400, 'Action 1 (block_ip): the address 198.51.100.60 covers an address an administrator signed in or worked from in the last 24 hours'),
      ),
    ).toBe(
      'Действие 1 («Заблокировать IP»): адрес 198.51.100.60 охватывает адрес, с которого администратор входил или работал за последние 24 часа',
    )
    expect(
      translateAutomationError(
        RU,
        refused(400, 'Action 2 (webhook_post): the URL points at a loopback address (127.0.0.0/8)'),
      ),
    ).toBe('Действие 2 («POST webhook»): URL указывает на адрес loopback (127.0.0.0/8)')
  })

  it('hands anything it does not recognise to the shared lookup, in the server’s words', () => {
    expect(translateAutomationError(RU, refused(400, 'Something new the panel says'))).toBe('Something new the panel says')
    // And a sentence the shared table holds still comes out translated.
    expect(translateAutomationError(RU, refused(404, 'Rule not found'))).toMatch(/[а-яА-Я]/)
  })

  it('reports a request that never got an answer as such, not as a refusal', () => {
    const shown = translateAutomationError(RU, { isAxiosError: true, message: 'Network Error', code: 'ERR_NETWORK' })
    expect(shown).not.toBe('Network Error')
    expect(shown).toMatch(/[а-яА-Я]/)
  })
})

describe('the SPA’s copy of the server’s range nouns', () => {
  it('is the server’s own table, noun for noun', () => {
    const source = readFileSync(resolve(REPO, 'src', 'common', 'net', 'outbound-url.ts'), 'utf8')
    const start = source.indexOf('const RANGE_NOUNS')
    expect(start, 'RANGE_NOUNS is gone from common/net/outbound-url.ts — this parse needs rewriting').toBeGreaterThan(-1)
    const body = source.slice(start, source.indexOf('};', start))
    // `\r?` because the server's source is CRLF, and `$` stops at the `\n`.
    const server = [...body.matchAll(/^\s{2}([a-z_0-9]+): '([^']+)',\r?$/gm)]
      .filter((match) => match[1] !== 'unparseable')
      .map((match) => [match[2], match[1]] as const)
    expect(server.length, 'no noun parsed out of RANGE_NOUNS').toBeGreaterThanOrEqual(6)

    for (const [noun, kind] of server) {
      // Each noun, fed through the page's translator inside the server's own
      // sentence, must land on the kind the server meant — in both languages.
      const sentence = `Action 1 (webhook_post): the URL points at ${noun} (192.0.2.0/24)`
      expect(translateAutomationError(EN, refused(400, sentence)), kind).toBe(
        `Action 1 ("POST webhook"): the URL points at ${String(EN(`automationsPage.rangeKinds.${kind}`))} (192.0.2.0/24)`,
      )
    }
  })
})
