import { useTranslation } from 'react-i18next'
import { useDroppable } from '@dnd-kit/core'

import { cn } from '@/lib/utils'

interface EmptyGroupDropZoneProps {
  readonly groupKey: string
}

/**
 * Drop target rendered for nav groups that have no items in the
 * current draft. Visually outlines the empty group so the operator
 * can drop a sidebar item into it during edit mode.
 */
export function EmptyGroupDropZone({ groupKey }: EmptyGroupDropZoneProps) {
  const { t } = useTranslation()
  const { setNodeRef, isOver } = useDroppable({ id: `__group__${groupKey}` })

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'mx-1 rounded-md border border-dashed px-3 py-3 text-center text-xs italic transition-colors',
        isOver
          ? 'border-sidebar-primary/60 bg-sidebar-primary/10 text-sidebar-foreground/60'
          : 'border-sidebar-border/40 text-sidebar-foreground/30',
      )}
    >
      {t('adminNav.emptyGroup')}
    </div>
  )
}
