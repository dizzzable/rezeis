import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { HINT_TEMPLATES, buildHint } from './hint-templates'
import { ru } from '@/i18n/features/automations.ru'

/**
 * Every ready-made pop-up, against the contract the panel API enforces on it.
 *
 * WHY THIS FILE EXISTS. All eight templates shipped unusable. Pressing
 * "Use" on any of them answered "could not create the pop-up" and nothing
 * else, because the payload they build is refused by `UpsertUserHintDto`
 * before it reaches the database — and three separate rules refused it:
 *
 *   - every key was `tpl.payment_failed` shaped, and the server accepts
 *     lower-case letters, digits and HYPHENS. A dot and an underscore, eight
 *     times over.
 *   - two asked for `TOAST`, which the cabinet does not draw and the panel
 *     therefore does not accept.
 *   - two pointed their button at `/subscription/connect`, a real cabinet
 *     route that was missing from the panel's curated list.
 *
 * `hint-templates.test.ts` beside this file was green the whole time, and
 * correctly so: it checks that the templates agree with THEMSELVES — that the
 * rule names the hint the template just built. Nothing there, and nothing in
 * the type system, knew what the server would accept. The templates are data
 * in one package validated by decorators in another, and the only test that
 * can catch that is one that reads the other side.
 *
 * REACHING ACROSS THE PACKAGE BOUNDARY is the established way to do that here
 * — see `features/rbac/rbac-catalog-parity.test.ts`, which does the same for
 * the RBAC catalog. The contracts are PARSED OUT OF THE SERVER SOURCE rather
 * than restated, so a copy of them cannot drift; and each parse asserts it
 * found something, so a rename over there fails this file loudly instead of
 * quietly checking nothing.
 */

const DTO = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    '..',
    'src',
    'modules',
    'user-hints',
    'dto',
    'user-hint.dto.ts',
  ),
  'utf8',
)

/** Comments quote route names in prose; only the code is the contract. */
const DTO_CODE = DTO.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

function arrayLiteral(name: string): string[] {
  const start = DTO_CODE.indexOf(`export const ${name} = [`)
  expect(start, `${name} is no longer declared the way this test reads it`).toBeGreaterThan(-1)
  const end = DTO_CODE.indexOf(']', start)
  const body = DTO_CODE.slice(start, end)
  const found = [...body.matchAll(/'([^']+)'/g)].map((match) => match[1]!)
  expect(found.length, `${name} parsed empty`).toBeGreaterThan(0)
  return found
}

const ROUTE_TARGETS = arrayLiteral('HINT_ROUTE_TARGETS')

const RENDERABLE_MODES = (() => {
  const line = /RENDERABLE_HINT_MODES[^=]*=\s*\[([^\]]*)\]/.exec(DTO_CODE)
  expect(line, 'RENDERABLE_HINT_MODES is no longer declared the way this test reads it').not.toBeNull()
  const found = [...line![1]!.matchAll(/UserHintMode\.([A-Z_]+)/g)].map((match) => match[1]!)
  expect(found.length, 'RENDERABLE_HINT_MODES parsed empty').toBeGreaterThan(0)
  return found
})()

const KEY_PATTERN = (() => {
  const match = /@Matches\((\/[^/]+\/)[,)]/.exec(DTO_CODE)
  expect(match, 'the key pattern is no longer declared the way this test reads it').not.toBeNull()
  const [body, flags] = [match![1]!.slice(1, -1), '']
  return new RegExp(body, flags)
})()

function bound(field: string): { min: number; max: number } {
  const match = new RegExp(`@Length\\((\\d+),\\s*(\\d+)\\)[\\s\\S]{0,120}?\\b${field}\\??!?:`).exec(
    DTO_CODE,
  )
  expect(match, `no @Length found for ${field}`).not.toBeNull()
  return { min: Number(match![1]), max: Number(match![2]) }
}

const TITLE = bound('titleRu')
const BODY = bound('bodyRu')
const CTA = bound('ctaLabelRu')

const text = (key: string): string => {
  const path = key.split('.').slice(1)
  let node: unknown = ru.automationsPage
  for (const step of path) node = (node as Record<string, unknown>)[step]
  return typeof node === 'string' ? node : key
}

describe('every template is a payload the panel API accepts', () => {
  it('uses keys the server can store', () => {
    // The defect that made all eight unusable. `tpl.payment_failed` carries a
    // dot and an underscore; the server takes neither.
    for (const template of HINT_TEMPLATES) {
      expect(template.hintKey, `${template.id}: key rejected by the server pattern`).toMatch(
        KEY_PATTERN,
      )
    }
  })

  it('asks only for modes the cabinet draws', () => {
    // Not "modes the enum has". The cabinet skips anything that is not MODAL
    // (`hint-controller.tsx`), so a mode it cannot draw is a hint that is
    // stored, fired, and shown to nobody — if the panel let it be stored,
    // which it does not.
    for (const template of HINT_TEMPLATES) {
      expect(RENDERABLE_MODES, `${template.id}: mode ${template.mode}`).toContain(template.mode)
    }
  })

  it('points its button at a route the panel knows', () => {
    for (const template of HINT_TEMPLATES) {
      if (template.route === null) continue
      expect(ROUTE_TARGETS, `${template.id}: route ${template.route}`).toContain(template.route)
    }
  })

  it('writes text that fits the columns it goes into', () => {
    for (const template of HINT_TEMPLATES) {
      const hint = buildHint(template, text)
      for (const [field, value, limits] of [
        ['titleRu', hint.titleRu, TITLE],
        ['bodyRu', hint.bodyRu, BODY],
      ] as const) {
        expect(value.length, `${template.id}.${field} is empty`).toBeGreaterThanOrEqual(limits.min)
        expect(value.length, `${template.id}.${field} is too long`).toBeLessThanOrEqual(limits.max)
      }
      if (hint.ctaLabelRu !== undefined) {
        expect(hint.ctaLabelRu.length, `${template.id}.ctaLabelRu`).toBeLessThanOrEqual(CTA.max)
      }
    }
  })

  it('keeps every hint inside the server ttl window', () => {
    // One hour to ninety days, from the DTO's own @Min/@Max.
    const window = /@Min\((\d+)\)[\s\S]{0,120}?@Max\(([^)]+)\)[\s\S]{0,120}?ttlHours/.exec(DTO_CODE)
    expect(window, 'the ttl window is no longer declared the way this test reads it').not.toBeNull()
    // The ceiling is written as `24 * 90` over there, so the captured text is
    // a product rather than a literal. Multiplied out here rather than eval'd.
    const max = window![2]!
      .split('*')
      .map((part) => Number(part.trim()))
      .reduce((product, factor) => product * factor, 1)
    expect(Number.isFinite(max), 'the ttl ceiling did not parse as a number').toBe(true)
    for (const template of HINT_TEMPLATES) {
      expect(template.ttlHours).toBeGreaterThanOrEqual(Number(window![1]))
      expect(template.ttlHours).toBeLessThanOrEqual(max)
    }
  })
})
