/**
 * Standard strip rendered at the top of every Remnawave sub-tab: title,
 * subtitle, and a slot for action controls (refresh, filters, …).
 */
import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

interface TabHeaderProps {
  readonly title: string
  readonly subtitle?: string
  readonly actions?: ReactNode
  readonly className?: string
}

export function TabHeader({ title, subtitle, actions, className }: TabHeaderProps) {
  return (
    <div className={cn('flex flex-col gap-2 pt-1 sm:flex-row sm:items-end sm:justify-between', className)}>
      <div>
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {subtitle ? <p className="text-sm text-muted-foreground">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  )
}
