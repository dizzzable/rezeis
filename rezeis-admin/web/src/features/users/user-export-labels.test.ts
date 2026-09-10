import { readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { ru } from '@/i18n/ru'
import { en } from '@/i18n/en'

/**
 * EVERY COLUMN THE SERVER SERVES HAS A NAME AN OPERATOR CAN READ.
 *
 * The dialog draws whatever the catalogue endpoint returns and labels each box
 * with `t(\`usersPage.export.columns.${id}\`)` — a computed key, which every
 * static check in this repository is blind to. So a column added on the server
 * and forgotten here does not fail a build: it renders in the dialog as the
 * literal string `usersPage.export.columns.device_models`, next to a checkbox
 * that works.
 *
 * The bundle-parity guard cannot catch it either. Parity compares ru against
 * en, and a key missing from BOTH is perfectly symmetrical.
 *
 * So this reads the catalogue out of the SERVER'S source — the two halves ship
 * in one image and nothing else compares them — and checks both bundles.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const CATALOG = readFileSync(
  resolve(HERE, '../../../../src/modules/users/utils/user-export.catalog.ts'),
  'utf8',
)

/** `{ id: 'reiwa_id', source: 'user', group: 'identity' }` → id + group. */
const ENTRIES = Array.from(
  CATALOG.matchAll(/\{\s*id:\s*'([a-z_]+)'[^}]*?group:\s*'([a-z]+)'/g),
  (match) => ({ id: match[1], group: match[2] }),
)

type Dict = Record<string, unknown>

function labels(bundle: unknown, leaf: 'columns' | 'groups'): Record<string, string> {
  const page = (bundle as Dict)['usersPage'] as Dict
  const exportBlock = page['export'] as Dict
  return (exportBlock[leaf] ?? {}) as Record<string, string>
}

describe('the export column catalogue', () => {
  it('was parsed out of the server source at all', () => {
    // Anti-emptiness anchor. A regex that stopped matching would make every
    // loop below pass by iterating nothing — which is this file agreeing that
    // zero columns are all correctly labelled.
    expect(ENTRIES.length).toBeGreaterThan(30)
  })

  it('has a Russian and an English name for every column', () => {
    const missing: string[] = []
    for (const entry of ENTRIES) {
      if ((labels(ru, 'columns')[entry.id] ?? '').trim().length === 0) {
        missing.push(`ru: ${entry.id}`)
      }
      if ((labels(en, 'columns')[entry.id] ?? '').trim().length === 0) {
        missing.push(`en: ${entry.id}`)
      }
    }

    expect(missing).toEqual([])
  })

  it('has a name for every group the columns sit in', () => {
    const groups = [...new Set(ENTRIES.map((entry) => entry.group))]
    const missing: string[] = []
    for (const group of groups) {
      if ((labels(ru, 'groups')[group] ?? '').trim().length === 0) missing.push(`ru: ${group}`)
      if ((labels(en, 'groups')[group] ?? '').trim().length === 0) missing.push(`en: ${group}`)
    }

    expect(groups.length).toBeGreaterThan(4)
    expect(missing).toEqual([])
  })

  it('labels nothing the server does not serve', () => {
    // The other direction, and it is not tidiness: a label with no column is a
    // column that WAS served and is not any more, and the dialog has quietly
    // stopped offering something an operator may still be looking for.
    const known = new Set(ENTRIES.map((entry) => entry.id))
    const orphans = Object.keys(labels(ru, 'columns')).filter((id) => !known.has(id))

    expect(orphans).toEqual([])
  })

  it('names the client column after the apps an operator would recognise', () => {
    // `device_apps` is the column the whole request was about, and its value is
    // parsed out of Remnawave's User-Agent. "Приложение" alone would leave an
    // operator guessing which of the several app-ish columns it is.
    expect(labels(ru, 'columns')['device_apps']).toMatch(/Happ/)
    expect(labels(en, 'columns')['device_apps']).toMatch(/Happ/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The PWA pair says what the cell actually reports
// ─────────────────────────────────────────────────────────────────────────────

/**
 * "APP INSTALLED (PWA)" WAS A CLAIM THE VALUE DOES NOT MAKE.
 *
 * The cell is `pwaInstalledAt !== null`, and that timestamp is stamped ONCE —
 * `updateMany({ where: { id, pwaInstalledAt: null }, data: { pwaInstalledAt:
 * now } })` on a session report whose surface is `pwa` — and cleared by
 * nothing, ever. So the column answers "did this customer ever open the
 * cabinet from the installed app", and the old labels answered "is the app
 * installed on their phone right now". Two different questions with the same
 * `yes`: it read `yes` for ever for somebody who uninstalled the app the same
 * afternoon, and for somebody browsing from Safari today.
 *
 * ── Why this suite reads the server and not the sentences ────────────────────
 *
 * A test that asserted `pwa_installed === 'Ever opened from the installed app
 * (PWA)'` would pass for ever and guard nothing: it agrees with whatever is in
 * the bundle on the day it is written, including the wrong thing. This repo
 * has a documented run of eight such tests and one was deleted this session.
 *
 * So every fact below is READ — the derivation out of `user-export.util.ts`,
 * the write-once guard out of `internal-user-edge.service.ts`, and the absence
 * of a clearing write out of the whole server tree — and only then is the copy
 * asked whether it agrees. Change the derivation to something that genuinely
 * reports a present state and the FACT tests fail first, by name, telling
 * whoever did it that the labels are now the thing to revisit.
 */

const SERVER = resolve(HERE, '../../../../src')
const UTIL = readFileSync(resolve(SERVER, 'modules/users/utils/user-export.util.ts'), 'utf8')
const WRITER = readFileSync(
  resolve(SERVER, 'modules/internal-user/services/internal-user-edge.service.ts'),
  'utf8',
)

/** `case 'pwa_installed': return yesNo(…)` → id → the expression it returns. */
const CELL = new Map(
  Array.from(
    UTIL.matchAll(/case '([a-z_]+)':([\s\S]*?)(?=\n\s*case '|\n\s*default:)/g),
    (match): [string, string] => [match[1], (/return ([^;]+);/.exec(match[2])?.[1] ?? '').trim()],
  ),
)

/** Every `.ts` under `src/`, so "nothing clears it" can be a scan, not a hope. */
function serverSources(dir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name)
    if (entry.isDirectory()) out.push(...serverSources(path))
    else if (entry.name.endsWith('.ts')) out.push({ path, text: readFileSync(path, 'utf8') })
  }
  return out
}

const SOURCES = serverSources(SERVER)

/**
 * The customer DID something. Both labels have to name that act, because the
 * util derives both cells from one column and that column is a record of an
 * act — not a property of a device the server has never been able to see.
 */
const ACT = {
  en: /\b(open|opens|opened|launch|launches|launched|use|uses|used|start|starts|started)\b/i,
  ru: /(откры[а-яё]*|запуск[а-яё]*|заход[а-яё]*|польз[а-яё]*)/i,
}

/**
 * The PREDICATE form of "installed" — the form that claims a state holding
 * now. Both languages mark it, and both leave the attributive form alone:
 * "the installed app" / "из установленного приложения" says which app was
 * opened and claims nothing about today. In Russian that distinction is the
 * grammar itself — short participle `установлено` is the predicate, long
 * `установленного` is the modifier.
 */
const STATE_CLAIM = {
  en: /\binstalled\b(?!\s+(app|application|pwa)\b)/i,
  ru: /установлен(о|а|ы)?(?![а-яё])/i,
}

/**
 * The boolean is "ever", so the label has to be scoped in time: an adverb in
 * English, the past tense itself in Russian.
 *
 * `\b` is deliberately absent from the Russian side — JavaScript defines a
 * word boundary against `[A-Za-z0-9_]`, so there is no boundary anywhere in a
 * Cyrillic word and `/…ал\b/` matches nothing at all. That is a silently
 * vacuous regex, which is the shape of guard this suite exists to avoid.
 */
const EVER = { en: /\b(ever|once)\b/i, ru: /[а-яё]+(ал|ял|ыл|ил)(?![а-яё])/i }

/** The timestamp is the FIRST one, because the writer refuses to overwrite. */
const FIRST = { en: /\bfirst\b/i, ru: /(впервые|перв[а-яё]*)/i }

const LANGS = [
  { lng: 'en' as const, bundle: en as unknown },
  { lng: 'ru' as const, bundle: ru as unknown },
]

function label(bundle: unknown, id: string): string {
  return labels(bundle, 'columns')[id] ?? ''
}

describe('what the pwa_installed cell actually reports', () => {
  it('is a null-test on a timestamp, not a flag the server stores', () => {
    // Anti-emptiness anchor first: a switch this stopped parsing would make
    // every derived expectation below assert against an empty string.
    expect(CELL.size).toBeGreaterThan(30)

    const boolean = CELL.get('pwa_installed') ?? ''
    const stamp = CELL.get('pwa_installed_at') ?? ''
    expect(boolean, 'the cell is no longer derived from a timestamp').toMatch(
      /yesNo\(\s*row\.(\w+At)\s*!==\s*null/,
    )

    // And the two columns are ONE fact in two shapes — which is why the two
    // labels below are held to naming one event between them.
    const field = /row\.(\w+At)\s*!==\s*null/.exec(boolean)?.[1]
    expect(field).toBe('pwaInstalledAt')
    expect(stamp).toContain(`row.${field ?? ''}`)
  })

  it('is stamped once and cleared by nothing in the whole server tree', () => {
    // The `where` is the once-only guard: a row that already has the stamp
    // matches nothing, so the first open wins for ever.
    expect(WRITER, 'the write-once guard is gone from recordSurfaceSeen').toMatch(
      /where:\s*\{[^}]*\bpwaInstalledAt:\s*null\b[^}]*\}/,
    )
    expect(WRITER).toMatch(/data:\s*\{\s*pwaInstalledAt:\s*(?!null)\w+/)

    // Anti-emptiness anchor for the scan, then the scan: every line in the
    // repository that puts `pwaInstalledAt` next to `null` is a WHERE — a
    // filter. The day one of them is a `data:`, the column starts meaning
    // "installed right now" and these labels become the wrong ones.
    expect(SOURCES.length).toBeGreaterThan(200)
    const nulled = SOURCES.flatMap(({ path, text }) =>
      Array.from(text.matchAll(/^.*\bpwaInstalledAt:\s*null\b.*$/gm), (m) => ({
        where: `${path.split(/[/\\]/).pop() ?? path}: ${m[0].trim()}`,
        line: m[0],
      })),
    )
    expect(nulled.length, 'nothing mentions the stamp any more — has it been renamed?')
      .toBeGreaterThan(0)
    for (const hit of nulled) {
      expect(hit.line, `clears the stamp — ${hit.where}`).toMatch(/where:/)
    }
  })
})

describe('the PWA column labels, against that', () => {
  it('names the act the customer performed, not a state of their device', () => {
    for (const { lng, bundle } of LANGS) {
      for (const id of ['pwa_installed', 'pwa_installed_at']) {
        expect(label(bundle, id), `${lng}: ${id} names no act`).toMatch(ACT[lng])
      }
    }
  })

  it('never asserts the app is installed right now', () => {
    // The server has never observed an install and cannot observe an
    // uninstall: it sees a cabinet session reporting `surface: 'pwa'`. A label
    // in the present tense is a claim made out of nothing.
    for (const { lng, bundle } of LANGS) {
      for (const id of ['pwa_installed', 'pwa_installed_at']) {
        expect(label(bundle, id), `${lng}: ${id} claims a present state`).not.toMatch(
          STATE_CLAIM[lng],
        )
      }
    }
  })

  it('scopes the boolean in time, because the stamp is never cleared', () => {
    for (const { lng, bundle } of LANGS) {
      expect(label(bundle, 'pwa_installed'), `${lng}: reads as "now", not "ever"`).toMatch(
        EVER[lng],
      )
    }
  })

  it('calls the timestamp the first one, because the writer refuses to overwrite', () => {
    // Not "when they last opened it" and not "when they installed it": the
    // `updateMany` above only ever matches a row that has no stamp yet.
    for (const { lng, bundle } of LANGS) {
      expect(label(bundle, 'pwa_installed_at'), `${lng}: does not say which open`).toMatch(
        FIRST[lng],
      )
    }
  })

  it('names ONE event across the pair, the way the util derives one column', () => {
    // Half a repair is its own defect: a boolean that says "opened" beside a
    // timestamp that says "installed" leaves the operator with two columns
    // they think are about different things.
    for (const { lng, bundle } of LANGS) {
      const first = ACT[lng].exec(label(bundle, 'pwa_installed'))?.[0].toLowerCase() ?? ''
      const second = ACT[lng].exec(label(bundle, 'pwa_installed_at'))?.[0].toLowerCase() ?? ''
      let shared = 0
      while (shared < first.length && shared < second.length && first[shared] === second[shared]) {
        shared += 1
      }
      expect(shared, `${lng}: "${first}" and "${second}" are different events`)
        .toBeGreaterThanOrEqual(4)
    }
  })
})
