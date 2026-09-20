/**
 * The bell in the panel's header: how many alerts are waiting, what the last
 * few of them say, and the way into the notification centre.
 *
 * WHY A BELL AT ALL. Until the centre existed an alert lived exactly as long
 * as its toast — the socket showed it to whoever had the panel open at that
 * second, and nothing kept it. An operator who was away for an hour never
 * learned that a payment had failed. The number here is the server's answer to
 * "what is still unread for me", not a count of toasts this tab happened to
 * see, so it is the same on every device the operator signs in on.
 *
 * THE ANIMATION IS GATED TWICE, and both gates are the operator's own: the
 * panel's «Анимации» switch (Settings → Appearance) and the system's
 * `prefers-reduced-motion`. A bell that shakes through either of them is the
 * defect `three-animations-ignore-reduce-motion` was written about.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { motion } from 'motion/react'
import { Bell, Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { adminQueryKeys } from '@/lib/admin-query-keys'
import { cn } from '@/lib/utils'
import { useAppearanceStore } from '@/lib/theme/appearance-store'
import { usePrefersReducedMotion } from '@/lib/theme/effects-active'
import type { InboxNotification } from '@/features/notification-centre/notification-inbox-api'
import { NotificationRow } from '@/features/notification-centre/notification-row'
import { formatUnreadBadge, toPanelPath } from '@/features/notification-centre/notification-view'
import { RING_MS, useArrivalRing } from '@/features/notification-centre/use-arrival-ring'
import {
  BELL_PAGE_SIZE,
  inboxItems,
  useInboxActions,
  useInboxList,
  useUnreadCount,
} from '@/features/notification-centre/use-notification-inbox'

export const NOTIFICATION_CENTRE_PATH = '/notifications/inbox'

export function NotificationBell() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)

  const animationsEnabled = useAppearanceStore((state) => state.animationsEnabled)
  const reduceMotion = usePrefersReducedMotion()
  const mayMove = animationsEnabled && !reduceMotion

  const { unread, answered } = useUnreadCount()
  // `null` while the server has not answered: the badge reads 0 until then,
  // and counting that as a number makes every first answer look like an arrival.
  const ringing = useArrivalRing(answered ? unread : null, mayMove)

  // The list is fetched when the popover opens, not before: the badge is the
  // only thing the header needs, and eight rows nobody looked at are eight
  // rows of traffic per sign-in.
  const list = useInboxList(
    { unreadOnly: false, category: 'all' },
    { limit: BELL_PAGE_SIZE, enabled: open },
  )
  const actions = useInboxActions()
  const items = inboxItems(list.data)

  // Ages are read while the popover is open, so «2 минуты назад» must not stay
  // «только что» for as long as it stays open. The clock is set when the
  // operator opens it — that is an event, not something to synchronise in an
  // effect — and the interval keeps it moving from there.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!open) return
    const tick = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(tick)
  }, [open])

  function onOpenChange(next: boolean): void {
    if (next) setNow(Date.now())
    setOpen(next)
  }

  async function openNotification(notification: InboxNotification): Promise<void> {
    const path = toPanelPath(notification.url)
    if (notification.readAt === null) {
      // Failing to mark it read must not swallow the navigation: the operator
      // asked to see the thing, and an unread row they can press again is a
      // far smaller problem than a press that did nothing.
      try {
        await actions.markRead(notification.id)
      } catch {
        /* the badge stays as it was; the next refresh corrects it */
      }
    }
    if (path === null) return
    setOpen(false)
    void navigate(path)
  }

  async function removeNotification(notification: InboxNotification): Promise<void> {
    try {
      await actions.remove(notification.id)
    } catch {
      /* the row stays; the list refresh below puts the truth back */
      void queryClient.invalidateQueries({ queryKey: adminQueryKeys.notifications.inbox.all })
    }
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          data-bell-ring={ringing ? 'on' : 'off'}
          aria-label={t('notificationCentre.bellAria', { unread })}
        >
          <motion.span
            animate={ringing ? { rotate: [0, -14, 12, -9, 6, 0] } : { rotate: 0 }}
            transition={{ duration: RING_MS / 1000, ease: 'easeInOut' }}
            className="inline-flex"
          >
            <Bell className="h-4 w-4" />
          </motion.span>
          {unread > 0 && (
            <span
              data-unread-badge={unread}
              className={cn(
                'absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-primary px-1',
                'text-[10px] font-semibold leading-4 text-primary-foreground tabular-nums',
              )}
            >
              {formatUnreadBadge(unread)}
            </span>
          )}
        </Button>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-[22rem] p-0">
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
          <span className="text-sm font-medium">{t('notificationCentre.title')}</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={unread === 0 || actions.isBusy}
            onClick={() => void actions.markAllRead().catch(() => undefined)}
          >
            {t('notificationCentre.markAllRead')}
          </Button>
        </div>

        <div className="max-h-[22rem] overflow-y-auto p-1.5">
          {list.isPending ? (
            <div className="flex items-center justify-center gap-2 px-2 py-8 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('common.loading')}
            </div>
          ) : list.isError ? (
            <p className="px-2 py-8 text-center text-xs text-muted-foreground">
              {t('notificationCentre.loadFailed')}
            </p>
          ) : items.length === 0 ? (
            <div className="px-3 py-8 text-center">
              <p className="text-xs font-medium">{t('notificationCentre.empty')}</p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {t('notificationCentre.emptyHint')}
              </p>
            </div>
          ) : (
            <ul className="space-y-0.5">
              {items.map((notification) => (
                <NotificationRow
                  key={notification.id}
                  notification={notification}
                  now={now}
                  disabled={actions.isBusy}
                  onOpen={(item) => void openNotification(item)}
                  onRemove={(item) => void removeNotification(item)}
                />
              ))}
            </ul>
          )}
        </div>

        <div className="border-t border-border p-1.5">
          <Button
            variant="ghost"
            size="sm"
            className="w-full text-xs"
            onClick={() => {
              setOpen(false)
              void navigate(NOTIFICATION_CENTRE_PATH)
            }}
          >
            {t('notificationCentre.openAll')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
