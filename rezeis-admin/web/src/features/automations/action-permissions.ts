import { useCallback } from 'react'
import type { TFunction } from 'i18next'

import { holdsPermission, usePermissionStore } from '@/features/rbac/use-permission-store'

import type { AutomationCatalog } from './automations-api'
import { actionLabel } from './rule-action-labels'

/**
 * What an action needs on top of the automations permissions, and whether the
 * admin at the screen holds it.
 *
 * The map is the SERVER's (`GET /admin/automations/catalog` →
 * `actionPermissions`, the very table the save, the switch and «Запустить
 * сейчас» enforce), never a copy kept here: a second copy is a second thing to
 * forget when an action changes, and the editor must grey out exactly what the
 * server refuses — no more, no less.
 *
 * Nothing is reported missing until both halves are known: a catalogue from a
 * panel too old to send the map, or grants that have not loaded yet, disable
 * nothing. The server refuses regardless, and says why.
 */

export interface PermissionRef {
  readonly resource: string
  readonly action: string
}

export type ActionPermissionMap = NonNullable<AutomationCatalog['actionPermissions']>

/** Every permission these actions need that `holds` says no to, once each, in first-needed order. */
export function missingPermissionsForActions(
  actions: ReadonlyArray<{ readonly type: string }>,
  map: ActionPermissionMap | undefined,
  holds: (resource: string, action: string) => boolean,
): PermissionRef[] {
  if (map === undefined) return []
  const missing: PermissionRef[] = []
  const seen = new Set<string>()
  for (const { type } of actions) {
    const needed = Object.hasOwn(map, type) ? map[type] : undefined
    for (const permission of needed ?? []) {
      const token = `${permission.resource}:${permission.action}`
      if (seen.has(token) || holds(permission.resource, permission.action)) continue
      seen.add(token)
      missing.push({ resource: permission.resource, action: permission.action })
    }
  }
  return missing
}

/**
 * `(actions) => the permissions they need that this admin lacks`, following the
 * admin's grants as they load and change.
 */
export function useMissingActionPermissions(
  map: ActionPermissionMap | undefined,
): (actions: ReadonlyArray<{ readonly type: string }>) => PermissionRef[] {
  const loaded = usePermissionStore((state) => state.loaded)
  const granted = usePermissionStore((state) => state.granted)
  const role = usePermissionStore((state) => state.role)
  return useCallback(
    (actions) =>
      loaded
        ? missingPermissionsForActions(actions, map, (resource, action) =>
            holdsPermission({ role, granted }, resource, action),
          )
        : [],
    [loaded, map, granted, role],
  )
}

/**
 * A permission the way the roles page names it — «Заблокированные IP:
 * Создание». The names this page can meet travel in its own bundle
 * (`automationsPage.permissionNames`), so no second bundle has to load first;
 * `action-permissions.test.ts` holds them to the roles page's own wording.
 */
export function permissionName(t: TFunction, permission: PermissionRef): string {
  return String(
    t(`automationsPage.permissionNames.${permission.resource}.${permission.action}`, {
      defaultValue: `${permission.resource}:${permission.action}`,
    }),
  )
}

/** Several permissions in one phrase: «Заблокированные IP: Создание», «Пользователи: Изменение». */
export function permissionList(t: TFunction, permissions: readonly PermissionRef[]): string {
  return permissions
    .map((permission) => String(t('automationsPage.quotedName', { name: permissionName(t, permission) })))
    .join(', ')
}

/** The actions a rule holds that need a permission the admin lacks, named and quoted: «Заблокировать IP». */
export function actionsNeedingPermission(
  t: TFunction,
  actions: ReadonlyArray<{ readonly type: string }>,
  missingFor: (actions: ReadonlyArray<{ readonly type: string }>) => PermissionRef[],
): string {
  const labels: string[] = []
  for (const action of actions) {
    if (missingFor([action]).length === 0) continue
    const label = String(t('automationsPage.quotedName', { name: actionLabel(t, action.type) }))
    if (!labels.includes(label)) labels.push(label)
  }
  return labels.join(', ')
}
