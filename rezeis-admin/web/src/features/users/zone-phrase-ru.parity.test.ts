/**
 * The Russian names of the operator's time zone, in all three places a
 * customer or an operator reads them.
 * ──────────────────────────────────────────────────────────────────────────
 * A reset time is never printed without its zone (owner, 24.09.2026), and a
 * Russian sentence names a city in the dative, «по Москве», which `Intl` does
 * not give. So the list is written out by hand, three times:
 *   • the bot's notices — `ZONE_PHRASE_RU` in the panel server's
 *     `notifications/utils/subscription-facts.util.ts`;
 *   • the operator's user card, «из них докупки: … (по Москве)» —
 *     `ZONE_PHRASE_RU` in `traffic-add-on-line.ts` beside this file;
 *   • the cabinet's add-on screens — `ZONE_PHRASE_RU` in reiwa's
 *     `web/src/lib/operator-zone.ts`.
 * A zone named in one and not another prints «по Екатеринбургу» in the bot
 * and «UTC+5» in the cabinet for the same moment. Each copy is read here as
 * source text, so none of them has to export its list.
 *
 * The cabinet's copy is read from the sibling checkout (`../reiwa` next to
 * this repo), as `system-screens.reiwa.parity.test.ts` does, and only that
 * half skips without it: CI for this repo has no reiwa working tree. A
 * checkout where the file has moved FAILS, naming the path.
 *
 * A zone OFF the list is named by its offset, and that is written one way
 * too: «UTC+5», «UTC+5:30», «UTC-3» (an ASCII minus, minutes only when there
 * are some). That half compares what the three actually print, not their
 * source — the server's notice words and this line are imported (a test may
 * reach across the package boundary, as `panel-traffic-limit-parity.test.ts`
 * does), the cabinet's `zonePhrase` is imported from the sibling checkout.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { buildAddOnFacts } from '../../../../src/modules/notifications/utils/subscription-facts.util'

import { trafficAddOnLine } from './traffic-add-on-line'

const PANEL_ROOT = join(__dirname, '..', '..', '..', '..')
const NOTICES = join(PANEL_ROOT, 'src', 'modules', 'notifications', 'utils', 'subscription-facts.util.ts')
const USER_CARD = join(__dirname, 'traffic-add-on-line.ts')
const REIWA = join(PANEL_ROOT, '..', '..', 'reiwa')
const CABINET = join(REIWA, 'web', 'src', 'lib', 'operator-zone.ts')
const hasSibling = existsSync(REIWA)

/**
 * The cabinet's `operator-zone.ts`, compiled and run here. It cannot be
 * imported: Vite's module runner serves files under this project's root only
 * (a sibling repository's path, `file://` URL or `/@fs/` it cannot find), and
 * the test context has no native `import()`. The file imports nothing, so its
 * transpiled text is the whole module.
 */
function loadCabinetZones(): { zonePhrase: (zone: string, at: Date, language: string | undefined) => string } {
  const { outputText } = ts.transpileModule(readFileSync(CABINET, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  })
  const exports: Record<string, unknown> = {}
  new Function('exports', outputText)(exports)
  expect(typeof exports['zonePhrase'], `${CABINET}: no zonePhrase export`).toBe('function')
  return exports as ReturnType<typeof loadCabinetZones>
}

/**
 * `ZONE_PHRASE_RU` of one source file, as zone → phrase. Every non-blank,
 * non-comment line of the literal must be an entry this reader understood: a
 * line it could not read fails here, instead of quietly shrinking the list
 * (two lists shrunk alike would still compare equal).
 */
function zonePhrasesIn(path: string): Record<string, string> {
  const source = readFileSync(path, 'utf8')
  const block = /const ZONE_PHRASE_RU\b[^=]*=\s*\{([\s\S]*?)\n\}/.exec(source)
  expect(block, `${path}: no ZONE_PHRASE_RU literal`).not.toBeNull()
  const body = block?.[1] ?? ''
  const entries = [...body.matchAll(/(['"])([^'"\n]+)\1\s*:\s*(['"])([^'"\n]+)\3\s*,?/g)].map(
    (match) => [match[2], match[4]] as const,
  )
  const lines = body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('//'))
  expect(entries.length, `${path}: a line of ZONE_PHRASE_RU this reader cannot read`).toBe(lines.length)
  return Object.fromEntries(entries)
}

/** Remnawave's MONTH reset on 01.10 — the moment every sentence below names a zone for. */
const RESET = '2026-10-01T00:20:00.000Z'

/**
 * Zones off the list, each offset shape once: whole hours east and west, half
 * and three-quarter hours, and a zone whose offset has minutes WEST of UTC.
 */
const OFF_LIST = ['Asia/Dubai', 'America/Sao_Paulo', 'Asia/Kolkata', 'Asia/Kathmandu', 'America/St_Johns']

/** How the bot's notice names `zone` at the reset — «по Москве», «(UTC+5:30)» — without its parentheses. */
function noticeZone(zone: string, language: 'ru' | 'en'): string {
  const facts = buildAddOnFacts({ type: 'EXTRA_TRAFFIC', total: 10, endsAt: RESET, resetAt: RESET, timezone: zone }, language)
  return (facts['resetZone'] ?? '').replace(/^\((.*)\)$/u, '$1')
}

/** How the operator's user card names `zone` at the reset: the parentheses its line ends with. */
function userCardZone(zone: string, language: 'ru' | 'en'): string {
  const line = trafficAddOnLine({ totalGb: 10, items: [{ gb: 10, endsAt: RESET, resetAt: RESET }] }, zone, language, (key) => key)
  return /\(([^()]*)\)$/u.exec(line ?? '')?.[1] ?? `no zone in ${line}`
}

describe('the Russian zone names: the bot’s notices and the operator’s user card', () => {
  it('name the same zones the same way', () => {
    const notices = zonePhrasesIn(NOTICES)
    // Anti-vacuity: the list is there, and it is the list.
    expect(notices['Europe/Moscow']).toBe('по Москве')
    expect(zonePhrasesIn(USER_CARD)).toEqual(notices)
  })

  it('both say «по UTC» for the UTC clock', () => {
    for (const path of [NOTICES, USER_CARD]) expect(readFileSync(path, 'utf8'), path).toMatch(/['"]по UTC['"]/)
  })

  it('write a zone off the list by the same offset: «UTC+5», «UTC+5:30», «UTC-3»', () => {
    for (const zone of OFF_LIST) {
      for (const language of ['ru', 'en'] as const) {
        expect(userCardZone(zone, language), `${zone} (${language})`).toBe(noticeZone(zone, language))
      }
    }
    // The shape itself, spelled out: were both sides wrong alike, the
    // comparison above would still pass.
    expect(noticeZone('Asia/Kolkata', 'ru')).toBe('UTC+5:30')
    expect(noticeZone('America/Sao_Paulo', 'ru')).toBe('UTC-3')
    expect(noticeZone('Asia/Dubai', 'ru')).toBe('UTC+4')
    // Listed zones and UTC agree as well.
    expect(userCardZone('Europe/Moscow', 'ru')).toBe('по Москве')
    expect(userCardZone('UTC', 'ru')).toBe(noticeZone('UTC', 'ru'))
  })
})

describe.skipIf(!hasSibling)('the Russian zone names: the cabinet, against the bot’s notices', () => {
  it('finds the cabinet’s copy where this test reads it', () => {
    expect(existsSync(CABINET), `${CABINET} moved in reiwa — point this test at its new place`).toBe(true)
  })

  it('names the same zones the same way', () => {
    expect(zonePhrasesIn(CABINET)).toEqual(zonePhrasesIn(NOTICES))
  })

  it('says «по UTC» for the UTC clock', () => {
    expect(readFileSync(CABINET, 'utf8')).toMatch(/['"]по UTC['"]/)
  })

  it('writes a zone off the list by the same offset as the bot’s notice', () => {
    const cabinet = loadCabinetZones()
    for (const zone of [...OFF_LIST, 'Europe/Moscow', 'UTC']) {
      for (const language of ['ru', 'en'] as const) {
        expect(cabinet.zonePhrase(zone, new Date(RESET), language), `${zone} (${language})`).toBe(noticeZone(zone, language))
      }
    }
  })
})
