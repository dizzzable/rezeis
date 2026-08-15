/**
 * NavConfigSection — WEB Reiwa configurator block (Навигация tab).
 *
 * Lets the operator choose which destinations appear in the reiwa cabinet
 * bottom navigation (and in what order), and hide the rest (they stay
 * reachable from Settings). `subscriptions` and `settings` are essential —
 * always visible, locked on. At most `NAV_MAX_VISIBLE` destinations can be
 * shown at once. Order is set by free drag-and-drop. Persists into
 * `brandingSettings.navItems`.
 */
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical, Lock } from 'lucide-react'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { Slider } from '@/components/ui/slider'
import { cn } from '@/lib/utils'

import {
  BRANDING_NAV_DESTINATIONS,
  BRANDING_NAV_ESSENTIALS,
  type NavDestinationId,
  type NavItemDraft,
} from './branding-form-schema'

/**
 * TOTAL visible tabs, essentials INCLUDED — which is why `visibleCount` below
 * counts them. Same number as `NAV_MAX_VISIBLE` in the backend's
 * `branding-settings.interface.ts`, and the same picture the cabinet draws:
 * `normalizeNavItems` (`reiwa/web/src/components/layout/nav-config.ts`) shows
 * both essentials unconditionally and keeps `.slice(0, 3)` of the visible
 * optional ones. Two plus three.
 *
 * This is the third copy of that number, and it stays a copy: the backend
 * interface is not importable from a bundled component — `web/tsconfig.app.json`
 * includes only `web/src` and maps only `@/*`, and the sole web→backend-src
 * imports in the repo are in a test file, never in shipped code. If it earns a
 * shared home, that home is `branding-form-schema.ts`, which already holds this
 * feature's other vocabularies (`BRANDING_NAV_DESTINATIONS`,
 * `BRANDING_NAV_ESSENTIALS`) and which the cross-repo parity guard already
 * reads.
 *
 * The guard here only blocks TICKING a further destination; it does not untick
 * an over-cap payload it is handed. `readNavItems` on the backend is what makes
 * that unreachable, by hiding the overflow before the form ever sees it.
 */
const NAV_MAX_VISIBLE = 5

function isEssential(id: NavDestinationId): boolean {
  return (BRANDING_NAV_ESSENTIALS as readonly string[]).includes(id)
}

/** Ensure every destination is present once, essentials forced visible. */
function normalize(value: readonly NavItemDraft[] | undefined): NavItemDraft[] {
  const seen = new Set<NavDestinationId>()
  const out: NavItemDraft[] = []
  for (const item of value ?? []) {
    if (!(BRANDING_NAV_DESTINATIONS as readonly string[]).includes(item.id) || seen.has(item.id)) continue
    seen.add(item.id)
    out.push({ id: item.id, visible: isEssential(item.id) ? true : item.visible })
  }
  for (const id of BRANDING_NAV_DESTINATIONS) {
    if (!seen.has(id)) out.push({ id, visible: isEssential(id) })
  }
  return out
}

interface NavConfigSectionProps {
  readonly value: readonly NavItemDraft[]
  readonly onChange: (next: NavItemDraft[]) => void
  readonly gap: number
  readonly onGapChange: (next: number) => void
}

export function NavConfigSection({ value, onChange, gap, onGapChange }: NavConfigSectionProps) {
  const { t } = useTranslation()
  const items = useMemo(() => normalize(value), [value])
  const visibleCount = items.filter((i) => i.visible).length

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const toggle = (id: NavDestinationId) => {
    if (isEssential(id)) return
    onChange(items.map((i) => (i.id === id ? { ...i, visible: !i.visible } : i)))
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const from = items.findIndex((i) => i.id === active.id)
    const to = items.findIndex((i) => i.id === over.id)
    if (from === -1 || to === -1) return
    onChange(arrayMove(items, from, to))
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('brandingPage.sections.nav.title')}</CardTitle>
        <p className="text-sm text-muted-foreground">
          {t('brandingPage.sections.nav.description')}
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-xs text-muted-foreground">
          {t('brandingPage.sections.nav.maxHint', { count: NAV_MAX_VISIBLE })}
        </p>
        <div className="space-y-2 rounded-lg border p-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">{t('brandingPage.sections.nav.gap.label')}</span>
            <span className="font-mono text-xs text-muted-foreground">{gap}px</span>
          </div>
          <Slider
            value={[gap]}
            min={0}
            max={24}
            step={1}
            onValueChange={(v) => onGapChange(v[0] ?? 0)}
            aria-label={t('brandingPage.sections.nav.gap.label')}
          />
          <p className="text-xs text-muted-foreground">{t('brandingPage.sections.nav.gap.hint')}</p>
        </div>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
            <div className="space-y-2">
              {items.map((item) => (
                <SortableNavRow
                  key={item.id}
                  item={item}
                  essential={isEssential(item.id)}
                  capReached={!item.visible && visibleCount >= NAV_MAX_VISIBLE}
                  onToggle={() => toggle(item.id)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </CardContent>
    </Card>
  )
}

interface SortableNavRowProps {
  readonly item: NavItemDraft
  readonly essential: boolean
  readonly capReached: boolean
  readonly onToggle: () => void
}

function SortableNavRow({ item, essential, capReached, onToggle }: SortableNavRowProps) {
  const { t } = useTranslation()
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
  })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 10 : undefined,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'flex items-center gap-3 rounded-lg border p-3 transition-colors',
        item.visible ? 'bg-primary/5' : 'bg-muted/10',
        isDragging && 'opacity-80 shadow-lg',
      )}
    >
      <button
        type="button"
        className="cursor-grab touch-none text-muted-foreground hover:text-foreground active:cursor-grabbing focus:outline-none"
        aria-label={t('brandingPage.sections.nav.dragHandle')}
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-4 w-4" aria-hidden="true" />
      </button>
      <span className="flex-1 text-sm font-medium">
        {t(`brandingPage.sections.nav.dest.${item.id}`)}
      </span>
      {essential && (
        <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <Lock className="h-3 w-3" />
          {t('brandingPage.sections.nav.locked')}
        </span>
      )}
      <Switch
        checked={item.visible}
        disabled={essential || capReached}
        onCheckedChange={onToggle}
        aria-label={t(`brandingPage.sections.nav.dest.${item.id}`)}
      />
    </div>
  )
}
