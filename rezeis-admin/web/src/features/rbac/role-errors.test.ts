/**
 * The server's refusals on the roles page, as the operator reads them.
 *
 * `role-errors.ts` recognises sentences by their exact wording, so one changed
 * word on the server sends the operator back to English. Every sentence below
 * is therefore READ from where the backend writes it — `rbac.service.ts`,
 * `rbac.guard.ts`, `upsert-admin-role.dto.ts`, and class-validator's own
 * `Length` messages with the DTO's own limits — never retyped. A rewording on
 * the server turns this file red instead of the page silently English.
 *
 * class-validator's two sentences come from the server's pinned copy,
 * `test/fixtures/class-validator-length-messages.json`, not from the package:
 * the SPA's CI job installs only `web/`, so the server's `node_modules` is not
 * there. The server's `class-validator-length-messages.spec.ts` holds that copy
 * to the installed package, so a reworded class-validator still turns red.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { coreDictionaryReady, i18n, loadFeatureBundle } from '@/i18n/i18n'

import { translateRoleError } from './role-errors'

const HERE = dirname(fileURLToPath(import.meta.url))
const ADMIN_ROOT = resolve(HERE, '..', '..', '..', '..')
const RBAC = join(ADMIN_ROOT, 'src', 'modules', 'rbac')

function source(path: string): string {
  return readFileSync(path, 'utf8')
}

/**
 * The string or template literal of `file` that contains `fragment`, as
 * written. The backend writes its messages in single quotes or backticks; a
 * double quote inside one is text (`Role with name "…"`).
 */
function literalWith(file: string, fragment: string): string {
  const text = source(join(RBAC, file))
  const at = text.indexOf(fragment)
  if (at < 0) throw new Error(`${file} no longer contains "${fragment}"`)
  let open = at
  while (open > 0 && text[open - 1] !== "'" && text[open - 1] !== '`') open -= 1
  const quote = text[open - 1]
  return text.slice(open, text.indexOf(quote, at))
}

/** A template literal's `${…}` holes, filled in order. */
function fill(template: string, ...values: string[]): string {
  let next = 0
  return template.replace(/\$\{[^}]*\}/g, () => values[next++])
}

/**
 * class-validator's message for `@Length`, from the server's pinned copy of
 * what that package writes (see the header).
 */
function lengthMessage(direction: 'longer' | 'shorter', property: string, limit: number): string {
  const pinned = JSON.parse(
    source(join(ADMIN_ROOT, 'test', 'fixtures', 'class-validator-length-messages.json')),
  ) as Partial<Record<'longer' | 'shorter', string>>
  const template = pinned[direction]
  if (template === undefined) throw new Error(`no pinned "${direction}" length message`)
  return template.replace('$property', property).replace(/\$constraint[12]/, String(limit))
}

/** The `@Length(min, max)` the DTO puts on `property`. */
function lengthOf(property: string): { readonly min: number; readonly max: number } {
  const text = source(join(RBAC, 'dto', 'upsert-admin-role.dto.ts'))
  const at = text.search(new RegExp(`\\n\\s+${property}[!?]:`))
  const decorators = [...text.slice(0, at).matchAll(/@Length\((\d+),\s*(\d+)\)/g)]
  const last = decorators.at(-1)
  if (last === undefined) throw new Error(`no @Length above ${property}`)
  return { min: Number(last[1]), max: Number(last[2]) }
}

function refusal(message: string | string[], status = 400): unknown {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: { status, data: { statusCode: status, message } },
  })
}

async function speak(language: 'en' | 'ru'): Promise<typeof i18n.t> {
  await i18n.changeLanguage(language)
  await Promise.all([coreDictionaryReady(language), loadFeatureBundle('rbac')])
  return i18n.t
}

afterEach(async () => {
  if (i18n.language !== 'en') await i18n.changeLanguage('en')
})

describe('translateRoleError, on the sentences the backend really writes', () => {
  it('names the missing permission the way the matrix names it', async () => {
    const t = await speak('ru')
    const sentence = fill(literalWith('guards/rbac.guard.ts', 'Missing permission: '), 'rbac_roles', 'create')
    expect(translateRoleError(t, refusal(sentence, 403))).toBe('В вашей роли нет права «Роли и права: Создание».')
  })

  it('lists every permission a save may not grant', async () => {
    const t = await speak('ru')
    const sentence = fill(
      literalWith('services/rbac.service.ts', 'Cannot grant permissions you do not hold'),
      'backups:export, users:delete',
    )
    expect(translateRoleError(t, refusal(sentence, 403))).toBe(
      'Нельзя выдать права, которых нет у вас самих: Бэкапы: Выгрузка; Пользователи: Удаление.',
    )
  })

  it('explains a taken, a reserved and a malformed identifier', async () => {
    const t = await speak('ru')
    const taken = fill(literalWith('services/rbac.service.ts', 'Role with name '), 'ops_lead')
    const reserved = fill(literalWith('services/rbac.service.ts', 'Role name '), 'finance')
    const pattern = literalWith('dto/upsert-admin-role.dto.ts', 'name must be lowercase')
    expect(translateRoleError(t, refusal(taken, 409))).toBe('Роль с идентификатором «ops_lead» уже есть.')
    expect(translateRoleError(t, refusal(reserved))).toBe('Идентификатор «finance» занят системной ролью. Выберите другой.')
    // A validation failure arrives as a LIST of sentences.
    expect(translateRoleError(t, refusal([pattern]))).toBe(
      'Идентификатор может состоять только из строчных латинских букв, цифр и «_» и должен начинаться с буквы.',
    )
  })

  it('explains the refusals of a delete', async () => {
    const t = await speak('ru')
    const service = 'services/rbac.service.ts'
    expect(translateRoleError(t, refusal(literalWith(service, 'Role not found'), 404))).toBe(
      'Этой роли больше нет — возможно, её удалили.',
    )
    expect(translateRoleError(t, refusal(literalWith(service, 'System roles cannot be deleted'), 403))).toBe(
      'Системную роль удалить нельзя.',
    )
    expect(translateRoleError(t, refusal(literalWith(service, 'Cannot delete role assigned')))).toBe(
      'Роль назначена администраторам. Сначала назначьте им другую.',
    )
  })

  it('points at the stale permission a save refused, and names a duplicate', async () => {
    const t = await speak('ru')
    const unknown = fill(literalWith('services/rbac.service.ts', 'Unknown permission: '), 'legacy_reports:view')
    const duplicate = fill(literalWith('services/rbac.service.ts', 'Duplicate permission: '), 'users:view')
    expect(translateRoleError(t, refusal(unknown))).toBe(
      'Права legacy_reports:view в панели больше нет. Уберите его кнопкой «Убрать их» над правами и сохраните роль.',
    )
    expect(translateRoleError(t, refusal(duplicate))).toBe('Право «Пользователи: Просмотр» указано дважды.')
  })

  it('says a length refusal in the form’s own words, with real plurals', async () => {
    const t = await speak('ru')
    const displayName = lengthOf('displayName')
    const name = lengthOf('name')
    const description = lengthOf('description')
    expect(
      translateRoleError(
        t,
        refusal([
          lengthMessage('longer', 'displayName', displayName.min),
          lengthMessage('shorter', 'name', name.max),
          lengthMessage('shorter', 'description', description.max),
        ]),
      ),
    ).toBe('Название: не короче 2 символов. Идентификатор: не длиннее 32 символов. Описание: не длиннее 256 символов.')
    // The limits read above are the ones the form enforces, or the sentences
    // would promise a different rule than the one being broken.
    expect([displayName, name, description]).toEqual([
      { min: 2, max: 64 },
      { min: 2, max: 32 },
      { min: 0, max: 256 },
    ])

    const en = await speak('en')
    expect(translateRoleError(en, refusal([lengthMessage('longer', 'displayName', 2)]))).toBe(
      'Name must be at least 2 characters long.',
    )
  })

  it('says a scrubbed refusal in the operator’s language', async () => {
    // What the safe exception filter puts in place of a sentence it will not
    // repeat (`admin-safe-exception.filter.ts`).
    const t = await speak('ru')
    const scrubbed = /return 'Request failed';/.test(
      source(join(ADMIN_ROOT, 'src', 'common', 'filters', 'admin-safe-exception.filter.ts')),
    )
    expect(scrubbed, 'the safe filter no longer answers with "Request failed"').toBe(true)
    expect(translateRoleError(t, refusal('Request failed'))).toBe('Запрос завершился ошибкой')
  })

  it('hands anything else to the panel’s shared lookup instead of axios’s words', async () => {
    const t = await speak('en')
    // Unknown to this page: shown as the server wrote it, never the transport prose.
    expect(translateRoleError(t, refusal('Something the page does not know'))).toBe('Something the page does not know')
    // No body at all: the shared generic, not "Request failed with status code 502".
    const bare = Object.assign(new Error('Request failed with status code 502'), {
      isAxiosError: true,
      response: { status: 502, data: '<html>bad gateway</html>' },
    })
    expect(translateRoleError(t, bare)).toBe(t('errors.requestFailed'))
  })
})
