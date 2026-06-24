import { useState, useEffect, useMemo } from 'react'
import type { ComponentType, SVGProps } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'react-router-dom'
import {
  DndContext,
  closestCorners,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable'
import { GripVertical, Pencil, RotateCcw } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { usePermissionStore } from '@/features/rbac'
import { useSidebarStore } from '@/stores/sidebar-store'

import { canShowNavItem, navGroups, navItemMap, resolveNavOrder } from '../admin-nav-config'
import { EmptyGroupDropZone } from './empty-group-drop-zone'
import { SortableNavItem } from './sortable-nav-item'

interface NavItemsProps {
  readonly collapsed?: boolean
  readonly onNavigate?: () => void
}

/**
 * Sidebar navigation list with drag-and-drop reordering (edit mode)
 * and most-specific-match active route resolution.
 */
export function NavItems({ collapsed = false, onNavigate }: NavItemsProps) {
  const { t } = useTranslation()
  const { pathname } = useLocation()
  const {
    groupsOrder,
    groupKeyOrder,
    editMode,
    isDirty,
    draftGroupsOrder,
    customGroupLabels,
    setGroupsOrder,
    setDraftGroupsOrder,
    startEditing,
    cancelEditing,
    saveEditing,
    addCustomGroup,
    removeCustomGroup,
    resetOrder,
  } = useSidebarStore()
  const [activeId, setActiveId] = useState<string | null>(null)
  const [newGroupName, setNewGroupName] = useState('')
  const permissionsLoaded = usePermissionStore((s) => s.loaded)
  const hasPermission = usePermissionStore((s) => s.hasPermission)

  // Use draft in edit mode, persisted otherwise
  const effectiveGroups = editMode ? draftGroupsOrder : groupsOrder

  // Resolve the effective nav structure
  const resolvedGroups = useMemo(
    () => {
      const groups = resolveNavOrder(effectiveGroups, groupKeyOrder)
      if (!permissionsLoaded) return groups
      return groups.map((group) => ({
        ...group,
        items: group.items.filter((item) => canShowNavItem(item, permissionsLoaded, hasPermission)),
      }))
    },
    [effectiveGroups, groupKeyOrder, hasPermission, permissionsLoaded],
  )

  // Initialize store with defaults if not yet set
  useEffect(() => {
    if (!groupsOrder) {
      setGroupsOrder(
        navGroups.map((g) => ({ groupKey: g.key, itemKeys: g.items.map((i) => i.key) })),
      )
    }
  }, [groupsOrder, setGroupsOrder])

  // ── Most-specific-match resolution ──────────────────────────────────
  const allPaths = resolvedGroups.flatMap((g) => g.items.map((i) => i.path))
  const bestMatch = allPaths
    .filter((p) =>
      p === '/'
        ? pathname === '/'
        : pathname === p || pathname.startsWith(p + '/'),
    )
    .reduce((best, candidate) => (candidate.length > best.length ? candidate : best), '')

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  // All item keys in a flat list for the single DndContext
  const allItemKeys = useMemo(
    () => resolvedGroups.flatMap((g) => g.items.map((i) => i.key)),
    [resolvedGroups],
  )

  function handleDragStart(event: DragStartEvent) {
    setActiveId(event.active.id as string)
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveId(null)
    const { active, over } = event
    if (!over || active.id === over.id) return

    const currentGroups = draftGroupsOrder ?? navGroups.map((g) => ({
      groupKey: g.key,
      itemKeys: g.items.map((i) => i.key),
    }))

    const activeKey = active.id as string
    const overId = over.id as string

    // Handle drop on empty group zone
    if (overId.startsWith('__group__')) {
      const targetGroupKey = overId.replace('__group__', '')
      const srcGroup = currentGroups.find((g) => g.itemKeys.includes(activeKey))
      if (!srcGroup) return

      const newGroups = currentGroups.map((g) => {
        if (g.groupKey === srcGroup.groupKey) {
          return { ...g, itemKeys: g.itemKeys.filter((k) => k !== activeKey) }
        }
        if (g.groupKey === targetGroupKey) {
          return { ...g, itemKeys: [...g.itemKeys, activeKey] }
        }
        return g
      })
      setDraftGroupsOrder(newGroups)
      return
    }

    // Find source and destination groups
    const srcGroup = currentGroups.find((g) => g.itemKeys.includes(activeKey))
    const dstGroup = currentGroups.find((g) => g.itemKeys.includes(overId))
    if (!srcGroup || !dstGroup) return

    if (srcGroup.groupKey === dstGroup.groupKey) {
      // Same group — reorder
      const oldIndex = srcGroup.itemKeys.indexOf(activeKey)
      const newIndex = srcGroup.itemKeys.indexOf(overId)
      const newGroups = currentGroups.map((g) => {
        if (g.groupKey !== srcGroup.groupKey) return g
        return { ...g, itemKeys: arrayMove(g.itemKeys, oldIndex, newIndex) }
      })
      setDraftGroupsOrder(newGroups)
    } else {
      // Cross-group move
      const newGroups = currentGroups.map((g) => {
        if (g.groupKey === srcGroup.groupKey) {
          return { ...g, itemKeys: g.itemKeys.filter((k) => k !== activeKey) }
        }
        if (g.groupKey === dstGroup.groupKey) {
          const overIndex = g.itemKeys.indexOf(overId)
          const newItems = [...g.itemKeys]
          newItems.splice(overIndex, 0, activeKey)
          return { ...g, itemKeys: newItems }
        }
        return g
      })
      setDraftGroupsOrder(newGroups)
    }
  }

  /** Resolve group label — built-in uses i18n, custom uses customGroupLabels */
  function getGroupLabel(groupKey: string): string {
    if (customGroupLabels[groupKey]) return customGroupLabels[groupKey]
    return t(`adminNav.groups.${groupKey}`)
  }

  function handleAddGroup() {
    const name = newGroupName.trim()
    if (!name) return
    addCustomGroup(name)
    setNewGroupName('')
  }

  return (
    <nav
      aria-label={t('adminShell.primaryNavigation')}
      className="flex flex-col gap-1 px-2"
    >
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={allItemKeys} strategy={verticalListSortingStrategy}>
          {resolvedGroups.map((group, groupIndex) => {
            // Hide empty groups when NOT in edit mode
            if (!editMode && group.items.length === 0) return null

            return (
              <div key={group.key}>
                {groupIndex > 0 && <div className="my-1 h-px bg-sidebar-border/50 mx-1" />}
                {!collapsed && (
                  <div className="flex items-center justify-between px-3 py-1.5">
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-sidebar-foreground/40">
                      {getGroupLabel(group.key)}
                    </p>
                    {groupIndex === 0 && !editMode && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-5 w-5 text-sidebar-foreground/40 hover:text-sidebar-foreground"
                        onClick={startEditing}
                        aria-label={t('adminNav.editOrder')}
                      >
                        <Pencil className="h-3 w-3" />
                      </Button>
                    )}
                    {editMode && customGroupLabels[group.key] && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-5 w-5 text-destructive/60 hover:text-destructive"
                        onClick={() => removeCustomGroup(group.key)}
                        aria-label={t('adminNav.removeGroup')}
                      >
                        <RotateCcw className="h-3 w-3" />
                      </Button>
                    )}
                  </div>
                )}
                {group.items.map((item, index) => {
                  const globalIndex =
                    resolvedGroups
                      .slice(0, groupIndex)
                      .reduce((acc, g) => acc + g.items.length, 0) + index
                  const isCurrent = item.path === bestMatch
                  return (
                    <SortableNavItem
                      key={item.key}
                      item={item}
                      isCurrent={isCurrent}
                      collapsed={collapsed}
                      editMode={editMode}
                      onNavigate={onNavigate}
                      globalIndex={globalIndex}
                    />
                  )
                })}
                {editMode && group.items.length === 0 && (
                  <EmptyGroupDropZone groupKey={group.key} />
                )}
              </div>
            )
          })}
        </SortableContext>
        <DragOverlay>
          {activeId &&
            navItemMap.get(activeId) &&
            (() => {
              const item = navItemMap.get(activeId)!
              const ItemIcon = item.icon as ComponentType<SVGProps<SVGSVGElement>>
              return (
                <div className="flex items-center gap-3 rounded-md bg-sidebar-accent px-3 py-2 text-sm font-medium text-sidebar-foreground shadow-lg">
                  <GripVertical className="h-3.5 w-3.5 shrink-0 text-sidebar-foreground/40" />
                  <ItemIcon className="h-4 w-4 shrink-0" />
                  <span>{t(`adminNav.items.${item.key}`)}</span>
                </div>
              )
            })()}
        </DragOverlay>
      </DndContext>

      {/* Edit mode toolbar */}
      {editMode && !collapsed && (
        <div className="mt-2 flex flex-col gap-2 px-2 border-t border-sidebar-border/50 pt-2">
          {/* Add custom group */}
          <div className="flex items-center gap-1">
            <input
              type="text"
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAddGroup()}
              placeholder={t('adminNav.newGroupPlaceholder')}
              className="flex-1 rounded-md bg-sidebar-accent/50 px-2 py-1 text-xs text-sidebar-foreground placeholder:text-sidebar-foreground/30 outline-none focus:ring-1 focus:ring-sidebar-primary"
              aria-label={t('adminNav.newGroupPlaceholder')}
            />
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs text-sidebar-foreground/60 hover:text-sidebar-foreground"
              onClick={handleAddGroup}
              disabled={!newGroupName.trim()}
            >
              +
            </Button>
          </div>

          {/* Save / Cancel / Reset */}
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="flex-1 h-7 text-xs text-sidebar-foreground/60 hover:text-sidebar-foreground"
              onClick={cancelEditing}
            >
              {t('adminNav.cancel')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-sidebar-foreground/40 hover:text-sidebar-foreground"
              onClick={resetOrder}
              aria-label={t('adminNav.resetOrder')}
            >
              <RotateCcw className="h-3 w-3" />
            </Button>
            <Button
              variant="default"
              size="sm"
              className="flex-1 h-7 text-xs"
              onClick={saveEditing}
              disabled={!isDirty}
            >
              {t('adminNav.save')}
            </Button>
          </div>
        </div>
      )}
    </nav>
  )
}
