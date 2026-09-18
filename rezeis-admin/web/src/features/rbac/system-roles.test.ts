/**
 * What a system role is shown as, and what is stored when it is saved.
 *
 * Two promises, each of which failed once:
 *   - the name on screen is never a key path, even where no dictionary has
 *     arrived — the Administrators page names roles without waiting for one;
 *   - what is stored is what the operator TYPED, never the translation that
 *     was on screen while they did not touch the field.
 */
import { createInstance, type TFunction } from 'i18next'
import { beforeAll, describe, expect, it } from 'vitest'

import { descriptionToStore, nameToStore, roleDescription, roleDisplayName } from './system-roles'

const SEED = 'Повседневные операции: пользователи, подписки, платежи, поддержка, рассылки.'

const operator = {
  name: 'operator',
  isSystem: true,
  displayName: 'Operator',
  description: SEED,
}

let noWords: TFunction
let russian: TFunction

beforeAll(async () => {
  const empty = createInstance()
  await empty.init({ lng: 'en', fallbackLng: 'en', resources: {} })
  noWords = empty.t

  const ru = createInstance()
  await ru.init({
    lng: 'ru',
    resources: {
      ru: {
        translation: {
          rolesPage: {
            systemRoles: { operator: { name: 'Оператор', description: 'Повседневная работа.' } },
          },
        },
      },
    },
  })
  russian = ru.t
})

describe('a system role on screen', () => {
  it('reads as stored, never as a key path, when no dictionary has arrived', () => {
    expect(roleDisplayName(noWords, operator)).toBe('Operator')
    expect(roleDescription(noWords, operator)).toBe(SEED)
  })

  it('reads in the dictionary’s words while untouched, and as renamed once renamed', () => {
    expect(roleDisplayName(russian, operator)).toBe('Оператор')
    expect(roleDisplayName(russian, { ...operator, displayName: 'Дежурные' })).toBe('Дежурные')
  })
})

describe('a system role saved', () => {
  it('stores its own text for a field the operator did not touch', () => {
    expect(nameToStore(russian, operator, null)).toBe('Operator')
    expect(descriptionToStore(russian, operator, null)).toBe(SEED)
  })

  it('stores its own text for a field touched and left as it was shown', () => {
    expect(nameToStore(russian, operator, ' Оператор ')).toBe('Operator')
    expect(descriptionToStore(russian, operator, 'Повседневная работа.')).toBe(SEED)
  })

  it('stores what the operator typed, trimmed, and null for an emptied description', () => {
    expect(nameToStore(russian, operator, '  Дежурные ')).toBe('Дежурные')
    expect(descriptionToStore(russian, operator, ' Своё ')).toBe('Своё')
    expect(descriptionToStore(russian, operator, '   ')).toBeNull()
  })
})
