/**
 * Standard "this endpoint is missing on your Remnawave version" notice.
 *
 * Every section that depends on an endpoint that 2.7.x doesn't expose
 * (`/api/system/recap`, `/api/hwid/stats` on older builds, the entire
 * `ip-control/*` group, etc.) renders this card instead of crashing or
 * silently showing zeros.
 */
import type { ReactNode } from 'react'
import { CircleSlash } from 'lucide-react'

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { cn } from '@/lib/utils'

interface EndpointDegradedProps {
  readonly title: string
  readonly description: string
  readonly hint?: ReactNode
  readonly compact?: boolean
  readonly className?: string
}

export function EndpointDegraded({
  title,
  description,
  hint,
  compact = false,
  className,
}: EndpointDegradedProps) {
  return (
    <Card className={cn('border-dashed', className)}>
      <CardHeader className={cn('flex flex-row items-center gap-3', compact && 'pb-2')}>
        <CircleSlash className="h-4 w-4 text-muted-foreground" aria-hidden />
        <div>
          <CardTitle className="text-sm font-medium">{title}</CardTitle>
          <CardDescription className="text-xs">{description}</CardDescription>
        </div>
      </CardHeader>
      {hint ? (
        <CardContent className="pt-0 text-xs text-muted-foreground">{hint}</CardContent>
      ) : null}
    </Card>
  )
}
