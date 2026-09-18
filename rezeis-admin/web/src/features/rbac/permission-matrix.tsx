/**
 * The permission matrix of the role editor and the create dialog.
 *
 * One row per resource, one column per action, grouped into the areas of the
 * panel (`permission-catalog.ts`). Everything an owner needs to tick a box
 * knowingly is on the page rather than in their head: the row says what the
 * section is in words, its (i) says what EACH of its permissions unlocks there,
 * a column's (i) says what the action means across the panel, and a permission
 * that can move money, destroy data, lock people out or expose secrets carries
 * a warning sign with the reason behind it. The raw key stays visible in small
 * print, because the rest of the panel quotes it («нет права users:view_registration»).
 *
 * ── Why the header and the first column stay put ────────────────────────────
 *
 * Seventeen columns do not fit: at 1280 px the editor is ~650 px wide and the
 * table ~1400 px, so by «Возврат средств» no row name was on screen and a box
 * could only be identified by counting. The table scrolls inside its own box
 * with the header row and the section column pinned. Their backgrounds are
 * written as `color-mix` / `bg-card/90` on purpose: the Liquid Glass theme
 * turns `.bg-card` translucent and `.bg-muted/50` fully transparent
 * (`index.css`), and a pinned cell that lets the scrolled rows show through it
 * cannot be read.
 */
import { useCallback, useId, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { InfoTip } from '@/components/ui/info-tip'

import { groupCatalog, isDangerousPermission } from './permission-catalog'
import {
  actionDescription,
  actionName,
  dangerReason,
  groupName,
  permissionDetail,
  permissionLabel,
  resourceDescription,
  resourceName,
  tokenLabel,
} from './permission-labels'
import type { RbacAction, RbacResourceCatalog } from './rbac-types'
import { holdsPermission, usePermissionStore } from './use-permission-store'

function tokenOf(resource: string, action: string): string {
  return `${resource}:${action}`
}

/** Opaque under every theme; see the note on pinned cells above. */
const PINNED_HEAD = 'sticky top-0 bg-[color-mix(in_oklch,var(--muted)_55%,var(--card))]'
const PINNED_COLUMN = 'sticky left-0 bg-card/90 backdrop-blur-sm'

export function PermissionMatrix({
  catalog,
  permissions,
  onChange,
  readOnly,
  systemPermissions,
}: {
  readonly catalog: RbacResourceCatalog
  readonly permissions: ReadonlySet<string>
  readonly onChange: (next: Set<string>) => void
  readonly readOnly: boolean
  readonly systemPermissions: ReadonlySet<string> | null
}) {
  const { t } = useTranslation()
  const describedBy = useId()
  const groups = useMemo(() => groupCatalog(catalog.resources), [catalog])

  /**
   * What the ACTOR holds — not what the role being edited holds.
   *
   * The server refuses any save whose resulting permission set contains a
   * token the actor does not hold (`assertGrantsWithinActor`). Without this the
   * editor rendered the whole catalogue and let an admin tick a box the save
   * would then refuse, naming a permission they had never heard of.
   *
   * Subscribed to `granted` and `role`, not to `hasPermission`: that one is a
   * fixed function reference, so selecting it never re-rendered the matrix when
   * the actor's own grants changed, and every box stayed as the first load left it.
   */
  const actorGranted = usePermissionStore((s) => s.granted)
  const actorRole = usePermissionStore((s) => s.role)
  const actorHolds = useCallback(
    (resource: string, action: string) => holdsPermission({ role: actorRole, granted: actorGranted }, resource, action),
    [actorRole, actorGranted],
  )

  /**
   * Permissions the role already carries that the actor cannot grant. Any save
   * is refused while these remain, so they are named rather than left for the
   * server to discover — and they stay un-disabled below, because REMOVING one
   * is exactly what makes the save legal again.
   */
  const beyondActor = useMemo(() => {
    const out: string[] = []
    for (const [resource, actions] of Object.entries(catalog.resources)) {
      for (const action of actions) {
        const token = tokenOf(resource, action)
        if (permissions.has(token) && !actorHolds(resource, action)) out.push(token)
      }
    }
    return out.sort()
  }, [catalog, permissions, actorHolds])

  /**
   * Permissions the role holds that the catalogue no longer offers. The matrix
   * has no box for them, so they could not be unticked — and the server refuses
   * to save a role holding one ("Unknown permission"). They grant nothing:
   * nothing checks a permission the catalogue does not have.
   */
  const unknown = useMemo(() => {
    const known = new Set(
      Object.entries(catalog.resources).flatMap(([resource, actions]) => actions.map((a) => tokenOf(resource, a))),
    )
    return [...permissions].filter((token) => !known.has(token)).sort()
  }, [catalog, permissions])

  const effective = readOnly && systemPermissions ? systemPermissions : permissions

  const anyDangerous = Object.entries(catalog.resources).some(([resource, actions]) =>
    actions.some((action) => isDangerousPermission(resource, action)),
  )
  const anyBlocked =
    !readOnly &&
    Object.entries(catalog.resources).some(([resource, actions]) =>
      actions.some((action) => !actorHolds(resource, action) && !effective.has(tokenOf(resource, action))),
    )

  function toggle(resource: string, action: RbacAction) {
    if (readOnly) return
    const token = tokenOf(resource, action)
    const next = new Set(permissions)
    if (next.has(token)) next.delete(token)
    else next.add(token)
    onChange(next)
  }

  /**
   * «все» ticks what the actor CAN grant and nothing else. It used to tick the
   * whole row, including the boxes disabled because the actor does not hold
   * them — the very ones the server refuses — so one click produced a role that
   * could not be saved and a red banner about permissions nobody had chosen.
   */
  function tickRow(resource: string, actions: readonly RbacAction[]) {
    if (readOnly) return
    const next = new Set(permissions)
    for (const action of actions) {
      if (actorHolds(resource, action)) next.add(tokenOf(resource, action))
    }
    onChange(next)
  }

  /** «снять» clears the whole row: removing a permission is always allowed. */
  function clearRow(resource: string, actions: readonly RbacAction[]) {
    if (readOnly) return
    const next = new Set(permissions)
    for (const action of actions) next.delete(tokenOf(resource, action))
    onChange(next)
  }

  function removeUnknown() {
    if (readOnly) return
    const next = new Set(permissions)
    for (const token of unknown) next.delete(token)
    onChange(next)
  }

  const columnCount = catalog.actions.length + 1

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-sm font-semibold">{t('rolesPage.matrix.title')}</h3>
        {anyDangerous && (
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" aria-hidden="true" />
            <span>{t('rolesPage.matrix.dangerLegend')}</span>
          </p>
        )}
      </div>
      {!readOnly && unknown.length > 0 && (
        <Alert variant="destructive" data-role-editor-unknown>
          <AlertTitle>{t('rolesPage.editor.unknownTitle')}</AlertTitle>
          <AlertDescription>
            {t('rolesPage.editor.unknownBody')}
            <span className="mt-1 block font-mono text-xs">{unknown.join(', ')}</span>
            <Button type="button" size="sm" variant="outline" className="mt-2" onClick={removeUnknown}>
              {t('rolesPage.editor.unknownRemove')}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {!readOnly && beyondActor.length > 0 && (
        <Alert variant="destructive" data-role-editor-beyond-actor>
          <AlertTitle>{t('rolesPage.matrix.beyondActorTitle')}</AlertTitle>
          <AlertDescription>
            {t('rolesPage.matrix.beyondActorBody')}
            <span className="mt-1 block text-xs">
              {beyondActor.map((token) => tokenLabel(t, token)).join('; ')}
            </span>
          </AlertDescription>
        </Alert>
      )}
      {anyBlocked && <p className="text-xs text-muted-foreground">{t('rolesPage.matrix.blockedLegend')}</p>}
      <div className="max-h-[70vh] overflow-auto rounded-md border" data-permission-matrix-scroll>
        <table className="w-full min-w-[600px] border-separate border-spacing-0 text-sm">
          <thead>
            <tr>
              <th
                scope="col"
                className={`${PINNED_HEAD} left-0 z-30 min-w-[13rem] border-b px-3 py-2 text-left align-bottom font-medium`}
              >
                {t('rolesPage.matrix.sectionColumn')}
              </th>
              {catalog.actions.map((action) => {
                const name = actionName(t, action)
                const description = actionDescription(t, action)
                return (
                  <th
                    key={action}
                    scope="col"
                    className={`${PINNED_HEAD} z-20 border-b px-2 py-2 text-center align-bottom text-xs font-medium`}
                  >
                    <span className="inline-flex items-center justify-center gap-1">
                      <span>{name}</span>
                      {description !== '' && (
                        <InfoTip label={t('rolesPage.moreAbout', { name })} side="bottom">
                          {description}
                        </InfoTip>
                      )}
                    </span>
                  </th>
                )
              })}
            </tr>
          </thead>
          {groups.map((group) => (
            <tbody key={group.id} data-permission-group={group.id}>
              <tr className="bg-muted/20">
                <th
                  scope="rowgroup"
                  colSpan={columnCount}
                  className="border-b px-3 py-1.5 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                >
                  <span className="sticky left-3">{groupName(t, group.id)}</span>
                </th>
              </tr>
              {group.resources.map(([resource, actions]) => {
                const name = resourceName(t, resource)
                const grantable = actions.filter((action) => actorHolds(resource, action))
                const canTickMore = grantable.some((action) => !effective.has(tokenOf(resource, action)))
                const anyTicked = actions.some((action) => effective.has(tokenOf(resource, action)))
                const rowButtonText = canTickMore ? t('rolesPage.matrix.tickAll') : t('rolesPage.matrix.clearAll')
                return (
                  <tr key={resource}>
                    <td className={`${PINNED_COLUMN} z-10 border-b px-3 py-2 align-top`}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-1">
                            <span className="font-medium">{name}</span>
                            <ResourceHelp resource={resource} actions={actions} name={name} />
                          </div>
                          <code className="text-[10px] text-muted-foreground">{resource}</code>
                        </div>
                        {!readOnly && (canTickMore || anyTicked) && (
                          <button
                            type="button"
                            onClick={() => (canTickMore ? tickRow(resource, actions) : clearRow(resource, actions))}
                            aria-label={t(canTickMore ? 'rolesPage.matrix.tickAllLabel' : 'rolesPage.matrix.clearAllLabel', {
                              label: rowButtonText,
                              name,
                            })}
                            className="shrink-0 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                          >
                            {rowButtonText}
                          </button>
                        )}
                      </div>
                    </td>
                    {catalog.actions.map((action) => {
                      const supports = (actions as readonly string[]).includes(action)
                      if (!supports) {
                        return (
                          <td key={action} className="border-b px-2 py-2 text-center text-muted-foreground">
                            –
                          </td>
                        )
                      }
                      const token = tokenOf(resource, action)
                      const checked = effective.has(token)
                      // The server refuses a save whose RESULTING set contains a
                      // permission the actor does not hold — not merely one they
                      // just added. So ticking a box outside your own grants can
                      // never succeed, while UNticking one always can: removing it
                      // is what makes the save legal. Disable the first, allow the
                      // second, and say why in the title and the legend above.
                      const blocked = !actorHolds(resource, action) && !checked
                      const dangerous = isDangerousPermission(resource, action)
                      const label = permissionLabel(t, resource, action)
                      const descriptionId = `${describedBy}-${resource}-${action}`
                      // What a screen reader hears after the name: what the box
                      // unlocks, why it is dangerous, why it cannot be ticked.
                      const description = [
                        permissionDetail(t, resource, action),
                        dangerous ? `${t('rolesPage.matrix.dangerPrefix')} ${dangerReason(t, resource, action)}` : '',
                        blocked ? t('rolesPage.matrix.cannotGrant') : '',
                      ]
                        .filter((part) => part !== '')
                        .join(' ')
                      return (
                        <td key={action} className="border-b px-2 py-2 text-center">
                          <span className="inline-flex items-center justify-center gap-1">
                            <Checkbox
                              checked={checked}
                              onCheckedChange={() => toggle(resource, action)}
                              disabled={readOnly || blocked}
                              aria-label={label}
                              aria-describedby={description !== '' ? descriptionId : undefined}
                              title={blocked ? t('rolesPage.matrix.cannotGrant') : undefined}
                            />
                            {description !== '' && (
                              <span id={descriptionId} className="sr-only">
                                {description}
                              </span>
                            )}
                            {dangerous && (
                              <InfoTip
                                label={t('rolesPage.matrix.dangerLabel', { permission: label })}
                                icon={<AlertTriangle className="h-3.5 w-3.5 text-amber-500" aria-hidden="true" />}
                              >
                                {dangerReason(t, resource, action)}
                              </InfoTip>
                            )}
                          </span>
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          ))}
        </table>
      </div>
    </div>
  )
}

/**
 * The (i) beside a section: what it is, then what each of ITS permissions
 * unlocks there. A column's (i) can only say what an action means in general;
 * «Разбор» closes a ticket in one row and opens a payment notification in
 * another, and only the row can say which.
 *
 * Opens BELOW its icon and is never wider than the screen: opening to the
 * right at a fixed 384 px, as it did, cut it off on a phone, where the (i)
 * sits at the left edge of a 375 px viewport.
 */
function ResourceHelp({
  resource,
  actions,
  name,
}: {
  readonly resource: string
  readonly actions: readonly RbacAction[]
  readonly name: string
}) {
  const { t } = useTranslation()
  const description = resourceDescription(t, resource)
  const details = actions
    .map((action) => ({ action, detail: permissionDetail(t, resource, action) }))
    .filter((entry) => entry.detail !== '')
  if (description === '' && details.length === 0) return null
  return (
    <InfoTip
      label={t('rolesPage.moreAbout', { name })}
      side="bottom"
      align="start"
      contentClassName="max-w-[min(24rem,calc(100vw-1rem))] whitespace-normal"
    >
      <span className="block space-y-1.5 text-left">
        {description !== '' && <span className="block">{description}</span>}
        {details.length > 0 && (
          <span className="block space-y-1">
            {details.map(({ action, detail }) => (
              <span key={action} className="block">
                <span className="font-semibold">{actionName(t, action)}</span> — {detail}
              </span>
            ))}
          </span>
        )}
      </span>
    </InfoTip>
  )
}
