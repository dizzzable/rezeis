/**
 * The map's copy of the bot, against the bot's own source.
 *
 * «Карта бота» lists what reiwa shows — the texts of every built-in screen
 * (`SCREEN_TEXT_KEYS`, `SYSTEM_SCREENS`, the main menu's), the buttons it adds
 * (`systemButtonsFor`, `SYSTEM_SCREENS`), the callbacks it answers
 * (`CALLBACK_VOCABULARY`) — and `system-screens.test.ts` pins those lists to a
 * table copied from reiwa. A copy agrees with itself while reiwa moves on: a
 * text or a button added there left the map short and every test green.
 *
 * This file reads reiwa's source instead, when the sibling checkout is on disk
 * (`../reiwa` next to this repo), exactly as `app-texture.parity.test.ts` and
 * `live-kit-manifest.test.ts` do, and skips without it: CI for this repo has no
 * reiwa working tree, and nothing in one repo's CI can see the other's source.
 * What it checks:
 *   1. every key the map lists is one reiwa's bot code reads — a key renamed
 *      or dropped there leaves an editor that changes nothing;
 *   2. every text key reiwa's bot code reads is on the map, or named below
 *      with the reason it is not — a text added there with no editor here;
 *   3. every callback word reiwa registers is one the map routes, and every
 *      word the map routes is registered — the vocabulary «Схема» and
 *      «Список» draw from (its server copy is pinned to this one by
 *      `test/bot-map-route-parity.spec.ts`);
 *   4. every page alias the route model follows (`MINI_APP_PAGE_ALIASES`) is
 *      a route of the cabinet's `web/src/App.tsx` that sends on to that page —
 *      the map draws a button to the alias green only because it does.
 * "Reads" is a literal census: a key of reiwa's ru pack quoted in `src/bot/**`
 * or `src/infrastructure/bot-message/**`, or built by a template there
 * (`commands.${…}.description`, `lang.name.${…}`).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { CALLBACK_VOCABULARY, MINI_APP_PAGE_ALIASES, callbackRoute } from './components/reply-keyboard-utils'
import {
  MAIN_MENU_SYSTEM_BUTTONS,
  MAIN_MENU_TEXT_KEYS,
  SCREEN_TEXT_KEYS,
  SYSTEM_SCREENS,
} from './system-screens'
import { systemButtonsFor } from './utils'

const REIWA = join(__dirname, '..', '..', '..', '..', '..', '..', 'reiwa')
const PACK = join(REIWA, 'src', 'infrastructure', 'i18n', 'packs', 'ru.pack.ts')
const BOT_SOURCES = [join(REIWA, 'src', 'bot'), join(REIWA, 'src', 'infrastructure', 'bot-message')]
/**
 * Only a missing checkout skips this file. A checkout where a file this reads
 * has moved fails, naming the path: skipping then would switch the census off
 * on every machine that has reiwa, with «skipped» the only trace of it.
 */
const hasSibling = existsSync(REIWA)

/**
 * Keys reiwa's bot code reads that are deliberately not on the map.
 * A prefix ends in `.`.
 */
const NOT_ON_THE_MAP: Readonly<Record<string, string>> = {
  back: "a system-button icon slot (`renderSystemButton(…, 'back', …)`) spelled like a pack key — no text is read",
  cancel: '`CANCEL_COMMAND` — the /cancel command, spelled like a pack key',
  'menu_button.cabinet': 'the chat menu button beside the input — set in the main menu’s bot settings',
  'bot_event.': 'operator cards (start, stop, credits) — sent to the operator, not to customers',
}

/** Keys the map lists that reach reiwa through the panel's config, not through its pack. */
const READ_THROUGH_THE_PANEL: Readonly<Record<string, string>> = {
  'bot.welcome_message': 'sent to reiwa as `visual.welcomeMessage` (`internal-bot-config.service.ts`)',
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return tsFiles(path)
    return name.endsWith('.ts') ? [path] : []
  })
}

function botSource(): string {
  return BOT_SOURCES.flatMap(tsFiles)
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n')
}

/** The keys of reiwa's ru pack: `'a.b': …` and bare `a_b: …` entries. */
function packKeys(): Set<string> {
  const pack = readFileSync(PACK, 'utf8')
  const keys = new Set<string>()
  for (const match of pack.matchAll(/^\s*'([^']+)'\s*:/gm)) keys.add(match[1])
  for (const match of pack.matchAll(/^\s*([a-z][a-z0-9_]*)\s*:/gm)) keys.add(match[1])
  return keys
}

/** The pack keys reiwa's bot code reads: quoted anywhere, or built by a template. */
function readKeys(source: string): Set<string> {
  const pack = packKeys()
  const read = new Set<string>()
  for (const key of pack) {
    if (source.includes(`'${key}'`) || source.includes(`"${key}"`) || source.includes(`\`${key}\``)) read.add(key)
  }
  // `commands.${command}.description`, `lang.name.${newLang}`: a prefix, a
  // placeholder, maybe a suffix.
  for (const match of source.matchAll(/`([a-z_]+(?:\.[a-z_]+)*)\.\$\{[^}]+\}((?:\.[a-z_]+)*)`/g)) {
    const [, prefix, suffix] = match
    for (const key of pack) {
      if (key.startsWith(`${prefix}.`) && key.endsWith(suffix) && key.length > prefix.length + 1 + suffix.length) {
        read.add(key)
      }
    }
  }
  return read
}

/** Every key the map lists, anywhere. */
function mapKeys(): Set<string> {
  const keys = new Set<string>([...Object.values(SCREEN_TEXT_KEYS).flat(), ...MAIN_MENU_TEXT_KEYS])
  for (const screen of SYSTEM_SCREENS) {
    for (const text of screen.texts) keys.add(text.key)
    for (const button of screen.buttons) if (button.textKey !== undefined) keys.add(button.textKey)
  }
  const buttons = [
    ...MAIN_MENU_SYSTEM_BUTTONS,
    ...['invite', 'rules', 'help'].flatMap((name) => systemButtonsFor(name, false, 0)),
    // A screen the operator built without buttons: its auto «◀️ В меню».
    ...systemButtonsFor('promo', false, 0),
  ]
  for (const button of buttons) if (button.textKey !== undefined) keys.add(button.textKey)
  return keys
}

function isExcused(key: string): boolean {
  return Object.keys(NOT_ON_THE_MAP).some((excused) => (excused.endsWith('.') ? key.startsWith(excused) : key === excused))
}

describe.skipIf(!hasSibling)('the map’s copy of the bot, against reiwa’s source', () => {
  it('finds, in the reiwa checkout, every file it reads', () => {
    const missing = [PACK, ...BOT_SOURCES].filter((path) => !existsSync(path))
    expect(missing, 'moved in reiwa — point this test at their new place').toEqual([])
  })

  it('lists only keys reiwa reads', () => {
    const read = readKeys(botSource())
    const unread = [...mapKeys()].filter((key) => !read.has(key) && !(key in READ_THROUGH_THE_PANEL)).sort()
    expect(unread, 'keys on the map that reiwa no longer reads').toEqual([])
  })

  it('lists every text reiwa reads, or names why not', () => {
    const listed = mapKeys()
    const missing = [...readKeys(botSource())].filter((key) => !listed.has(key) && !isExcused(key)).sort()
    expect(missing, 'texts reiwa sends that the map has no editor for').toEqual([])
  })

  it('routes every callback reiwa registers, and no word reiwa does not', () => {
    const source = botSource()
    const registered = new Set<string>([
      ...[...source.matchAll(/callbackQuery\(\s*'([^']+)'/g)].map((match) => match[1]),
      ...[...source.matchAll(/export const [A-Z_]+_CALLBACK = '([^']+)'/g)].map((match) => match[1]),
    ])
    const context = { screens: [], miniAppRoutes: null, supportChat: null }
    for (const word of registered) {
      expect(callbackRoute(word, context).kind, word).not.toBe('unanswered')
    }
    const routed = [...CALLBACK_VOCABULARY.builtInScreens, ...CALLBACK_VOCABULARY.mainMenu, ...CALLBACK_VOCABULARY.answered]
    expect(routed.filter((word) => !registered.has(word))).toEqual([])
    // The handlers the vocabulary's patterns and prefix stand for.
    for (const handler of ['LANG_CALLBACK_RE', 'QUEST_CHANNEL_RE', 'CHECK_CHANNEL_CALLBACK_RE', "'callback_query:data'"]) {
      expect(source, handler).toContain(handler)
    }
    expect(source).toContain(`const SCREEN_PREFIX = '${CALLBACK_VOCABULARY.screenPrefix}'`)
  })

  it('follows a page alias only where the cabinet’s router sends it on to that page', () => {
    const app = join(REIWA, 'web', 'src', 'App.tsx')
    expect(existsSync(app), 'moved in reiwa — point this test at its new place').toBe(true)
    const source = readFileSync(app, 'utf8')
    const aliases = Object.entries(MINI_APP_PAGE_ALIASES)
    expect(aliases.length).toBeGreaterThan(0)
    for (const [alias, page] of aliases) {
      // `<Route path="/subscribe" element={<SubscribeAlias />} />` …
      const route = new RegExp(`<Route\\s+path="${alias}"\\s+element=\\{<(\\w+)\\s*/>\\}`).exec(source)
      expect(route, `${alias}: no route in the cabinet`).not.toBeNull()
      // … whose component navigates to the page, its query kept or not.
      const component = new RegExp(`function ${route?.[1] ?? ''}\\(\\)\\s*\\{([\\s\\S]*?)\\n\\}`).exec(source)
      expect(component?.[1] ?? '', `${alias}: ${route?.[1]} does not send it on to ${page}`).toMatch(
        new RegExp(`<Navigate\\s+to=\\{?[\`"]${page}(\\$\\{[^}]*\\})?[\`"]\\}?`),
      )
    }
  })
})
