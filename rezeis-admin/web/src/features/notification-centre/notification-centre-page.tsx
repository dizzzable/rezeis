/**
 * Центр уведомлений — every alert the panel raised for this operator, kept
 * instead of shown once and lost.
 *
 * WHAT IS HERE AND WHAT IS NOT. Alerts, not an event log: the same five
 * categories web push carries, decided server-side by one route table. The
 * panel's socket carries fourteen categories of INFO besides those — every
 * sign-in, every payment — and the audit log is already the place to read
 * them. `/audit` is where that question goes.
 *
 * THE COPY IS PERSONAL. Reading and deleting act on this operator's own row;
 * the same alert stays untouched in everyone else's centre. That is also why
 * there is no "for everyone" anywhere on this page — there is no such button
 * to build.
 */
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { Bell, CheckCheck, Loader2, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { PageTitle } from '@/components/layout/page-title'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { FadeIn } from '@/lib/motion'
import { cn } from '@/lib/utils'

import { INBOX_CATEGORIES, type InboxCategory, type InboxNotification } from './notification-inbox-api'
import { NotificationRow } from './notification-row'
import { toPanelPath } from './notification-view'
import { inboxItems, useInboxActions, useInboxList, useUnreadCount } from './use-notification-inbox'

type CategoryFilter = InboxCategory | 'all'

export default function NotificationCentrePage() {
  const { t } = useTranslation()
  const navigate = useNavigate()

  const [unreadOnly, setUnreadOnly] = useState(false)
  const [category, setCategory] = useState<CategoryFilter>('all')

  const filter = useMemo(() => ({ unreadOnly, category }), [unreadOnly, category])
  const list = useInboxList(filter)
  const actions = useInboxActions()
  const items = inboxItems(list.data)
  // The same number the bell shows, from the same cache entry: a mark-all here
  // must not leave the header counting to itself.
  const { unread } = useUnreadCount()

  // One clock for the whole list, ticked here rather than per row: fifty rows
  // each holding their own interval is fifty timers to say the same minute.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(tick)
  }, [])

  async function run(action: () => Promise<unknown>, success?: string): Promise<void> {
    try {
      await action()
      if (success !== undefined) toast.success(success)
    } catch {
      toast.error(t('notificationCentre.actionFailed'))
    }
  }

  async function openNotification(notification: InboxNotification): Promise<void> {
    const path = toPanelPath(notification.url)
    if (notification.readAt === null) {
      try {
        await actions.markRead(notification.id)
      } catch {
        /* an unread row the operator can press again; the navigation matters more */
      }
    }
    if (path !== null) void navigate(path)
  }

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <PageTitle icon={Bell} title={t('notificationCentre.title')} />
            <p className="text-muted-foreground">{t('notificationCentre.subtitle')}</p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={unread === 0 || actions.isBusy}
              onClick={() =>
                void run(() => actions.markAllRead(), t('notificationCentre.markedAllRead'))
              }
            >
              <CheckCheck className="mr-2 h-4 w-4" />
              {t('notificationCentre.markAllRead')}
            </Button>

            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" size="sm" disabled={items.length === 0 || actions.isBusy}>
                  <Trash2 className="mr-2 h-4 w-4" />
                  {t('notificationCentre.clear')}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t('notificationCentre.confirmClearTitle')}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {t('notificationCentre.confirmClearBody')}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                  {/* An Action rather than a Button: both of these finish the
                      dialog, and a plain button inside it would leave the
                      dialog standing over an inbox that had just changed. */}
                  <AlertDialogAction
                    className={buttonVariants({ variant: 'outline' })}
                    onClick={() =>
                      void run(
                        () => actions.clear({ readOnly: true }),
                        t('notificationCentre.cleared'),
                      )
                    }
                  >
                    {t('notificationCentre.clearRead')}
                  </AlertDialogAction>
                  <AlertDialogAction
                    onClick={() =>
                      void run(
                        () => actions.clear({ readOnly: false }),
                        t('notificationCentre.cleared'),
                      )
                    }
                  >
                    {t('notificationCentre.clearEverything')}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      </FadeIn>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-md border border-border p-0.5">
          <Button
            variant="ghost"
            size="sm"
            data-filter-state={unreadOnly ? 'off' : 'on'}
            className={cn('h-7 px-3 text-xs', !unreadOnly && 'bg-muted')}
            onClick={() => setUnreadOnly(false)}
          >
            {t('notificationCentre.filterAll')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            data-filter-state={unreadOnly ? 'on' : 'off'}
            className={cn('h-7 px-3 text-xs', unreadOnly && 'bg-muted')}
            onClick={() => setUnreadOnly(true)}
          >
            {t('notificationCentre.filterUnread')}
            {unread > 0 && <span className="ml-1.5 tabular-nums">{unread}</span>}
          </Button>
        </div>

        <Select
          value={category}
          onValueChange={(value) => setCategory(value as CategoryFilter)}
        >
          <SelectTrigger className="h-8 w-48 text-xs" aria-label={t('notificationCentre.filterCategory')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('notificationCentre.allCategories')}</SelectItem>
            {INBOX_CATEGORIES.map((value) => (
              <SelectItem key={value} value={value}>
                {t(`pushNotifications.categories.${value}`, { defaultValue: value })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-2">
          {list.isPending ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('common.loading')}
            </div>
          ) : list.isError ? (
            <div className="py-16 text-center">
              <p className="text-sm text-muted-foreground">{t('notificationCentre.loadFailed')}</p>
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => void list.refetch()}
              >
                {t('common.retry')}
              </Button>
            </div>
          ) : items.length === 0 ? (
            <div className="py-16 text-center">
              <p className="text-sm font-medium">
                {unreadOnly ? t('notificationCentre.emptyUnread') : t('notificationCentre.empty')}
              </p>
              <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
                {t('notificationCentre.emptyHint')}
              </p>
            </div>
          ) : (
            <>
              <ul className="space-y-1">
                {items.map((notification) => (
                  <NotificationRow
                    key={notification.id}
                    notification={notification}
                    now={now}
                    disabled={actions.isBusy}
                    onOpen={(item) => void openNotification(item)}
                    onRemove={(item) =>
                      void run(() => actions.remove(item.id), t('notificationCentre.removed'))
                    }
                  />
                ))}
              </ul>

              {list.hasNextPage && (
                <div className="flex justify-center py-3">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={list.isFetchingNextPage}
                    onClick={() => void list.fetchNextPage()}
                  >
                    {list.isFetchingNextPage ? (
                      <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                    ) : null}
                    {t('notificationCentre.loadMore')}
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">{t('notificationCentre.retention')}</p>
    </div>
  )
}
