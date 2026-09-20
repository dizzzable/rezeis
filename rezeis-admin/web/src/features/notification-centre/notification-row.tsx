/**
 * One alert, as it reads in the bell's popover and on the centre's page.
 *
 * The same component in both places on purpose: an operator who learns the row
 * in the popover — what the dot means, where the × is, that the row itself
 * opens the thing it is about — knows the page without learning it twice.
 *
 * The row is a button, not a link with an href. The url is a panel path the
 * router takes, and following it also marks the alert read; a link would offer
 * a middle-click that opens the page in a tab and leaves the alert unread.
 */
import { useTranslation } from 'react-i18next'
import {
  Banknote,
  Bell,
  CreditCard,
  LifeBuoy,
  ServerCog,
  ShieldAlert,
  X,
  type LucideIcon,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

import type { InboxNotification } from './notification-inbox-api'
import { formatNotificationAge, notificationTone, toPanelPath } from './notification-view'

const CATEGORY_ICONS: Readonly<Record<string, LucideIcon>> = {
  support: LifeBuoy,
  payment: CreditCard,
  fraud: ShieldAlert,
  withdrawal: Banknote,
  system: ServerCog,
}

const TONE_CLASSES: Readonly<Record<string, string>> = {
  error: 'text-destructive',
  warning: 'text-amber-500',
  info: 'text-muted-foreground',
}

interface NotificationRowProps {
  readonly notification: InboxNotification
  /** Open what the alert is about. Absent when the alert points nowhere. */
  readonly onOpen: (notification: InboxNotification) => void
  readonly onRemove: (notification: InboxNotification) => void
  readonly disabled?: boolean
  /** The clock the age is measured against — the caller ticks it. */
  readonly now: number
}

export function NotificationRow({
  notification,
  onOpen,
  onRemove,
  disabled = false,
  now,
}: NotificationRowProps) {
  const { t } = useTranslation()
  const tone = notificationTone(notification.severity)
  const Icon = CATEGORY_ICONS[notification.category] ?? Bell
  const unread = notification.readAt === null
  const opens = toPanelPath(notification.url) !== null
  const categoryLabel = t(`pushNotifications.categories.${notification.category}`, {
    defaultValue: notification.category,
  })

  return (
    <li
      data-notification-id={notification.id}
      data-notification-state={unread ? 'unread' : 'read'}
      className={cn(
        'group relative flex items-start gap-2 rounded-md px-2 py-2 transition-colors',
        unread ? 'bg-muted/40' : 'hover:bg-muted/30',
      )}
    >
      <button
        type="button"
        disabled={disabled}
        onClick={() => onOpen(notification)}
        aria-label={notification.title}
        className={cn(
          'flex min-w-0 flex-1 items-start gap-2.5 text-left outline-none',
          'focus-visible:ring-2 focus-visible:ring-ring rounded-md',
          opens ? 'cursor-pointer' : 'cursor-default',
        )}
      >
        <span className="relative mt-0.5 shrink-0">
          <Icon className={cn('h-4 w-4', TONE_CLASSES[tone])} aria-hidden />
          {unread && (
            <span
              data-unread-dot="true"
              className="absolute -right-1 -top-1 h-1.5 w-1.5 rounded-full bg-primary"
            />
          )}
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className={cn('truncate text-sm', unread ? 'font-medium' : 'font-normal')}>
              {notification.title}
            </span>
            <time
              dateTime={notification.createdAt}
              className="shrink-0 text-[11px] tabular-nums text-muted-foreground"
            >
              {formatNotificationAge(notification.createdAt, now, t('notificationCentre.justNow'))}
            </time>
          </span>
          <span className="mt-0.5 block line-clamp-2 text-xs text-muted-foreground">
            {notification.message}
          </span>
          <span className="mt-1 inline-block rounded-full border border-border px-1.5 py-px text-[10px] text-muted-foreground">
            {categoryLabel}
          </span>
        </span>
      </button>

      <Button
        variant="ghost"
        size="icon"
        disabled={disabled}
        onClick={() => onRemove(notification)}
        aria-label={t('notificationCentre.remove')}
        className="h-6 w-6 shrink-0 opacity-60 hover:opacity-100"
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </li>
  )
}
