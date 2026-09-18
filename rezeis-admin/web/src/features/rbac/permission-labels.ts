/**
 * Human names for the RBAC catalog, for every surface that shows a permission
 * to a person rather than to a program.
 *
 * A key the dictionaries do not have — a resource or action the server gained
 * after this bundle was built — falls back to the raw key, never to the key
 * PATH: `rolesPage.resources.newthing.name` on screen reads as a crash, the bare
 * `newthing` reads as what it is. `permission-catalog.test.ts` keeps that
 * fallback unreachable for everything this tree ships with.
 */
import type { TFunction } from 'i18next'

import type { CatalogGroup } from './permission-catalog'

/** `users` -> «Пользователи». */
export function resourceName(t: TFunction, resource: string): string {
  return t(`rolesPage.resources.${resource}.name`, { defaultValue: resource })
}

/** What holding any permission on the resource is about. Empty when unknown. */
export function resourceDescription(t: TFunction, resource: string): string {
  return t(`rolesPage.resources.${resource}.description`, { defaultValue: '' })
}

/** What this one action allows on this one resource. Empty when unknown. */
export function permissionDetail(t: TFunction, resource: string, action: string): string {
  return t(`rolesPage.resources.${resource}.actions.${action}`, { defaultValue: '' })
}

/** Why the pair is flagged dangerous. Empty when it is not. */
export function dangerReason(t: TFunction, resource: string, action: string): string {
  return t(`rolesPage.resources.${resource}.danger.${action}`, { defaultValue: '' })
}

/** `bulk_operations` -> «Массовые действия». */
export function actionName(t: TFunction, action: string): string {
  return t(`rolesPage.actions.${action}.name`, { defaultValue: action.replace(/_/g, ' ') })
}

/** What the action means across resources, for its column header. */
export function actionDescription(t: TFunction, action: string): string {
  return t(`rolesPage.actions.${action}.description`, { defaultValue: '' })
}

/**
 * One permission in words, «Пользователи: Просмотр» — the checkbox's accessible
 * name and the form every list of permissions on the page is written in.
 */
export function permissionLabel(t: TFunction, resource: string, action: string): string {
  return `${resourceName(t, resource)}: ${actionName(t, action)}`
}

/**
 * A `resource:action` token as it arrives in a server message, in words.
 * Anything that is not shaped like a token is handed back unchanged.
 */
export function tokenLabel(t: TFunction, token: string): string {
  const match = /^([a-z_]+):([a-z_]+)$/.exec(token.trim())
  return match === null ? token : permissionLabel(t, match[1], match[2])
}

export function groupName(t: TFunction, id: CatalogGroup['id']): string {
  return t(`rolesPage.groups.${id}`, { defaultValue: id })
}
