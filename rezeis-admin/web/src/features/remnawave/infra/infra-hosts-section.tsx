/**
 * Hosts section — drag-and-drop reorder lives here. Order changes are
 * persisted via `POST /api/hosts/actions/reorder` (proxied through our
 * backend). We optimistically update the local list so the row jumps to
 * its new position immediately, then call invalidate on success/failure.
 *
 * Hosts have no native `countryCode` field — the flag column is derived
 * from the first node UUID in `host.nodes[]`, looked up against the
 * already-cached nodes query.
 */
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Eye, EyeOff, GripVertical, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'

import { remnawaveApi, type RemnawaveHost, type RemnawaveNode } from '../remnawave-api'
import { NodeFlag } from '../remnawave-flags'
import { KEYS } from '../remnawave-query-keys'
import { stripCountryPrefix } from '../remnawave-utils'
import { StatusDot } from '../shared/status-dot'

export function InfraHostsSection() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { data: hosts, isLoading } = useQuery({ queryKey: KEYS.hosts, queryFn: remnawaveApi.getAllHosts })
  const { data: nodes } = useQuery({ queryKey: KEYS.nodes, queryFn: remnawaveApi.getAllNodes })

  // Resolve a country code per host by walking host.nodes[] and pulling the
  // first reachable countryCode. Memoised across renders so each row's flag
  // lookup is O(1).
  const nodeCountryByUuid = useMemo(() => {
    const map = new Map<string, string>()
    if (!nodes) return map
    for (const node of nodes as RemnawaveNode[]) {
      if (node.countryCode) map.set(node.uuid, node.countryCode)
    }
    return map
  }, [nodes])

  function resolveHostCountry(host: RemnawaveHost): string {
    for (const uuid of host.nodes ?? []) {
      const code = nodeCountryByUuid.get(uuid)
      if (code) return code
    }
    // Fallback: try to grab a 2-letter prefix from the remark itself
    // (operators often prefix host names with the ISO code).
    const prefixMatch = /^\s*([A-Z]{2})\b/i.exec(host.remark ?? '')
    return prefixMatch ? prefixMatch[1].toUpperCase() : ''
  }

  // Local copy for optimistic ordering. Resyncs when the upstream list changes.
  const [order, setOrder] = useState<RemnawaveHost[]>([])
  useEffect(() => {
    if (hosts) {
      setOrder([...hosts].sort((a, b) => a.viewPosition - b.viewPosition))
    }
  }, [hosts])

  const reorderMutation = useMutation({
    mutationFn: (uuids: string[]) => remnawaveApi.reorderHosts(uuids),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: KEYS.hosts })
      toast.success(t('remnaWavePage.hosts.toasts.reordered'))
    },
    onError: () => {
      toast.error(t('remnaWavePage.hosts.toasts.reorderFailed'))
      void queryClient.invalidateQueries({ queryKey: KEYS.hosts })
    },
  })

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  function handleDragEnd(event: DragEndEvent): void {
    const { active, over } = event
    if (!over || active.id === over.id) return
    setOrder((prev) => {
      const oldIndex = prev.findIndex((h) => h.uuid === active.id)
      const newIndex = prev.findIndex((h) => h.uuid === over.id)
      if (oldIndex === -1 || newIndex === -1) return prev
      const next = arrayMove(prev, oldIndex, newIndex)
      reorderMutation.mutate(next.map((h) => h.uuid))
      return next
    })
  }

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex h-32 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden />
        </CardContent>
      </Card>
    )
  }

  if (order.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          {t('remnaWavePage.hosts.empty')}
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardContent className="p-2">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={order.map((h) => h.uuid)} strategy={verticalListSortingStrategy}>
            <ul className="divide-y divide-border/60">
              {order.map((host) => (
                <SortableHostRow
                  key={host.uuid}
                  host={host}
                  countryCode={resolveHostCountry(host)}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      </CardContent>
    </Card>
  )
}

interface SortableHostRowProps {
  readonly host: RemnawaveHost
  readonly countryCode: string
}

function SortableHostRow({ host, countryCode }: SortableHostRowProps) {
  const { t } = useTranslation()
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: host.uuid })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  const status: 'online' | 'disabled' = host.isDisabled ? 'disabled' : 'online'
  const statusLabel = host.isDisabled
    ? t('remnaWavePage.hosts.statusDisabled')
    : host.isHidden
      ? t('remnaWavePage.hosts.statusHidden')
      : t('remnaWavePage.hosts.statusActive')

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={cn(
        'group flex items-center gap-3 px-3 py-2.5',
        isDragging && 'z-10 rounded-md bg-accent/40 shadow-sm',
      )}
    >
      <button
        {...attributes}
        {...listeners}
        type="button"
        className="cursor-grab text-muted-foreground/50 transition hover:text-muted-foreground active:cursor-grabbing"
        aria-label={t('remnaWavePage.hosts.dragHandle')}
      >
        <GripVertical className="h-4 w-4" />
      </button>

      <NodeFlag code={countryCode} title={countryCode || undefined} />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-medium">{stripCountryPrefix(host.remark, countryCode)}</p>
          {host.isHidden ? (
            <Badge variant="outline" className="px-1.5 text-[10px] font-normal">
              <EyeOff className="mr-1 h-3 w-3" />{t('remnaWavePage.hosts.statusHidden')}
            </Badge>
          ) : (
            <Eye className="h-3 w-3 text-muted-foreground/40" aria-hidden />
          )}
        </div>
        <p className="truncate font-mono text-xs text-muted-foreground">
          {host.address}:{host.port}
          {host.securityLayer && host.securityLayer !== 'DEFAULT' ? ` · ${host.securityLayer}` : null}
        </p>
      </div>

      <StatusDot status={status} label={statusLabel} className="shrink-0" />

      <span className="ml-2 hidden font-mono text-[10px] text-muted-foreground/70 md:inline">
        {host.uuid.slice(0, 8)}…
      </span>
    </li>
  )
}
