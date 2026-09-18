/**
 * What an action needs beyond the automations permissions, as the editor reads it.
 *
 * The map itself is the server's (`GET /admin/automations/catalog`); what lives
 * here is the reading of it — which permissions a set of actions lacks — and the
 * names those permissions are shown under. The names travel in the automations
 * bundle so no second bundle has to load first, which makes them a COPY of the
 * roles page's own wording: the last block holds them to it, in both languages,
 * for every permission the server's map can name.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createInstance, type TFunction } from 'i18next'
import { describe, expect, it } from 'vitest'

import { en } from '@/i18n/features/automations.en'
import { ru } from '@/i18n/features/automations.ru'
import { en as rbacEn } from '@/i18n/features/rbac.en'
import { ru as rbacRu } from '@/i18n/features/rbac.ru'

import { missingPermissionsForActions, permissionList, permissionName } from './action-permissions'
import { ACTION_LABEL_KEYS } from './rule-action-labels'

const HERE = dirname(fileURLToPath(import.meta.url))
/** `web/src/features/automations` → the repository root beside `src/`. */
const REPO = resolve(HERE, '..', '..', '..', '..')
const SERVER_MAP_PATH = resolve(REPO, 'src', 'modules', 'automations', 'automation-action-permissions.ts')

function translator(lng: 'en' | 'ru'): TFunction {
  const i18n = createInstance()
  void i18n.init({
    lng,
    fallbackLng: 'en',
    resources: {
      en: { translation: { ...(en as unknown as Record<string, unknown>), ...(rbacEn as unknown as Record<string, unknown>) } },
      ru: { translation: { ...(ru as unknown as Record<string, unknown>), ...(rbacRu as unknown as Record<string, unknown>) } },
    },
    interpolation: { escapeValue: false },
    initAsync: false,
  })
  return i18n.t.bind(i18n) as TFunction
}

const MAP = {
  notify_telegram: [],
  webhook_post: [{ resource: 'webhooks', action: 'create' }],
  block_ip: [{ resource: 'blocked_ips', action: 'create' }],
  block_user: [{ resource: 'users', action: 'edit' }],
}

describe('reading the map', () => {
  const holdsOnly = (...tokens: string[]) => (resource: string, action: string) => tokens.includes(`${resource}:${action}`)

  it('names what is missing, once each, in the order first needed', () => {
    const missing = missingPermissionsForActions(
      [{ type: 'block_user' }, { type: 'notify_telegram' }, { type: 'block_ip' }, { type: 'block_ip' }, { type: 'webhook_post' }],
      MAP,
      holdsOnly('webhooks:create'),
    )
    expect(missing).toEqual([
      { resource: 'users', action: 'edit' },
      { resource: 'blocked_ips', action: 'create' },
    ])
  })

  it('names nothing an admin holds, nothing for an action that needs nothing, and nothing for a type it does not know', () => {
    expect(missingPermissionsForActions([{ type: 'block_ip' }], MAP, holdsOnly('blocked_ips:create'))).toEqual([])
    expect(missingPermissionsForActions([{ type: 'notify_telegram' }], MAP, holdsOnly())).toEqual([])
    expect(missingPermissionsForActions([{ type: 'frobnicate' }, { type: 'toString' }], MAP, holdsOnly())).toEqual([])
  })

  it('names nothing without a map — a panel too old to send one still refuses on its own', () => {
    expect(missingPermissionsForActions([{ type: 'block_ip' }], undefined, holdsOnly())).toEqual([])
  })
})

/** Every `{ resource, action }` the server's map names, read out of its source. */
function serverMapPermissions(): Array<{ resource: string; action: string }> {
  const source = readFileSync(SERVER_MAP_PATH, 'utf8')
  const start = source.indexOf('export const AUTOMATION_ACTION_PERMISSIONS')
  expect(start, 'AUTOMATION_ACTION_PERMISSIONS is gone from the server — this parse needs rewriting').toBeGreaterThan(-1)
  const body = source.slice(start, source.indexOf('};', start))
  const found = [...body.matchAll(/\{ resource: '([a-z_]+)', action: '([a-z_]+)' \}/g)].map((match) => ({
    resource: match[1],
    action: match[2],
  }))
  // Anchor: an empty parse must fail, not compare nothing with nothing.
  expect(found.length, 'no permission parsed out of AUTOMATION_ACTION_PERMISSIONS').toBeGreaterThanOrEqual(3)
  return found
}

/** Every action type the server's map has a row for. */
function serverMapTypes(): string[] {
  const source = readFileSync(SERVER_MAP_PATH, 'utf8')
  const start = source.indexOf('export const AUTOMATION_ACTION_PERMISSIONS')
  const body = source.slice(start, source.indexOf('};', start))
  const types = [...body.matchAll(/^\s{2}([a-z_]+): \[/gm)].map((match) => match[1])
  expect(types.length, 'no action type parsed out of AUTOMATION_ACTION_PERMISSIONS').toBeGreaterThanOrEqual(7)
  return types
}

/** The route permissions of the automations screen — the ones `RbacGuard` names. */
const ROUTE_PERMISSIONS = ['view', 'create', 'edit', 'delete', 'run'].map((action) => ({ resource: 'automations', action }))

describe('the names a permission is shown under', () => {
  it.each(['en', 'ru'] as const)('are the roles page’s own, for every permission the server can ask for (%s)', (lng) => {
    const t = translator(lng)
    for (const permission of [...serverMapPermissions(), ...ROUTE_PERMISSIONS]) {
      const rolesPage = `${String(t(`rolesPage.resources.${permission.resource}.name`))}: ${String(
        t(`rolesPage.actions.${permission.action}.name`),
      )}`
      expect(rolesPage, `${permission.resource}:${permission.action} has no name on the roles page`).not.toMatch(/rolesPage\./)
      expect(permissionName(t, permission), `${permission.resource}:${permission.action}`).toBe(rolesPage)
    }
  })

  it('falls back to the raw token, never to a key path, for a permission this bundle has no name for', () => {
    // Through a variable: `rbac-catalog-parity.test.ts` scans every file for a
    // literal `resource: '…', action: '…'` and holds it to the server catalogue,
    // and this one is made up on purpose.
    const unknownResource = 'newthing'
    expect(permissionName(translator('ru'), { resource: unknownResource, action: 'frob' })).toBe('newthing:frob')
  })

  it('quotes a list the way the page quotes a name', () => {
    expect(
      permissionList(translator('ru'), [
        { resource: 'blocked_ips', action: 'create' },
        { resource: 'users', action: 'edit' },
      ]),
    ).toBe('«Заблокированные IP: Создание», «Пользователи: Изменение»')
  })

  it('has a label for every action type the server’s map knows', () => {
    for (const type of serverMapTypes()) {
      expect(Object.hasOwn(ACTION_LABEL_KEYS, type), type).toBe(true)
    }
  })
})

describe('what the roles page tells an owner about «Automations: Create»', () => {
  // The sentence an owner reads when deciding who may write rules. It used to
  // say a rule could block any address and send data anywhere WITHOUT the
  // blocklist or webhook permissions; it now names what a rule's actions need
  // instead, so every permission the server's map can ask for must be named
  // in it — read off the map, so a new entry there makes this say so.
  it.each(['en', 'ru'] as const)('names every permission a rule’s actions can need (%s)', (lng) => {
    const t = translator(lng)
    const sentence = String(t('rolesPage.resources.automations.actions.create'))
    expect(sentence).not.toMatch(/rolesPage\./)
    for (const permission of serverMapPermissions()) {
      const name = `${String(t(`rolesPage.resources.${permission.resource}.name`))}: ${String(
        t(`rolesPage.actions.${permission.action}.name`),
      )}`
      expect(sentence, `${permission.resource}:${permission.action}`).toContain(name)
    }
  })
})
