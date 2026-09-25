/**
 * Which bot texts are held to a pop-up's 200 characters: the SPA's list, the
 * server's, and what the bot actually answers a pressed button with.
 * ──────────────────────────────────────────────────────────────────────────
 * The SPA counts under the field (`bot-text-limits.ts`) and the server refuses
 * the save (`src/modules/bot-config/utils/callback-answer-texts.util.ts`, read
 * by `bot-texts.service.ts`). The production frontend may not import out of
 * `web/`, so the list is written twice; the first half of this file pins the
 * two together from the test side, where reaching across the package boundary
 * is legal (`panel-traffic-limit-parity.test.ts` makes the same move).
 *
 * The second half reads reiwa's bot source, when the sibling checkout is on
 * disk (`../reiwa` next to this repo), as `system-screens.reiwa.parity.test.ts`
 * does, and skips without it: CI for this repo has no reiwa working tree. It
 * takes a census of every `answerCallback(…)` that carries a `text:` — the one
 * way reiwa answers a press with words (`src/bot/lib/callback-answer.ts`, which
 * cuts the text to fit) — and resolves the text key each one shows:
 *   • a quoted key, in `t('…')` or in a translating helper's call (`toast('…')`);
 *   • the parameter of the helper the call sits in (`alert(key)`) — the quoted
 *     keys that helper is called with in the same file;
 *   • the access-mode refusal (`accessModeRefusal`) — the keys its
 *     `AccessModeRefusal` type allows;
 *   • `press.noticeKey` — the keys passed as `noticeKey:` in the bot's source.
 * A text it cannot resolve FAILS, naming the call site, and so does a raw
 * `ctx.answerCallbackQuery(…)` with arguments: a census that skipped them
 * would switch itself off on the day the bot grew a new kind of answer.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  CALLBACK_ANSWER_MAX_CHARS,
  CALLBACK_ANSWER_TEXTS,
} from '../../../../src/modules/bot-config/utils/callback-answer-texts.util'

import { BUTTON_ANSWER_TEXTS, botTextMaxChars } from './bot-text-limits'

const REIWA = join(__dirname, '..', '..', '..', '..', '..', '..', 'reiwa')
const BOT_SOURCES = join(REIWA, 'src', 'bot')
const START_PAGE = join(BOT_SOURCES, 'pages', 'start.ts')
const CALLBACK_ANSWER = join(BOT_SOURCES, 'lib', 'callback-answer.ts')
const hasSibling = existsSync(REIWA)

describe('the panel’s two lists of texts shown as a button answer', () => {
  it('hold the same keys to the same 200, and say the same about being a message too', () => {
    expect(CALLBACK_ANSWER_TEXTS.length).toBeGreaterThan(0)
    expect(BUTTON_ANSWER_TEXTS.map((entry) => [entry.key, entry.alsoMessage])).toEqual(
      CALLBACK_ANSWER_TEXTS.map((entry) => [entry.key, entry.alsoMessage]),
    )
    expect(CALLBACK_ANSWER_MAX_CHARS).toBe(200)
    for (const entry of CALLBACK_ANSWER_TEXTS) expect(botTextMaxChars(entry.key), entry.key).toBe(CALLBACK_ANSWER_MAX_CHARS)
  })
})

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return tsFiles(path)
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : []
  })
}

/** The text between the `(` at `open` and its matching `)`. */
function argumentsAt(source: string, open: number): string {
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    const char = source[index]
    if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth === 0) return source.slice(open + 1, index)
    }
  }
  return source.slice(open + 1)
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length
}

/** The quoted keys a helper named `name` is called with in `source`; a call with anything else is unresolved. */
function helperCallKeys(source: string, name: string, where: string, unresolved: string[]): string[] {
  const keys: string[] = []
  for (const match of source.matchAll(new RegExp(`\\b${name}\\(\\s*([^,)]+)`, 'g'))) {
    const argument = match[1].trim()
    const quoted = /^'([a-z0-9_.]+)'$/.exec(argument)
    if (quoted !== null) keys.push(quoted[1])
    else if (!/^\(?\w+: string/.test(argument)) unresolved.push(`${where}: ${name}(${argument})`)
  }
  return keys
}

/** The members of `export type AccessModeRefusal = 'a' | 'b' | …;` in reiwa's `start.ts`. */
function accessModeRefusals(): string[] {
  const declaration = /export type AccessModeRefusal\s*=([^;]+);/.exec(readFileSync(START_PAGE, 'utf8'))
  expect(declaration, `${START_PAGE}: no AccessModeRefusal type`).not.toBeNull()
  return [...(declaration?.[1] ?? '').matchAll(/'([a-z0-9_.]+)'/g)].map((match) => match[1])
}

/** Every quoted key, or constant holding one, passed as `noticeKey:` in the bot's source. */
function noticeKeys(sources: ReadonlyArray<readonly [string, string]>, unresolved: string[]): string[] {
  const all = sources.map(([, source]) => source).join('\n')
  const keys: string[] = []
  for (const match of all.matchAll(/\bnoticeKey:\s*([A-Za-z_'][\w.']*)/g)) {
    const value = match[1]
    const quoted = /^'([a-z0-9_.]+)'$/.exec(value)
    if (quoted !== null) {
      keys.push(quoted[1])
      continue
    }
    const constant = new RegExp(`\\bconst ${value}\\s*=\\s*'([a-z0-9_.]+)'`).exec(all)
    if (constant !== null) keys.push(constant[1])
    else unresolved.push(`noticeKey: ${value}`)
  }
  return keys
}

/**
 * The keys reiwa shows as the answer to a pressed button, and the call sites
 * whose text this census could not resolve.
 */
function buttonAnswerCensus(): { readonly keys: Set<string>; readonly unresolved: string[] } {
  const sources = tsFiles(BOT_SOURCES)
    .filter((file) => file !== CALLBACK_ANSWER)
    .map((file) => [file, readFileSync(file, 'utf8')] as const)
  const keys = new Set<string>()
  const unresolved: string[] = []
  for (const [file, source] of sources) {
    const name = relative(REIWA, file).replace(/\\/g, '/')
    // A raw answer with words would bypass the cut — and this census.
    for (const match of source.matchAll(/answerCallbackQuery\(/g)) {
      const open = (match.index ?? 0) + match[0].length - 1
      if (argumentsAt(source, open).trim() !== '') {
        unresolved.push(`${name}:${lineOf(source, open)}: ctx.answerCallbackQuery with arguments`)
      }
    }
    // Helpers that turn their first parameter into the translated text:
    // `const toast = (key: string, …) => plainCopy(deps.translator.t(key, lang), …)`.
    const translating = [...source.matchAll(/const (\w+) = (?:async )?\((\w+): string[^\n]*=>[^\n]*\.t\(\2\b/g)].map(
      (match) => match[1],
    )
    for (const match of source.matchAll(/\banswerCallback\(/g)) {
      const open = (match.index ?? 0) + match[0].length - 1
      const args = argumentsAt(source, open)
      if (!/\btext:/.test(args)) continue
      const where = `${name}:${lineOf(source, open)}`
      const callee = new RegExp(`(?:\\.t|\\b(?:${['t', ...translating].join('|')}))\\(\\s*([^,)]+)`, 'g')
      let found = 0
      for (const call of args.matchAll(callee)) {
        found += 1
        const argument = call[1].trim()
        const quoted = /^'([a-z0-9_.]+)'$/.exec(argument)
        if (quoted !== null) {
          keys.add(quoted[1])
          continue
        }
        const before = source.slice(0, open)
        // The parameter of the helper this call sits in: `const alert = async (key: string) => { … }`.
        const helper = [...before.matchAll(new RegExp(`const (\\w+) = (?:async )?\\(${argument}: string`, 'g'))].pop()
        if (helper !== undefined) {
          for (const key of helperCallKeys(source, helper[1], where, unresolved)) keys.add(key)
          continue
        }
        // The access-mode refusal: `const refusal = … await accessModeRefusal(…)`.
        const declared = [...before.matchAll(new RegExp(`const ${argument}\\s*=([^;]+);`, 'g'))].pop()
        if (declared !== undefined && /\baccessModeRefusal\(/.test(declared[1])) {
          for (const key of accessModeRefusals()) keys.add(key)
          continue
        }
        if (/\.noticeKey$/.test(argument)) {
          for (const key of noticeKeys(sources, unresolved)) keys.add(key)
          continue
        }
        unresolved.push(`${where}: text from ${argument}`)
      }
      if (found === 0) unresolved.push(`${where}: a text with no key this census can read`)
    }
  }
  return { keys, unresolved }
}

describe.skipIf(!hasSibling)('the texts held to a pop-up’s 200, against the answers reiwa gives a pressed button', () => {
  it('finds, in the reiwa checkout, every file it reads', () => {
    const missing = [BOT_SOURCES, START_PAGE, CALLBACK_ANSWER].filter((path) => !existsSync(path))
    expect(missing, 'moved in reiwa — point this test at their new place').toEqual([])
  })

  it('resolves the text of every answer with words', () => {
    expect(buttonAnswerCensus().unresolved).toEqual([])
  })

  it('holds exactly the keys reiwa shows as an answer to a press', () => {
    const { keys } = buttonAnswerCensus()
    // Anti-vacuity: the census found the answers it has always found.
    expect(keys.has('menu.updated')).toBe(true)
    expect(keys.has('quests.channel.verified')).toBe(true)
    expect([...keys].sort()).toEqual(CALLBACK_ANSWER_TEXTS.map((entry) => entry.key).sort())
  })
})
