/**
 * Friendly "coming in the next iteration" card. Kept distinct from
 * <EndpointDegraded /> so operators don't confuse "Remnawave can't do this"
 * with "we haven't built the UI for it yet".
 */
import { Sparkles } from 'lucide-react'

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { cn } from '@/lib/utils'

interface SectionPlaceholderProps {
  readonly title: string
  readonly description: string
  readonly className?: string
}

export function SectionPlaceholder({ title, description, className }: SectionPlaceholderProps) {
  return (
    <Card className={cn('border-dashed bg-card/50', className)}>
      <CardHeader className="flex flex-row items-center gap-3 pb-2">
        <Sparkles className="h-4 w-4 text-primary/60" aria-hidden />
        <div>
          <CardTitle className="text-sm font-medium">{title}</CardTitle>
          <CardDescription className="text-xs">{description}</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="pt-0 text-xs text-muted-foreground">
        Coming next.
      </CardContent>
    </Card>
  )
}
