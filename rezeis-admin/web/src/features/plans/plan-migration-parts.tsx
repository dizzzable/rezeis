/**
 * Small pieces the migration steps of the plan delete dialog share. Components
 * only — the decisions they draw live in `plan-migration.ts`.
 */
import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import * as CheckboxPrimitive from '@radix-ui/react-checkbox'
import { Check, Minus } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn, truncate } from '@/lib/utils'

import type { PlanMigrationUser } from './plan-migration-api'
import { describeSubscriber, type MigrationTone } from './plan-migration'

/**
 * A checkbox that draws a MINUS for `'indeterminate'`.
 *
 * The shared `components/ui/checkbox.tsx` renders its check mark for every state
 * the Radix indicator is present in, and the indicator is present for
 * `'indeterminate'` too — so a partly selected list would show a header box
 * that looks fully ticked. Fixed here rather than in the shared component,
 * whose other callers are not part of this change: same classes, one more
 * glyph.
 */
export function MigrationCheckbox({
  className,
  checked,
  ...props
}: ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      checked={checked}
      className={cn(
        'peer h-4 w-4 shrink-0 rounded-sm border border-primary ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground',
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="flex items-center justify-center text-current">
        {checked === 'indeterminate' ? (
          <Minus className="h-3.5 w-3.5" aria-hidden="true" data-glyph="indeterminate" />
        ) : (
          <Check className="h-4 w-4" aria-hidden="true" data-glyph="checked" />
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

/**
 * Tone colours that hold in BOTH themes. The Badge `success`/`warning` variants
 * are light-only (`bg-yellow-100 text-yellow-800` on a dark card), so the tones
 * are spelled with translucent fills and a `dark:` text colour instead.
 */
const TONE_CLASSES: Readonly<Record<MigrationTone | 'success', string>> = {
  caution: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  info: 'border-border bg-muted/60 text-muted-foreground',
  danger: 'border-destructive/40 bg-destructive/10 text-destructive',
  success: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
}

/**
 * A small badge in one of the tones, with an explanation on hover and focus
 * when `hint` is given. The trigger is focusable so the explanation is not a
 * mouse-only affordance; Radix wires it to the trigger as its description.
 */
export function ToneBadge({
  tone,
  hint,
  children,
}: {
  readonly tone: MigrationTone | 'success'
  readonly hint?: string
  readonly children: ReactNode
}) {
  const badge = (
    <Badge
      variant="outline"
      className={cn('whitespace-nowrap px-1.5 py-0 text-[10px] font-medium', TONE_CLASSES[tone])}
    >
      {children}
    </Badge>
  )
  if (hint === undefined) return badge
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className="inline-flex cursor-help rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {badge}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-xs leading-snug">{hint}</TooltipContent>
    </Tooltip>
  )
}

/** Who a row is: the leading name, then the other identifiers in small print. */
export function SubscriberName({
  user,
  subscriptionId,
  className,
}: {
  readonly user: PlanMigrationUser | null | undefined
  readonly subscriptionId: string
  readonly className?: string
}) {
  const { t } = useTranslation()
  const subscriber = describeSubscriber(user, subscriptionId)
  return (
    <div className={cn('flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5', className)}>
      <span
        className={cn('truncate text-sm font-medium', subscriber.anonymous && 'font-mono text-xs')}
        title={subscriber.primary}
      >
        {subscriber.anonymous ? truncate(subscriber.primary, 16) : subscriber.primary}
      </span>
      {subscriber.details.map((detail) => (
        <span key={detail.kind} className="truncate text-xs text-muted-foreground">
          {detail.kind === 'telegramId'
            ? t('plansPage.deleteDialog.migrate.choose.telegramId', { id: detail.value })
            : detail.value}
        </span>
      ))}
    </div>
  )
}
