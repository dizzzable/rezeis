/**
 * The words a system role is shown in, and the words it is stored in.
 *
 * The four system roles are created by the backend's boot seed
 * (`SYSTEM_ROLES` in `src/modules/rbac/rbac.resources.ts`) with an English
 * name and a Russian-only description, written into the database once. Shown
 * as stored, a Russian owner read "Operator" beside a Russian sentence and an
 * English one read a Russian sentence beside "Operator".
 *
 * So while a system role still carries its seed text, the panel shows the
 * dictionary's version (`rolesPage.systemRoles.<name>`, kept in the CORE
 * dictionary so the Administrators page can name roles too). The moment an
 * operator renames it, their words win — in every language, as typed.
 *
 * ── Shown is not stored ──────────────────────────────────────────────────────
 *
 * The editor shows a translation, and the translation must never travel back
 * to the server. It used to: the fields were FILLED with the text on screen,
 * once, and saved as filled. A language switch fills them before the new
 * dictionary has arrived — with the other language, or with the key path
 * itself — and Save then renamed «Оператор» to `rolesPage.systemRoles.operator.name`
 * for everyone. So the editor now keeps only what the operator TYPED
 * (`nameToStore` / `descriptionToStore` take that draft, null while untouched),
 * shows the translation live, and stores the role's own text for every field
 * the operator did not change.
 *
 * `SYSTEM_ROLE_SEEDS` is a copy of the backend's seed text, compared against
 * the real `SYSTEM_ROLES` by `permission-catalog.test.ts`: a drift there would
 * silently turn every system role into an "edited" one.
 */
import type { TFunction } from 'i18next'

interface SystemRoleSeed {
  readonly displayName: string
  readonly description: string
}

export const SYSTEM_ROLE_SEEDS: Readonly<Record<string, SystemRoleSeed>> = {
  superadmin: {
    displayName: 'Superadmin',
    description: 'Полный доступ ко всем разделам панели.',
  },
  operator: {
    displayName: 'Operator',
    description: 'Повседневные операции: пользователи, подписки, платежи, поддержка, рассылки.',
  },
  support: {
    displayName: 'Support',
    description: 'Только просмотр и работа с тикетами / поиск пользователей.',
  },
  finance: {
    displayName: 'Finance',
    description: 'Платежи, выводы, тарифы и финансовая аналитика.',
  },
}

/**
 * Names a custom role may not take: the seed owns them and the server refuses
 * them (`RESERVED_ROLE_NAMES`). Checked here so the form can say so before the
 * request is sent.
 */
export function isReservedRoleName(name: string): boolean {
  return Object.hasOwn(SYSTEM_ROLE_SEEDS, name)
}

interface RoleText {
  readonly name: string
  readonly isSystem: boolean
  readonly displayName: string
  readonly description: string | null
}

function seedOf(role: Pick<RoleText, 'name' | 'isSystem'>): SystemRoleSeed | null {
  if (!role.isSystem || !Object.hasOwn(SYSTEM_ROLE_SEEDS, role.name)) return null
  return SYSTEM_ROLE_SEEDS[role.name]
}

/**
 * The role's name as the operator should read it.
 *
 * With the stored name as the fallback: a dictionary that has not arrived yet
 * — the Administrators page does not wait for one, and no page waits for a
 * language it is switching to — yields the role's own name, never a key path.
 */
export function roleDisplayName(t: TFunction, role: RoleText): string {
  const seed = seedOf(role)
  return seed !== null && role.displayName === seed.displayName
    ? t(`rolesPage.systemRoles.${role.name}.name`, { defaultValue: role.displayName })
    : role.displayName
}

/** The role's description as the operator should read it; null when it has none. */
export function roleDescription(t: TFunction, role: RoleText): string | null {
  const seed = seedOf(role)
  return seed !== null && role.description === seed.description
    ? t(`rolesPage.systemRoles.${role.name}.description`, { defaultValue: role.description })
    : role.description
}

/**
 * What to store for the name field: `draft` is what the operator typed, or
 * null while they have not touched it. Untouched — or touched and left exactly
 * as shown — stores the role's own name, never the translation on screen.
 */
export function nameToStore(t: TFunction, role: RoleText, draft: string | null): string {
  if (draft === null) return role.displayName
  const typed = draft.trim()
  return typed === roleDisplayName(t, role) ? role.displayName : typed
}

/** The same for the description; an emptied field stores null. */
export function descriptionToStore(t: TFunction, role: RoleText, draft: string | null): string | null {
  if (draft === null) return role.description
  const typed = draft.trim()
  if (typed === (roleDescription(t, role) ?? '')) return role.description
  return typed === '' ? null : typed
}
