/**
 * What the roles page tells an operator when the server refuses a request.
 *
 * The page used to interpolate `(err as Error).message`, which for every axios
 * rejection is transport prose — "Request failed with status code 403" — in
 * English, in every locale, and never the reason. The reason is in the body,
 * and for this page the server writes a handful of sentences of its own
 * (`rbac.service.ts`, `RbacGuard`, `CreateAdminRoleDto`). Those are recognised
 * here and said in the operator's language, with every permission token named
 * the way the matrix names it («Пользователи: Удаление», not `users:delete`).
 *
 * Anything else goes through the panel's shared lookup (`translate-error.ts`):
 * a sentence the dictionaries know is translated, an unknown one is shown in
 * the server's words, and a request that never reached the server gets the
 * transport copy instead of axios's jargon.
 */
import type { TFunction } from 'i18next'

import { translateApiError, translateServerSentence } from '@/lib/translate-error'

import { tokenLabel } from './permission-labels'

type SentenceRule = (t: TFunction, sentence: string) => string | null

const RULES: readonly SentenceRule[] = [
  (t, sentence) => {
    const match = /^Missing permission: ([a-z_]+:[a-z_]+)$/.exec(sentence)
    return match === null ? null : t('rolesPage.errors.missingPermission', { permission: tokenLabel(t, match[1]) })
  },
  (t, sentence) => {
    const match = /^Cannot grant permissions you do not hold: (.+)$/.exec(sentence)
    if (match === null) return null
    const permissions = match[1]
      .split(',')
      .map((token) => tokenLabel(t, token.trim()))
      .join('; ')
    return t('rolesPage.errors.cannotGrant', { permissions })
  },
  (t, sentence) => {
    const match = /^Role with name "(.+)" already exists$/.exec(sentence)
    return match === null ? null : t('rolesPage.errors.nameTaken', { name: match[1] })
  },
  (t, sentence) => {
    const match = /^Role name "(.+)" is reserved for a system role$/.exec(sentence)
    return match === null ? null : t('rolesPage.errors.nameReserved', { name: match[1] })
  },
  (t, sentence) => (sentence === 'Role not found' ? t('rolesPage.errors.notFound') : null),
  (t, sentence) =>
    sentence === 'System roles cannot be deleted' ? t('rolesPage.errors.systemUndeletable') : null,
  (t, sentence) =>
    sentence === 'Cannot delete role assigned to one or more admins' ? t('rolesPage.errors.assigned') : null,
  (t, sentence) =>
    sentence.startsWith('name must be lowercase alphanumeric') ? t('rolesPage.errors.namePattern') : null,
  // A token the catalogue no longer has: named raw, because no name exists for
  // it. The editor lists these with a button that removes them.
  (t, sentence) => {
    const match = /^Unknown permission: (\S+)$/.exec(sentence)
    return match === null ? null : t('rolesPage.errors.unknownPermission', { permission: match[1] })
  },
  (t, sentence) => {
    const match = /^Duplicate permission: (\S+)$/.exec(sentence)
    return match === null ? null : t('rolesPage.errors.duplicatePermission', { permission: tokenLabel(t, match[1]) })
  },
  // class-validator's own length messages for the three fields of the form
  // (`CreateAdminRoleDto` / `UpdateAdminRoleDto`), with the field named the way
  // the form names it.
  (t, sentence) => {
    const match = /^(name|displayName|description) must be (longer|shorter) than or equal to (\d+) characters$/.exec(
      sentence,
    )
    if (match === null) return null
    const field = t(`rolesPage.errors.fields.${match[1]}`)
    const key = match[2] === 'longer' ? 'rolesPage.errors.tooShort' : 'rolesPage.errors.tooLong'
    return t(key, { field, count: Number(match[3]) })
  },
  // What `AdminSafeExceptionFilter` puts in place of a sentence it scrubbed —
  // e.g. `Role with name "auth" already exists`, whose "auth" trips its word
  // list. The reason is gone by then; at least the words are the operator's.
  (t, sentence) => (sentence === 'Request failed' ? t('errors.requestFailed') : null),
]

function translateSentence(t: TFunction, sentence: string): string {
  for (const rule of RULES) {
    const translated = rule(t, sentence)
    if (translated !== null) return translated
  }
  return translateServerSentence(t, sentence)
}

/** `response.data.message` — one sentence, or the list a validation failure carries. */
function serverSentences(error: unknown): readonly string[] {
  if (typeof error !== 'object' || error === null) return []
  const message = (error as { response?: { data?: { message?: unknown } } }).response?.data?.message
  const list = Array.isArray(message) ? message : [message]
  return list.filter((item): item is string => typeof item === 'string' && item.length > 0)
}

export function translateRoleError(t: TFunction, error: unknown): string {
  const sentences = serverSentences(error)
  if (sentences.length === 0) return translateApiError(t, error)
  return sentences.map((sentence) => translateSentence(t, sentence)).join(' ')
}
