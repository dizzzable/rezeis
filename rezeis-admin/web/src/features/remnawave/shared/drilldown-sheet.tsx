/**
 * Generic right-edge drill-down sheet used by Nodes / Hosts / Squads / Users.
 * Wraps shadcn Sheet so all admin drill-downs share the same width, header
 * and footer layout — operators get muscle memory for the close button.
 */
import type { ReactNode } from 'react'

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'

interface DrilldownSheetProps {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly title: ReactNode
  readonly description?: ReactNode
  readonly footer?: ReactNode
  readonly children: ReactNode
}

export function DrilldownSheet({
  open,
  onOpenChange,
  title,
  description,
  footer,
  children,
}: DrilldownSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-md md:max-w-xl"
      >
        <SheetHeader className="border-b border-border/60 px-6 py-4">
          <SheetTitle className="text-base font-semibold">{title}</SheetTitle>
          {description ? (
            <SheetDescription className="text-xs text-muted-foreground">{description}</SheetDescription>
          ) : null}
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-6 py-4">{children}</div>
        {footer ? (
          <div className="flex items-center justify-end gap-2 border-t border-border/60 bg-background/60 px-6 py-3">
            {footer}
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
