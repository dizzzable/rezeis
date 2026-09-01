import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Plus, Megaphone, Send, XCircle, Trash2, Loader2, RefreshCw, RotateCcw, Upload, FileImage, FileVideo, X, Pencil, Clock, FlaskConical, Users, Undo2 } from 'lucide-react'
import { useForm, type FieldErrors, type Resolver } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { toast } from 'sonner'

import { useHasPermission } from '@/features/rbac'
import { api } from '@/lib/api'
import { expectArray } from '@/lib/api-utils'
import { adminQueryKeys } from '@/lib/admin-query-keys'
import { getErrorMessage } from '@/lib/http-errors'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Skeleton } from '@/components/ui/skeleton'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
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
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { DatePicker } from '@/components/ui/date-picker'
import { FadeIn } from '@/lib/motion'
import {
  createBroadcastFormSchema,
  type BroadcastCreateRequest,
  type BroadcastFormDraft,
  type BroadcastFormValidationMessages,
} from './broadcast-form-schema'
import { EmojiPicker } from './emoji-picker'
import { EmojiFieldOverlay } from '@/features/custom-emoji/emoji-field-overlay'
import { RenderedCopyPreview } from '@/features/custom-emoji/rendered-copy-preview'
import { usePlans } from '@/features/plans/plans-api'
import { cn, truncate } from '@/lib/utils'

const AUDIENCES = [
  { value: 'ALL', labelKey: 'broadcastPage.audiences.ALL' },
  { value: 'ACTIVE_SUBSCRIBERS', labelKey: 'broadcastPage.audiences.ACTIVE_SUBSCRIBERS' },
  { value: 'UNSUBSCRIBED', labelKey: 'broadcastPage.audiences.UNSUBSCRIBED' },
  { value: 'EXPIRED', labelKey: 'broadcastPage.audiences.EXPIRED' },
  { value: 'TRIAL', labelKey: 'broadcastPage.audiences.TRIAL' },
] as const

const SUB_BUCKETS = ['ACTIVE', 'EXPIRED', 'TRIAL', 'LIMITED', 'NONE'] as const
const PLATFORM_OPTS = ['telegram', 'miniapp', 'web'] as const
const CONTACT_OPTS = ['hasTelegram', 'hasEmail', 'hasWebPush'] as const

function toggleIn(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value]
}

/** A row of toggle chips for one multi-select audience-filter category. */
function FilterChipGroup({
  label,
  options,
  selected,
  onToggle,
}: {
  label: string
  options: ReadonlyArray<{ value: string; label: string }>
  selected: string[]
  onToggle: (value: string) => void
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="flex flex-wrap gap-1.5">
        {options.map((opt) => {
          const active = selected.includes(opt.value)
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onToggle(opt.value)}
              aria-pressed={active}
              className={cn(
                'rounded-full border px-3 py-1 text-xs transition-colors',
                active
                  ? 'border-primary bg-primary/15 text-primary'
                  : 'border-border text-muted-foreground hover:bg-muted',
              )}
            >
              {opt.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function looksLikeHttpUrl(value: string): boolean {
  const trimmed = value.trim()
  return /^https?:\/\//i.test(trimmed)
}

/**
 * Keeps a revocable browser object URL in an external-store subscription.
 * The URL lifecycle belongs to the browser, so React only re-renders after the
 * subscription publishes its new resource instead of mirroring `file` through
 * a synchronous state update in an Effect.
 */
function useObjectUrl(file: File | null | undefined): string | null {
  const resourceRef = useRef<{ file: File; url: string } | null>(null)

  const subscribe = useCallback((onStoreChange: () => void) => {
    if (!file) return () => undefined

    const url = URL.createObjectURL(file)
    resourceRef.current = { file, url }
    onStoreChange()

    return () => {
      URL.revokeObjectURL(url)
      if (resourceRef.current?.url === url) resourceRef.current = null
    }
  }, [file])

  const getSnapshot = useCallback(() => {
    const resource = resourceRef.current
    return resource !== null && resource.file === file ? resource.url : null
  }, [file])

  return useSyncExternalStore(subscribe, getSnapshot, () => null)
}

/**
 * Inline visual preview for attached broadcast media. Accepts either a locally
 * selected `File` (rendered via a revocable object URL) or a remote `url`, and
 * shows an `<img>` for photos or a `<video controls>` for videos so the
 * operator sees exactly what will be broadcast before sending.
 */
function MediaPreview({
  file,
  url,
  mediaType,
  label,
}: {
  file?: File | null
  url?: string | null
  mediaType: 'photo' | 'video'
  label: string
}) {
  const objectUrl = useObjectUrl(file)
  const src = objectUrl ?? (url && url.trim().length > 0 ? url.trim() : null)
  if (!src) return null

  return (
    <div className="space-y-1">
      <p className="text-[11px] font-medium text-muted-foreground">{label}</p>
      <div className="overflow-hidden rounded-md border bg-background">
        {mediaType === 'photo' ? (
          <img src={src} alt="" className="max-h-48 w-full object-contain" />
        ) : (
          <video src={src} controls className="max-h-48 w-full object-contain" />
        )}
      </div>
    </div>
  )
}

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  COMPLETED: 'default',
  PROCESSING: 'secondary',
  // A pending scheduled send used to render as a plain draft with no actions on
  // it: the operator could not see that it existed, when it would fire, or stop
  // it — even though the backend has always accepted the cancel.
  SCHEDULED: 'secondary',
  FAILED: 'destructive',
  CANCELED: 'outline',
  DELETED: 'outline',
}

/**
 * Recipients this broadcast has neither delivered to nor given up on.
 *
 * Clamped at zero rather than trusted: the three counters are written by
 * different code paths at different times (`checkAndFinalize` sets success and
 * failure; the total is stamped at staging), so a transient read can show more
 * settled than staged. A negative "still delivering" would be worse than not
 * showing it.
 */
/**
 * How many delivered messages a recall could still take out of a chat.
 *
 * ── Why this is neither `successCount` nor `success - canceled` ────────────
 *
 * `successCount` is how many people the broadcast REACHED, and a recall
 * deliberately leaves it alone — the send did happen. Gating the button on it
 * kept the button lit after everything had been recalled, and pressing it hit
 * "No sent messages found to delete": a red error for an action this screen had
 * just offered.
 *
 * Subtracting the recalled ones is closer and still wrong, because a broadcast
 * also reaches WEB-ONLY users through the cabinet feed. Those rows are SENT
 * with no Telegram message id, so no `deleteMessage` can touch them — with 40
 * web-only recipients out of 100, the dialog offered to pull the message from
 * 100 chats when 60 existed, and the button stayed lit over the 40 for ever.
 *
 * The API counts them with the recall's own predicate now, so the number on
 * screen and the work the endpoint finds cannot disagree. The subtraction
 * survives only as a fallback for a panel talking to an API that predates the
 * field.
 */
function stillStandingOf(row: {
  readonly successCount: number
  readonly canceledCount?: number
  readonly recallableCount?: number
}): number {
  if (typeof row.recallableCount === 'number') return Math.max(0, row.recallableCount)
  return Math.max(0, row.successCount - (row.canceledCount ?? 0))
}

/**
 * Failures a retry could still fix.
 *
 * A recipient who blocked the bot is not one of them: they cannot receive this
 * broadcast until they unblock it, and the relay deduplicates the retry by the
 * same event id, so pressing the button never moved the number. Counting them
 * together made "retry failed" look broken on every mature audience.
 */
function realFailuresOf(row: {
  readonly failedCount: number
  readonly blockedCount?: number
}): number {
  return Math.max(0, row.failedCount - (row.blockedCount ?? 0))
}

function pendingOf(row: {
  readonly totalCount: number
  readonly successCount: number
  readonly failedCount: number
  readonly pendingCount?: number
}): number {
  // ── COUNTED, NOT DERIVED ────────────────────────────────────────────────
  //
  // The arithmetic below assumes every recipient is delivered, failed, or still
  // going. Cancelling a send and recalling one both produce a fourth state, and
  // each of those recipients added one to this subtraction — so a recalled
  // broadcast reported "still delivering" to people whose message had just been
  // withdrawn, permanently, with no work left anywhere to clear it.
  //
  // The API counts the PENDING rows now. The subtraction stays only as a
  // fallback for a panel talking to an API that predates that field.
  if (typeof row.pendingCount === 'number') return Math.max(0, row.pendingCount)
  return Math.max(0, row.totalCount - row.successCount - row.failedCount)
}

/** A draft loaded back into the compose dialog for correction. */
interface BroadcastDraftDetail {
  readonly id: string
  readonly audience: string
  readonly promoCode: string | null
  readonly audienceFilter: {
    readonly subscription?: string[]
    readonly planIds?: string[]
    readonly platforms?: string[]
    readonly contact?: string[]
    readonly inactiveDays?: number
  } | null
  readonly status: string
  /** Due time of a pending schedule; `null` for a plain draft. */
  readonly scheduledAt: string | null
  readonly payload: {
    readonly title: string | null
    readonly text: string | null
    readonly mediaType: 'none' | 'photo' | 'video'
    readonly mediaFileId: string | null
    readonly emailEnabled: boolean
    readonly telegramChannelChatId: string | null
  }
}

interface BroadcastRow {
  readonly id: string
  readonly audience: string
  readonly status: string
  readonly successCount: number
  readonly totalCount: number
  readonly failedCount: number
  /** Counted, not derived — see `pendingOf`. Absent on an older API. */
  readonly pendingCount?: number
  /** Cancelled before dispatch, or recalled after it. */
  readonly canceledCount?: number
  /** Messages a recall could still remove. Absent on an older API. */
  readonly recallableCount?: number
  /** What the public channel copy is, if any. Absent on an older API. */
  readonly channelPost?: 'none' | 'addressable' | 'unaddressable'
  /** Recipients who have blocked the bot. Absent on an older API. */
  readonly blockedCount?: number
  /** Delivered so far, counted live. Absent on an older API. */
  readonly deliveredCount?: number
  /** Due time of a scheduled send; `null` for an immediate one. */
  readonly scheduledAt: string | null
  readonly createdAt: string
}

export default function BroadcastPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [showCreate, setShowCreate] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  // A draft or a pending schedule reopened in the compose dialog. Separate
  // from `editId`, which edits a broadcast that has ALREADY gone out (a
  // Telegram message edit) — a different operation on a different object.
  const [editDraftId, setEditDraftId] = useState<string | null>(null)

  // ── AFFORDANCES THE CALLER ACTUALLY HAS ─────────────────────────────────
  //
  // The default `operator` role holds broadcasts view/create/edit/run and NOT
  // delete, and this screen gated nothing — so that role was shown Recall and
  // Delete, and both answered 403. Recall is the worse of the two: it is the
  // action bounded by Telegram's 48-hour window, so it is reached for exactly
  // when a broadcast has gone out wrong and there is no time to find out that
  // the button was never going to work.
  const canDeleteBroadcasts = useHasPermission('broadcasts', 'delete')

  const { data, isLoading, refetch } = useQuery<ReadonlyArray<BroadcastRow>>({
    queryKey: adminQueryKeys.broadcast.all,
    queryFn: async ({ signal }) =>
      expectArray<BroadcastRow>((await api.get('/admin/broadcast/drafts', { signal })).data),
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  })

  const cancelMutation = useMutation({
    mutationFn: (id: string) => api.post(`/admin/broadcast/${id}/cancel`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminQueryKeys.broadcast.all })
      toast.success(t('broadcastPage.toast.canceled'))
    },
    onError: (err) =>
      toast.error(getErrorMessage(err, t('broadcastPage.toast.cancelFailed'))),
  })

  /**
   * Re-delivers only the recipients a broadcast failed to reach.
   *
   * The endpoint has always existed and has always been correct — it resets
   * FAILED rows to PENDING, and delivery reads only PENDING ones, so nobody who
   * already received the broadcast is written to twice. It simply had no button,
   * which is why a half-delivered broadcast was re-composed by hand.
   */
  const retryMutation = useMutation({
    mutationFn: (id: string) => api.post(`/admin/broadcast/${id}/retry`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminQueryKeys.broadcast.all })
      toast.success(t('broadcastPage.toast.retryStarted'))
    },
    onError: (err) =>
      toast.error(getErrorMessage(err, t('broadcastPage.toast.retryFailed'))),
  })

  // ── RECALL: take the messages back out of Telegram ────────────────────
  //
  // The endpoint existed from the start and nothing on this page called it, so
  // a broadcast sent by mistake could only be deleted — which removes the
  // RECORD and leaves every message sitting in every recipient's chat, now with
  // no stored message ids, so it can never be recalled at all. The remedy was
  // reachable only by hand-crafting a DELETE.
  const recallMutation = useMutation({
    mutationFn: (id: string) =>
      api.delete<{ channel?: 'deleted' | 'no-post' | 'unaddressable' | 'failed' }>(
        `/admin/broadcast/${id}/messages`,
      ),
    onSuccess: (response) => {
      queryClient.invalidateQueries({ queryKey: adminQueryKeys.broadcast.all })
      // A recall that left the PUBLIC copy up is the one outcome the operator
      // has to act on by hand, so it does not get to look like a success.
      //
      // `unaddressable` belongs here too, and it is the likelier of the two: it
      // means the channel post went out but its message id was never recorded
      // (an older bot answers a bodiless 204, and the relay's direct fallback
      // never records one at all). Folded into "no post", it produced the exact
      // outcome this feature exists to stop — recalled from four hundred
      // private chats, still up in public, reported as success.
      const channel = response?.data?.channel
      if (channel === 'failed' || channel === 'unaddressable') {
        toast.warning(t('broadcastPage.toast.recallChannelFailed'))
        return
      }
      toast.success(t('broadcastPage.toast.recallStarted'))
    },
    onError: (err: unknown) =>
      toast.error(getErrorMessage(err, t('broadcastPage.toast.recallFailed'))),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/broadcast/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminQueryKeys.broadcast.all })
      toast.success(t('broadcastPage.toast.deleted'))
    },
  })

  const stats = data?.reduce(
    (acc: { total: number; completed: number; processing: number }, b) => {
      acc.total++
      if (b.status === 'COMPLETED') acc.completed++
      if (b.status === 'PROCESSING') acc.processing++
      return acc
    },
    { total: 0, completed: 0, processing: 0 },
  ) ?? { total: 0, completed: 0, processing: 0 }

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Megaphone className="h-6 w-6" /> {t('broadcastPage.title')}
            </h1>
            <p className="text-muted-foreground">{t('broadcastPage.subtitle')}</p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="icon"
              onClick={() => refetch()}
              aria-label={t('broadcastPage.refreshBroadcasts')}
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
            <Button onClick={() => setShowCreate(true)}><Plus className="h-4 w-4 mr-2" /> {t('broadcastPage.newButton')}</Button>
          </div>
        </div>
      </FadeIn>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: t('broadcastPage.stats.total'), value: stats.total, icon: Megaphone },
          { label: t('broadcastPage.stats.completed'), value: stats.completed, icon: Send },
          { label: t('broadcastPage.stats.processing'), value: stats.processing, icon: Loader2 },
        ].map((s) => (
          <Card key={s.label}>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <s.icon className="h-5 w-5 text-muted-foreground" />
                <div>
                  <p className="text-2xl font-bold tabular-nums">{s.value}</p>
                  <p className="text-xs text-muted-foreground">{s.label}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-3">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
          ) : !data?.length ? (
            <div className="py-16 text-center text-muted-foreground">
              <Megaphone className="h-10 w-10 mx-auto mb-3 opacity-30" />
              <p>{t('broadcastPage.empty')}</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ID</TableHead>
                  <TableHead>{t('broadcastPage.columns.audience')}</TableHead>
                  <TableHead>{t('broadcastPage.columns.status')}</TableHead>
                  <TableHead>{t('broadcastPage.columns.progress')}</TableHead>
                  <TableHead>{t('broadcastPage.columns.created')}</TableHead>
                  <TableHead className="w-20" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.map((b) => (
                  <TableRow key={b.id}>
                    <TableCell className="font-mono text-xs">{b.id}</TableCell>
                    <TableCell><Badge variant="outline">{String(t(`broadcastPage.audiences.${b.audience}`, b.audience))}</Badge></TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[b.status] ?? 'secondary'}>{String(t(`broadcastPage.statuses.${b.status}`, b.status))}</Badge>
                    </TableCell>
                    <TableCell className="tabular-nums text-sm">
                      {/*
                        THE LIVE COUNT, not the finaliser's. `successCount` is
                        written once, at the end, so this cell showed a green 0
                        for the entire run — a send half-way through 400 people
                        read "0/400 (200 still delivering)", with 200 delivered
                        and nowhere on screen saying so. This is the number an
                        operator watches to decide whether a send is going well.
                      */}
                      <span className="text-emerald-600">{b.deliveredCount ?? b.successCount}</span>
                      <span className="text-muted-foreground">/{b.totalCount}</span>
                      {/* Failures MINUS the blocked ones, which get their own
                          number. Together they were "N ошибок" beside a retry
                          button that could not move the count — on a mature
                          audience most of that N is people who blocked the bot,
                          which no retry can change. */}
                      {realFailuresOf(b) > 0 && (
                        <span className="text-destructive ml-1">
                          ({t('broadcastPage.failedCount', { count: realFailuresOf(b) })})
                        </span>
                      )}
                      {(b.blockedCount ?? 0) > 0 && (
                        <span className="text-muted-foreground ml-1">
                          ({t('broadcastPage.blockedCount', { count: b.blockedCount ?? 0 })})
                        </span>
                      )}
                      {/*
                        The third number. `SENT` now means a delivery the relay
                        proved, so between the two counters there is a real
                        population: recipients whose relay attempt timed out and
                        whose batch will be retried. Rendering only success and
                        failure silently folds those into "not delivered", which
                        is the same class of claim the status change removed —
                        an unknown shown as one of the extremes.
                      */}
                      {pendingOf(b) > 0 && (
                        <span className="text-muted-foreground ml-1">
                          ({t('broadcastPage.pendingCount', { count: pendingOf(b) })})
                        </span>
                      )}
                      {/* A recall is not a failed delivery and not a pending
                          one; without its own number it had nowhere to show,
                          and the withdrawal was invisible on the row it
                          happened to. */}
                      {(b.canceledCount ?? 0) > 0 && (
                        <span className="text-muted-foreground ml-1">
                          ({t(
                            b.status === 'COMPLETED'
                              ? 'broadcastPage.recalledCount'
                              : 'broadcastPage.canceledCount',
                            { count: b.canceledCount ?? 0 },
                          )})
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {/* A scheduled send shows WHEN, not when it was composed:
                          the due time is the only thing an operator wants from
                          this row, and it was nowhere on screen at all. */}
                      {b.status === 'SCHEDULED' && b.scheduledAt
                        ? t('broadcastPage.scheduledFor', {
                            when: new Date(b.scheduledAt).toLocaleString('ru-RU'),
                          })
                        : new Date(b.createdAt).toLocaleString('ru-RU')}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        {['DRAFT', 'SCHEDULED'].includes(b.status) && (
                          <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground"
                            aria-label={t('broadcastPage.editDraft')}
                            title={t('broadcastPage.editDraft')}
                            onClick={() => setEditDraftId(b.id)}>
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        {['PROCESSING', 'SCHEDULED'].includes(b.status) && (
                          <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground"
                            aria-label={t('broadcastPage.cancelBroadcast')}
                            onClick={() => cancelMutation.mutate(b.id)}>
                            <XCircle className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        {/* Only worth offering when there is something to retry. */}
                        {['COMPLETED', 'FAILED'].includes(b.status) && realFailuresOf(b) > 0 && (
                          <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground"
                            aria-label={t('broadcastPage.retryFailed', { count: realFailuresOf(b) })}
                            title={t('broadcastPage.retryFailed', { count: realFailuresOf(b) })}
                            disabled={retryMutation.isPending}
                            onClick={() => retryMutation.mutate(b.id)}>
                            <RotateCcw className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        {b.status === 'COMPLETED' && (
                          <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground"
                            aria-label={t('broadcastPage.editBroadcast')}
                            onClick={() => setEditId(b.id)}>
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        {/* Recall stands BEFORE delete, because delete destroys
                            the message ids recall needs and there is no way
                            back from that. */}
                        {/* Also offered when only the CHANNEL copy is left: a
                            broadcast delivered to web-only users has no
                            Telegram message ids at all, so every recipient
                            count is zero while the post anyone can read is
                            still up. `unaddressable` counts too — pressing it
                            is how the operator learns the post exists and has
                            to be removed by hand, and hiding the button made
                            that warning unreachable. */}
                        {canDeleteBroadcasts &&
                          b.status === 'COMPLETED' &&
                          (stillStandingOf(b) > 0 || (b.channelPost ?? 'none') !== 'none') && (
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground"
                                aria-label={t('broadcastPage.recallMessages')}
                                title={t('broadcastPage.recallMessages')}
                                disabled={recallMutation.isPending}>
                                <Undo2 className="h-3.5 w-3.5" />
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>{t('broadcastPage.recallDialogTitle')}</AlertDialogTitle>
                                <AlertDialogDescription>
                                  {stillStandingOf(b) === 0
                                    ? t('broadcastPage.recallChannelOnlyConfirm')
                                    : t('broadcastPage.recallConfirm', { count: stillStandingOf(b) })}
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel disabled={recallMutation.isPending}>
                                  {t('common.cancel')}
                                </AlertDialogCancel>
                                <AlertDialogAction
                                  disabled={recallMutation.isPending}
                                  onClick={() => recallMutation.mutate(b.id)}>
                                  {t('broadcastPage.recallDialogAction')}
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        )}
                        {canDeleteBroadcasts &&
                          ['DRAFT', 'SCHEDULED', 'COMPLETED', 'CANCELED', 'FAILED'].includes(b.status) && (
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-7 w-7 text-destructive"
                                aria-label={t('broadcastPage.deleteBroadcast')}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>
                                  {t('broadcastPage.deleteDialogTitle')}
                                </AlertDialogTitle>
                                <AlertDialogDescription>
                                  {/* On a SENT broadcast this is not "undo": the
                                      messages stay in every chat and the ids
                                      that could recall them are destroyed. The
                                      dialog used to describe both cases with
                                      the same sentence. */}
                                  {b.status === 'COMPLETED' && stillStandingOf(b) > 0
                                    ? t('broadcastPage.deleteConfirmSent', {
                                        count: stillStandingOf(b),
                                      })
                                    : t('broadcastPage.deleteConfirm')}
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel disabled={deleteMutation.isPending}>
                                  {t('common.cancel')}
                                </AlertDialogCancel>
                                <AlertDialogAction
                                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                  disabled={deleteMutation.isPending}
                                  onClick={() => deleteMutation.mutate(b.id)}
                                >
                                  {t('broadcastPage.deleteDialogAction')}
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Create Dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('broadcastPage.newButton')}</DialogTitle>
            <DialogDescription>{t('broadcastPage.form.description')}</DialogDescription>
          </DialogHeader>
          <CreateBroadcastForm onClose={() => setShowCreate(false)} />
        </DialogContent>
      </Dialog>

      {/* Correcting a draft or a pending schedule: the same compose dialog,
          loaded with what is already there. Keyed by the id so reopening a
          different draft mounts a fresh form rather than showing the last one. */}
      <Dialog
        open={editDraftId !== null}
        onOpenChange={(open) => {
          if (!open) setEditDraftId(null)
        }}
      >
        <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('broadcastPage.editDraft')}</DialogTitle>
            <DialogDescription>{t('broadcastPage.form.description')}</DialogDescription>
          </DialogHeader>
          {editDraftId !== null && (
            <CreateBroadcastForm
              key={editDraftId}
              draftId={editDraftId}
              onClose={() => setEditDraftId(null)}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={editId !== null} onOpenChange={(open) => { if (!open) setEditId(null) }}>
        <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('broadcastPage.edit.title')}</DialogTitle>
            <DialogDescription>{t('broadcastPage.edit.description')}</DialogDescription>
          </DialogHeader>
          {editId !== null && (
            <EditBroadcastForm broadcastId={editId} onClose={() => setEditId(null)} />
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ── Create form ───────────────────────────────────────────────────────────────

interface UploadedMedia {
  readonly mediaType: 'photo' | 'video'
  readonly fileId: string
  readonly fileName: string
  readonly mimeType: string
  readonly sizeBytes: number
}

/**
 * The compose dialog, used both to write a new broadcast and to correct one
 * that has not gone out yet.
 *
 * `draftId` is what makes the second case possible. Without it a saved draft
 * was unreachable: the list showed it, and offered no way to open, change,
 * send or remove it, so drafts left behind by a test send simply accumulated.
 */
function CreateBroadcastForm({
  onClose,
  draftId = null,
}: {
  onClose: () => void
  draftId?: string | null
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const validationMessages = useMemo<BroadcastFormValidationMessages>(() => ({
    audienceInvalid: t('broadcastPage.form.validation.audienceInvalid'),
    titleTooLong: t('broadcastPage.form.validation.titleTooLong'),
    textRequired: t('broadcastPage.form.validation.textRequired'),
    textTooLong: t('broadcastPage.form.validation.textTooLong'),
    captionTooLong: t('broadcastPage.form.validation.captionTooLong'),
    promoCodeTooLong: t('broadcastPage.form.validation.promoCodeTooLong'),
    promoCodeInvalid: t('broadcastPage.form.validation.promoCodeInvalid'),
    mediaTypeInvalid: t('broadcastPage.form.validation.mediaTypeInvalid'),
    mediaRequired: t('broadcastPage.form.validation.mediaRequired'),
    mediaTooLong: t('broadcastPage.form.validation.mediaTooLong'),
    mediaUrlInvalid: t('broadcastPage.form.validation.mediaUrlInvalid'),
    mediaFileIdInvalid: t('broadcastPage.form.validation.mediaFileIdInvalid'),
    telegramChannelChatIdInvalid: t('broadcastPage.form.validation.telegramChannelChatIdInvalid'),
  }), [t])
  const formSchema = useMemo(() => createBroadcastFormSchema(validationMessages), [validationMessages])
  const form = useForm<BroadcastFormDraft, unknown, BroadcastCreateRequest>({
    defaultValues: {
      audience: 'ALL',
      title: '',
      text: '',
      promoCode: '',
      mediaType: 'none',
      mediaSourceMode: 'upload',
      mediaValue: '',
      emailEnabled: false,
      telegramChannelChatId: '',
    },
    mode: 'onSubmit',
    reValidateMode: 'onBlur',
    resolver: zodResolver(formSchema) as Resolver<BroadcastFormDraft, unknown, BroadcastCreateRequest>,
  })
  const [formErrors, setFormErrors] = useState<Record<string, string>>({})
  const [audience, setAudience] = useState('ALL')
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [promoCode, setPromoCode] = useState('')
  const [mediaType, setMediaType] = useState<'none' | 'photo' | 'video'>('none')
  const [mediaSourceMode, setMediaSourceMode] = useState<'upload' | 'url' | 'fileId'>('upload')
  const [mediaValue, setMediaValue] = useState('')
  // Structured audience filter (multi-select). When any is set it supersedes
  // the `audience` segment above (backend combines categories with AND).
  const [subBuckets, setSubBuckets] = useState<string[]>([])
  const [planFilters, setPlanFilters] = useState<string[]>([])
  const [platformFilters, setPlatformFilters] = useState<string[]>([])
  const [contactFilters, setContactFilters] = useState<string[]>([])
  const [inactiveDays, setInactiveDays] = useState('')
  // Plan catalog for the plan chips. Deliberately the FULL catalog, not
  // `{ active: true }`: the backend matches `planSnapshot.id` on a
  // subscription, so a switched-off or archived plan still has live
  // subscribers — and they are exactly the people a "your plan is being
  // retired" broadcast is for. Reuses the shared `usePlans` query (one
  // cache slot panel-wide, 5-minute staleTime) instead of a second reader
  // of /admin/plans; it only fetches while this dialog is mounted.
  const { data: plans = [], isLoading: plansLoading } = usePlans()

  // Audience preview. `GET /admin/broadcast/:id/audience-preview` counts a
  // SAVED broadcast, so a count needs a draft row to exist: the first check
  // creates one, later checks PATCH the same row, and the send / test send
  // reuse it. The row the operator previewed is therefore the row that gets
  // delivered, so the number and the recipients cannot drift apart.
  // Seeded with the draft being edited, so `saveDraft` PATCHes it instead of
  // creating a second row.
  const draftIdRef = useRef<string | null>(draftId)
  const [previewCount, setPreviewCount] = useState<number | null>(null)
  const [previewedSignature, setPreviewedSignature] = useState<string | null>(null)
  // Additive delivery channels (on top of the always-on cabinet/web-push/TG-DM
  // fanout): email every resolved recipient with an address, and/or post the
  // broadcast once to an operator-configured Telegram channel/group.
  const [emailEnabled, setEmailEnabled] = useState(false)
  const [telegramChannelChatId, setTelegramChannelChatId] = useState('')
  const [uploaded, setUploaded] = useState<UploadedMedia | null>(null)
  // The raw selected file, kept only for the local inline preview (the actual
  // send uses the Telegram file_id returned by the upload endpoint).
  const [previewFile, setPreviewFile] = useState<File | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [scheduleEnabled, setScheduleEnabled] = useState(false)
  const [scheduledDate, setScheduledDate] = useState<Date | undefined>(undefined)
  const [scheduledTime, setScheduledTime] = useState('12:00')

  /**
   * Loads the draft being edited into the form, once.
   *
   * Guarded by `draftId` rather than by emptiness of the fields: a draft whose
   * text is genuinely empty must still load, and re-seeding on every render
   * would fight the operator's typing.
   */
  const { data: editing } = useQuery({
    queryKey: [...adminQueryKeys.broadcast.all, 'draft', draftId],
    queryFn: async () => {
      const response = await api.get<BroadcastDraftDetail>(
        `/admin/broadcast/${encodeURIComponent(draftId as string)}`,
      )
      return response.data
    },
    enabled: draftId !== null,
    staleTime: 0,
  })

  const seededRef = useRef(false)
  useEffect(() => {
    if (editing === undefined || seededRef.current) return
    seededRef.current = true
    setAudience(editing.audience)
    setTitle(editing.payload.title ?? '')
    setText(editing.payload.text ?? '')
    setPromoCode(editing.promoCode ?? '')
    setMediaType(editing.payload.mediaType)
    if (editing.payload.mediaFileId !== null) {
      setMediaSourceMode('fileId')
      setMediaValue(editing.payload.mediaFileId)
    }
    setEmailEnabled(editing.payload.emailEnabled)
    setTelegramChannelChatId(editing.payload.telegramChannelChatId ?? '')
    const filter = editing.audienceFilter
    if (filter) {
      setSubBuckets(filter.subscription ?? [])
      setPlanFilters(filter.planIds ?? [])
      setPlatformFilters(filter.platforms ?? [])
      setContactFilters(filter.contact ?? [])
      setInactiveDays(filter.inactiveDays === undefined ? '' : String(filter.inactiveDays))
    }
    // ── THE SCHEDULE COMES BACK TOO ──────────────────────────────────────
    //
    // Without this the dialog opened with the toggle off, so the one submit
    // button read "send now" and pressing it mailed the whole audience
    // immediately while nulling the stored time — the very thing the schedule
    // guard was added to prevent, reached from the other direction. Opening a
    // pending send to fix a typo must not be a way to fire it.
    if (editing.scheduledAt !== null) {
      const due = new Date(editing.scheduledAt)
      setScheduleEnabled(true)
      setScheduledDate(due)
      setScheduledTime(
        `${String(due.getHours()).padStart(2, '0')}:${String(due.getMinutes()).padStart(2, '0')}`,
      )
    }
  }, [editing])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textRef = useRef<HTMLTextAreaElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)

  function insertTitleAtCaret(emoji: string): void {
    const el = titleRef.current
    if (!el) {
      setTitle((prev) => (prev + emoji).slice(0, 128))
      return
    }
    const start = el.selectionStart ?? title.length
    const end = el.selectionEnd ?? title.length
    const next = (title.slice(0, start) + emoji + title.slice(end)).slice(0, 128)
    setTitle(next)
    requestAnimationFrame(() => {
      el.focus()
      const caret = Math.min(start + emoji.length, next.length)
      el.setSelectionRange(caret, caret)
    })
  }

  function insertAtCaret(emoji: string): void {
    const el = textRef.current
    if (!el) {
      setText((prev) => prev + emoji)
      return
    }
    const start = el.selectionStart ?? text.length
    const end = el.selectionEnd ?? text.length
    const next = text.slice(0, start) + emoji + text.slice(end)
    setText(next)
    requestAnimationFrame(() => {
      el.focus()
      const caret = start + emoji.length
      el.setSelectionRange(caret, caret)
    })
  }

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData()
      formData.append('file', file)
      const res = await api.post<UploadedMedia>('/admin/broadcast/upload-media', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      return res.data
    },
    onSuccess: (data) => {
      setUploaded(data)
      setMediaType(data.mediaType)
      setMediaValue(data.fileId)
      toast.success(t('broadcastPage.upload.success'))
    },
    onError: (err: { response?: { data?: { message?: string } } }) => {
      toast.error(err.response?.data?.message ?? t('broadcastPage.upload.failed'))
    },
  })

  function handleFile(file: File): void {
    if (file.size > 50 * 1024 * 1024) {
      toast.error(t('broadcastPage.upload.tooLarge'))
      return
    }
    setPreviewFile(file)
    uploadMutation.mutate(file)
  }

  function handleDrop(e: React.DragEvent<HTMLButtonElement>): void {
    e.preventDefault()
    setIsDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }

  function handleDragOver(e: React.DragEvent<HTMLButtonElement>): void {
    e.preventDefault()
    setIsDragging(true)
  }

  function handleDragLeave(e: React.DragEvent<HTMLButtonElement>): void {
    e.preventDefault()
    setIsDragging(false)
  }

  function clearUpload(): void {
    setUploaded(null)
    setPreviewFile(null)
    setMediaValue('')
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  function buildAudienceFilter(): Record<string, unknown> | undefined {
    const filter: Record<string, unknown> = {}
    if (subBuckets.length > 0) filter.subscription = subBuckets
    // `planIds` is the live field: `normalizeAudienceFilter` reads it and
    // `buildFromFilter` turns it into a `planSnapshot.id` match that feeds
    // BOTH the preview count and delivery. (The broadcast row also carries
    // an `audiencePlanId` column — nothing branches on it; do not wire UI
    // to that one.)
    if (planFilters.length > 0) filter.planIds = planFilters
    if (platformFilters.length > 0) filter.platforms = platformFilters
    if (contactFilters.length > 0) filter.contact = contactFilters
    const days = Number.parseInt(inactiveDays, 10)
    if (Number.isFinite(days) && days > 0) filter.inactiveDays = days
    return Object.keys(filter).length > 0 ? filter : undefined
  }

  // Identity of the audience currently described by the form. A count is
  // only shown while it still matches — a number computed for a different
  // set of chips is worse than no number, because the operator trusts it.
  const audienceSignature = JSON.stringify({
    audience,
    filter: buildAudienceFilter() ?? null,
  })

  /**
   * Create the draft on first use, PATCH the same row afterwards, and hand
   * back its id. `audienceFilter` is ALWAYS present on the PATCH (`{}` when
   * every chip was cleared): an absent key leaves the stored filter
   * untouched server-side, which would send to the audience of an earlier
   * preview. `{}` normalises back to "no filter" and falls through to the
   * `audience` preset, which is what an empty form means.
   */
  async function saveDraft(body: BroadcastCreateRequest | { audience: string }): Promise<string> {
    const audienceFilter = buildAudienceFilter()
    const existingId = draftIdRef.current
    if (existingId !== null) {
      await api.patch(`/admin/broadcast/drafts/${encodeURIComponent(existingId)}`, {
        ...body,
        audienceFilter: audienceFilter ?? {},
      })
      return existingId
    }
    const response = await api.post<{ id: string }>(
      '/admin/broadcast/drafts',
      audienceFilter ? { ...body, audienceFilter } : body,
    )
    draftIdRef.current = response.data.id
    return response.data.id
  }

  const previewMutation = useMutation({
    mutationFn: async () => {
      // Captured before the awaits so a count can never be attributed to a
      // filter the operator changed while the request was in flight.
      const signature = audienceSignature
      const draftId = await saveDraft({ audience })
      const response = await api.get<{ totalRecipients: number }>(
        `/admin/broadcast/${encodeURIComponent(draftId)}/audience-preview`,
      )
      return { total: response.data.totalRecipients, signature }
    },
    onSuccess: ({ total, signature }) => {
      setPreviewCount(total)
      setPreviewedSignature(signature)
      queryClient.invalidateQueries({ queryKey: adminQueryKeys.broadcast.all })
    },
    onError: (err) =>
      toast.error(getErrorMessage(err, t('broadcastPage.audienceFilters.preview.failed'))),
  })

  const createMutation = useMutation({
    mutationFn: async (payload: BroadcastCreateRequest) => {
      const delayMinutes = scheduleEnabled
        ? computeDelayMinutes(combineDateTime(scheduledDate, scheduledTime))
        : undefined

      // ── "Schedule" must never quietly mean "send now" ──────────────────
      //
      // With the toggle on and no usable date — none picked, or one less than a
      // minute away — this used to post an empty body, which is an IMMEDIATE
      // send to the whole audience, while the button still read "Запланировать".
      // A slip of the date was a blast. Refuse instead, before the draft is even
      // saved.
      if (scheduleEnabled && delayMinutes === undefined) {
        throw new Error(t('broadcastPage.toast.scheduleNeedsFutureTime'))
      }

      const draftId = await saveDraft(payload)
      return api.post(
        `/admin/broadcast/${encodeURIComponent(draftId)}/send`,
        delayMinutes !== undefined ? { delayMinutes } : {},
      )
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminQueryKeys.broadcast.all })
      const scheduled =
        scheduleEnabled &&
        computeDelayMinutes(combineDateTime(scheduledDate, scheduledTime)) !== undefined
      toast.success(scheduled ? t('broadcastPage.toast.scheduled') : t('broadcastPage.toast.created'))
      onClose()
    },
    onError: (err: { response?: { data?: { message?: string } }; message?: string }) =>
      toast.error(
        err.response?.data?.message ?? err.message ?? t('broadcastPage.toast.createFailed'),
      ),
  })

  /** Persists the edits and leaves the broadcast where it is. */
  const saveMutation = useMutation({
    mutationFn: async (payload: BroadcastCreateRequest) => {
      await saveDraft(payload)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminQueryKeys.broadcast.all })
      toast.success(t('broadcastPage.toast.draftSaved'))
      onClose()
    },
    onError: (err: { response?: { data?: { message?: string } }; message?: string }) =>
      toast.error(
        err.response?.data?.message ?? err.message ?? t('broadcastPage.toast.createFailed'),
      ),
  })

  const testMutation = useMutation({
    mutationFn: async (payload: BroadcastCreateRequest) => {
      const draftId = await saveDraft(payload)
      return api.post<{ draftRemoved?: boolean }>(
        `/admin/broadcast/${encodeURIComponent(draftId)}/test`,
        {},
      )
    },
    onSuccess: (response) => {
      // The endpoint destroys the preview shell only when the caller ALSO holds
      // `broadcasts:delete`, and it now says which happened. Forgetting the id
      // unconditionally was wrong for everyone else: the row was still there,
      // the next save created a second one, and a caller without delete could
      // remove neither — one stray draft per press of "test send".
      if (response?.data?.draftRemoved !== false) {
        draftIdRef.current = null
      }
      queryClient.invalidateQueries({ queryKey: adminQueryKeys.broadcast.all })
      toast.success(t('broadcastPage.toast.testSent'))
    },
    onError: (err: { response?: { data?: { message?: string } } }) =>
      toast.error(err.response?.data?.message ?? t('broadcastPage.toast.testFailed')),
  })

  function validateThen(onValid: (payload: BroadcastCreateRequest) => void) {
    const draft: BroadcastFormDraft = {
      audience,
      title,
      text,
      promoCode,
      mediaType,
      mediaSourceMode,
      mediaValue,
      emailEnabled,
      telegramChannelChatId,
    }
    form.reset(draft)
    return form.handleSubmit(
      (payload) => {
        setFormErrors({})
        onValid(payload)
      },
      (errors) => setFormErrors(flattenHookFormErrors(errors)),
    )
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>): void {
    void validateThen((payload) => createMutation.mutate(payload))(e)
  }

  function handleTest(): void {
    void validateThen((payload) => testMutation.mutate(payload))()
  }

  function handleSave(): void {
    void validateThen((payload) => saveMutation.mutate(payload))()
  }

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label>{t('broadcastPage.form.audience')}</Label>
        <Select value={audience} onValueChange={setAudience}>
          <SelectTrigger aria-label={t('broadcastPage.form.audience')}><SelectValue /></SelectTrigger>
          <SelectContent>
            {AUDIENCES.map((a) => <SelectItem key={a.value} value={a.value}>{t(a.labelKey)}</SelectItem>)}
          </SelectContent>
        </Select>
        <FieldError message={formErrors.audience} />
      </div>

      <div className="space-y-3 rounded-lg border border-border/60 p-3">
        <div>
          <Label>{t('broadcastPage.audienceFilters.title')}</Label>
          <p className="text-xs text-muted-foreground">{t('broadcastPage.audienceFilters.hint')}</p>
        </div>
        <FilterChipGroup
          label={t('broadcastPage.audienceFilters.subscription')}
          options={SUB_BUCKETS.map((v) => ({ value: v, label: t(`broadcastPage.audienceFilters.sub.${v}`) }))}
          selected={subBuckets}
          onToggle={(v) => setSubBuckets((prev) => toggleIn(prev, v))}
        />
        {plans.length > 0 ? (
          <FilterChipGroup
            label={t('broadcastPage.audienceFilters.plan')}
            options={plans.map((plan) => ({ value: plan.id, label: plan.name }))}
            selected={planFilters}
            onToggle={(v) => setPlanFilters((prev) => toggleIn(prev, v))}
          />
        ) : (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">
              {t('broadcastPage.audienceFilters.plan')}
            </p>
            <p className="text-xs text-muted-foreground">
              {plansLoading
                ? t('broadcastPage.audienceFilters.planLoading')
                : t('broadcastPage.audienceFilters.planEmpty')}
            </p>
          </div>
        )}
        <FilterChipGroup
          label={t('broadcastPage.audienceFilters.platform')}
          options={PLATFORM_OPTS.map((v) => ({ value: v, label: t(`broadcastPage.audienceFilters.platforms.${v}`) }))}
          selected={platformFilters}
          onToggle={(v) => setPlatformFilters((prev) => toggleIn(prev, v))}
        />
        <FilterChipGroup
          label={t('broadcastPage.audienceFilters.contact')}
          options={CONTACT_OPTS.map((v) => ({ value: v, label: t(`broadcastPage.audienceFilters.contacts.${v}`) }))}
          selected={contactFilters}
          onToggle={(v) => setContactFilters((prev) => toggleIn(prev, v))}
        />
        <div className="space-y-1.5">
          <Label htmlFor="broadcast-inactive-days" className="text-xs font-medium text-muted-foreground">
            {t('broadcastPage.audienceFilters.inactiveDays')}
          </Label>
          <Input
            id="broadcast-inactive-days"
            type="number"
            min={1}
            value={inactiveDays}
            onChange={(e) => setInactiveDays(e.target.value)}
            placeholder={t('broadcastPage.audienceFilters.inactiveDaysPlaceholder')}
            className="max-w-[160px]"
          />
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-border/60 pt-3">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => previewMutation.mutate()}
            disabled={previewMutation.isPending || createMutation.isPending || testMutation.isPending}
          >
            {previewMutation.isPending ? (
              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
            ) : (
              <Users className="h-3 w-3 mr-1" />
            )}
            {t('broadcastPage.audienceFilters.preview.check')}
          </Button>
          {previewCount !== null && previewedSignature === audienceSignature && (
            <span className="text-xs font-medium tabular-nums">
              {t('broadcastPage.audienceFilters.preview.result', { total: previewCount })}
            </span>
          )}
          {previewCount !== null && previewedSignature !== audienceSignature && (
            <span className="text-xs text-muted-foreground">
              {t('broadcastPage.audienceFilters.preview.stale')}
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {t('broadcastPage.audienceFilters.preview.hint')}
        </p>
      </div>

      <div className="space-y-3 rounded-lg border border-border/60 p-3">
        <div>
          <Label>{t('broadcastPage.channels.title')}</Label>
          <p className="text-xs text-muted-foreground">{t('broadcastPage.channels.hint')}</p>
        </div>
        <div className="flex items-center justify-between gap-3">
          <div>
            <Label htmlFor="broadcast-email-enabled" className="text-sm font-normal">
              {t('broadcastPage.channels.email')}
            </Label>
            <p className="text-xs text-muted-foreground">{t('broadcastPage.channels.emailHint')}</p>
          </div>
          <Switch
            id="broadcast-email-enabled"
            checked={emailEnabled}
            onCheckedChange={setEmailEnabled}
            aria-label={t('broadcastPage.channels.email')}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="broadcast-channel-chat-id" className="text-xs font-medium text-muted-foreground">
            {t('broadcastPage.channels.telegramChannel')}
          </Label>
          <Input
            id="broadcast-channel-chat-id"
            value={telegramChannelChatId}
            onChange={(e) => setTelegramChannelChatId(e.target.value)}
            placeholder={t('broadcastPage.channels.telegramChannelPlaceholder')}
            className="font-mono text-xs"
            aria-invalid={!!formErrors.telegramChannelChatId}
          />
          <p className="text-xs text-muted-foreground">{t('broadcastPage.channels.telegramChannelHint')}</p>
          <FieldError message={formErrors.telegramChannelChatId} />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="broadcast-title">{t('broadcastPage.form.titleLabel')}</Label>
        {/* The picker moves into `adornment` so it stays inside the field's own
            box: the overlay is absolutely positioned against that box, and a
            trigger left outside it would drift the moment the layer appears. */}
        <EmojiFieldOverlay
          value={title}
          overlayClassName="pr-10"
          // `RenderedCopyPreview` right below already carries the rendered line
          // while this field is focused, so a second strip would say it twice.
          liveStrip={false}
          adornment={
            <div className="absolute right-1 top-1/2 -translate-y-1/2">
              <EmojiPicker onSelect={insertTitleAtCaret} ariaLabel={t('broadcastPage.emoji.trigger')} />
            </div>
          }
        >
          <Input
            id="broadcast-title"
            ref={titleRef}
            placeholder={t('broadcastPage.form.titlePlaceholder')}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={128}
            className="pr-10"
            aria-invalid={!!formErrors.title}
          />
        </EmojiFieldOverlay>
        <p className="text-xs text-muted-foreground">{t('broadcastPage.form.titleHint')}</p>
        {title.trim().length > 0 && (
          <div className="space-y-1">
            <p className="text-[11px] font-medium text-muted-foreground">{t('broadcastPage.form.preview')}</p>
            <RenderedCopyPreview value={title} />
          </div>
        )}
        <FieldError message={formErrors.title} />
      </div>

      <div className="space-y-2">
        <Label htmlFor="broadcast-message-text">{t('broadcastPage.form.text')}</Label>
        <EmojiFieldOverlay
          value={text}
          multiline
          liveStrip={false}
          overlayClassName="pr-10"
          adornment={
            <div className="absolute right-1.5 top-1.5">
              <EmojiPicker onSelect={insertAtCaret} ariaLabel={t('broadcastPage.emoji.trigger')} />
            </div>
          }
        >
          <Textarea
            id="broadcast-message-text"
            ref={textRef}
            placeholder={t('broadcastPage.form.textPlaceholder')}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={5}
            className="resize-none pr-10"
            aria-invalid={!!formErrors.text}
          />
        </EmojiFieldOverlay>
        <p className="text-xs text-muted-foreground">
          {t('broadcastPage.form.charCount', { count: text.length })}
        </p>
        {text.trim().length > 0 && (
          <div className="space-y-1">
            <p className="text-[11px] font-medium text-muted-foreground">{t('broadcastPage.form.preview')}</p>
            <RenderedCopyPreview value={text} />
          </div>
        )}
        <FieldError message={formErrors.text} />
      </div>

      <div className="space-y-2">
        <Label>{t('broadcastPage.form.mediaLabel')}</Label>
        <div className="flex gap-2">
          {(['none', 'photo', 'video'] as const).map((mt) => (
            <button
              type="button"
              key={mt}
              onClick={() => { setMediaType(mt); if (mt === 'none') clearUpload() }}
              className={`px-3 py-1.5 rounded-md text-xs font-medium border transition-colors ${
                mediaType === mt
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'border-border hover:border-primary/50'
              }`}
            >
              {mt === 'none'
                ? t('broadcastPage.form.media.none')
                : mt === 'photo'
                  ? `📷 ${t('broadcastPage.form.media.photo')}`
                  : `🎥 ${t('broadcastPage.form.media.video')}`}
            </button>
          ))}
        </div>
        {mediaType !== 'none' ? (
          <div className="space-y-2 rounded-md border bg-muted/30 p-3">
            <div className="flex flex-wrap gap-1.5">
              <Button
                type="button"
                size="sm"
                variant={mediaSourceMode === 'upload' ? 'default' : 'outline'}
                className="h-7 text-xs"
                onClick={() => setMediaSourceMode('upload')}
              >
                <Upload className="h-3 w-3 mr-1" />
                {t('broadcastPage.form.mediaSource.upload')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant={mediaSourceMode === 'url' ? 'default' : 'outline'}
                className="h-7 text-xs"
                onClick={() => setMediaSourceMode('url')}
              >
                {t('broadcastPage.form.mediaSource.url')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant={mediaSourceMode === 'fileId' ? 'default' : 'outline'}
                className="h-7 text-xs"
                onClick={() => setMediaSourceMode('fileId')}
              >
                {t('broadcastPage.form.mediaSource.fileId')}
              </Button>
            </div>

            {mediaSourceMode === 'upload' ? (
              uploaded ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-3 rounded-md border bg-background p-3">
                    {uploaded.mediaType === 'photo' ? (
                      <FileImage className="h-8 w-8 shrink-0 text-emerald-500" />
                    ) : (
                      <FileVideo className="h-8 w-8 shrink-0 text-blue-500" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{uploaded.fileName}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatBytes(uploaded.sizeBytes)} · file_id: <span className="font-mono">{truncate(uploaded.fileId, 16)}</span>
                      </p>
                    </div>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-destructive shrink-0"
                      onClick={clearUpload}
                      aria-label={t('broadcastPage.upload.clear')}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <MediaPreview
                    file={previewFile}
                    mediaType={uploaded.mediaType}
                    label={t('broadcastPage.form.mediaPreview')}
                  />
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    onDrop={handleDrop}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploadMutation.isPending}
                    aria-label={t('broadcastPage.upload.chooseFile')}
                    className={`flex w-full cursor-pointer flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed p-6 text-center transition-colors ${
                      isDragging
                        ? 'border-primary bg-primary/5'
                        : 'border-border hover:border-primary/50 hover:bg-muted/40'
                    } ${uploadMutation.isPending ? 'opacity-50' : ''}`}
                  >
                    {uploadMutation.isPending ? (
                      <>
                        <Loader2 className="h-8 w-8 animate-spin text-primary" />
                        <p className="text-sm text-muted-foreground">
                          {t('broadcastPage.upload.uploading')}
                        </p>
                      </>
                    ) : (
                      <>
                        <Upload className="h-8 w-8 text-muted-foreground" />
                        <div>
                          <p className="text-sm font-medium">
                            {t('broadcastPage.upload.dropHere')}
                          </p>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {t('broadcastPage.upload.orClick')} ·{' '}
                            {mediaType === 'photo'
                              ? t('broadcastPage.upload.photoLimits')
                              : t('broadcastPage.upload.videoLimits')}
                          </p>
                        </div>
                      </>
                    )}
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept={mediaType === 'photo' ? 'image/*' : 'video/*'}
                    className="hidden"
                    aria-label={t('broadcastPage.upload.chooseFile')}
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      if (file) handleFile(file)
                    }}
                  />
                </>
              )
            ) : (
              <>
                <Input
                  placeholder={
                    mediaSourceMode === 'url'
                      ? t('broadcastPage.form.urlPlaceholder', { type: t(`broadcastPage.form.media.${mediaType}`) })
                      : t('broadcastPage.form.fileIdPlaceholder', { type: t(`broadcastPage.form.media.${mediaType}`) })
                  }
                  value={mediaValue}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setMediaValue(e.target.value)}
                  className={mediaSourceMode === 'fileId' ? 'font-mono text-xs' : 'text-xs'}
                  aria-invalid={!!formErrors.mediaValue}
                />
                <p className="text-xs text-muted-foreground">
                  {mediaSourceMode === 'url'
                    ? t('broadcastPage.form.urlHint')
                    : t('broadcastPage.form.fileIdHint', { type: t(`broadcastPage.form.media.${mediaType}`) })}
                </p>
                {mediaSourceMode === 'url' && looksLikeHttpUrl(mediaValue) && (
                  <MediaPreview
                    url={mediaValue}
                    mediaType={mediaType}
                    label={t('broadcastPage.form.mediaPreview')}
                  />
                )}
              </>
            )}
            <FieldError message={formErrors.mediaValue} />
          </div>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="broadcast-promo-code">{t('broadcastPage.form.promoCodeLabel')}</Label>
        <Input
          id="broadcast-promo-code"
          placeholder={t('broadcastPage.form.promoCodePlaceholder')}
          value={promoCode}
          onChange={(e) => setPromoCode(e.target.value.toUpperCase())}
          maxLength={64}
          className="font-mono text-xs uppercase"
          aria-invalid={!!formErrors.promoCode}
        />
        <p className="text-xs text-muted-foreground">{t('broadcastPage.form.promoCodeHint')}</p>
        {/*
          The hint above says the button is added to every message, and for a
          PHOTO or VIDEO broadcast that is not true: media is delivered straight
          through the Bot API, which cannot render this button — only the bot
          can, and only on the relay path. The recipient gets an image whose
          caption names an offer with no way to act on it, while the operator's
          own channel copy DOES carry a button, so nothing on their screen
          contradicts the promise.
        */}
        {promoCode.trim().length > 0 && mediaType !== 'none' && (
          <p className="text-xs text-amber-600 dark:text-amber-500">
            {t('broadcastPage.form.promoCodeMediaWarning')}
          </p>
        )}
        {promoCode.trim().length > 0 && (
          <Badge variant="secondary" className="font-normal">
            {t('broadcastPage.form.promoCodePreview', {
              code: promoCode.trim().toUpperCase(),
            })}
          </Badge>
        )}
        <FieldError message={formErrors.promoCode} />
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>{t('broadcastPage.schedule.label')}</Label>
          <Button
            type="button"
            size="sm"
            variant={scheduleEnabled ? 'default' : 'outline'}
            className="h-7 text-xs"
            onClick={() => setScheduleEnabled((v) => !v)}
          >
            <Clock className="h-3 w-3 mr-1" />
            {scheduleEnabled ? t('broadcastPage.schedule.on') : t('broadcastPage.schedule.off')}
          </Button>
        </div>
        {scheduleEnabled && (
          <div className="space-y-2 rounded-md border bg-muted/30 p-3">
            <div className="flex gap-2">
              <div className="flex-1">
                <DatePicker
                  value={scheduledDate}
                  onChange={setScheduledDate}
                  placeholder={t('broadcastPage.schedule.datePlaceholder')}
                />
              </div>
              <Input
                type="time"
                value={scheduledTime}
                onChange={(e) => setScheduledTime(e.target.value)}
                className="w-28"
                aria-label={t('broadcastPage.schedule.timeLabel')}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {scheduledDate && computeDelayMinutes(combineDateTime(scheduledDate, scheduledTime)) !== undefined
                ? t('broadcastPage.schedule.willSendIn', {
                    minutes: computeDelayMinutes(combineDateTime(scheduledDate, scheduledTime)),
                  })
                : t('broadcastPage.schedule.hint')}
            </p>
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-3 justify-end">
        <Button type="button" variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
        {/* SAVE, without sending. Editing a draft had no such button — the
            footer was Cancel / Test / Send — so closing the dialog threw the
            corrections away and the only way to keep them was to send. */}
        {draftId !== null && (
          <Button
            type="button"
            variant="secondary"
            onClick={handleSave}
            disabled={saveMutation.isPending || createMutation.isPending || uploadMutation.isPending}
          >
            {saveMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
            {t('broadcastPage.form.saveDraft')}
          </Button>
        )}
        {/* Test send is offered only while composing. On a saved draft it
            DELETES the row it previewed (the endpoint cleans up after itself),
            which for an existing broadcast means the operator's work vanishes
            from under the open dialog. */}
        {draftId === null && (
          <Button
            type="button"
            variant="secondary"
            onClick={handleTest}
            disabled={createMutation.isPending || testMutation.isPending || uploadMutation.isPending}
          >
            {testMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <FlaskConical className="h-4 w-4 mr-2" />}
            {t('broadcastPage.form.testSend')}
          </Button>
        )}
        <Button
          type="submit"
          disabled={createMutation.isPending || testMutation.isPending || uploadMutation.isPending}
        >
          {createMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : scheduleEnabled ? <Clock className="h-4 w-4 mr-2" /> : <Send className="h-4 w-4 mr-2" />}
          {scheduleEnabled ? t('broadcastPage.form.scheduleSend') : t('broadcastPage.form.sendNow')}
        </Button>
      </div>
    </form>
  )
}

function FieldError({ message }: { readonly message?: string }) {
  if (!message) return null
  return <p className="text-xs font-medium text-destructive" role="alert">{message}</p>
}

/**
 * Combine a calendar date (local midnight) with an `HH:mm` time string into a
 * single local-time `Date`. Returns `null` when the date is unset or the time
 * is malformed.
 */
function combineDateTime(date: Date | undefined, time: string): Date | null {
  if (!date) return null
  const [hh, mm] = time.split(':')
  const hours = Number.parseInt(hh ?? '', 10)
  const minutes = Number.parseInt(mm ?? '', 10)
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return null
  const combined = new Date(date)
  combined.setHours(hours, minutes, 0, 0)
  return combined
}

/**
 * Delay in whole minutes from now to the target instant. Returns `undefined`
 * when the target is null or not at least a minute in the future — the caller
 * then sends immediately instead of scheduling.
 */
function computeDelayMinutes(target: Date | null): number | undefined {
  if (!target) return undefined
  const diffMinutes = Math.ceil((target.getTime() - Date.now()) / 60_000)
  return diffMinutes >= 1 ? diffMinutes : undefined
}

// ── Edit form ───────────────────────────────────────────────────────────────

interface BroadcastDetail {
  readonly id: string
  /** Needed only to warn that this edit removes the promo button. */
  readonly promoCode: string | null
  readonly payload: {
    readonly text: string | null
    readonly parseMode: 'HTML' | 'MarkdownV2' | null
  }
}

function EditBroadcastForm({ broadcastId, onClose }: { broadcastId: string; onClose: () => void }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const textRef = useRef<HTMLTextAreaElement>(null)
  const [text, setText] = useState('')
  const [loaded, setLoaded] = useState(false)

  const { data, isLoading } = useQuery<BroadcastDetail>({
    queryKey: adminQueryKeys.broadcast.detail(broadcastId),
    queryFn: async ({ signal }) =>
      (await api.get<BroadcastDetail>(`/admin/broadcast/${encodeURIComponent(broadcastId)}`, { signal })).data,
  })

  if (data && !loaded) {
    setText(data.payload.text ?? '')
    setLoaded(true)
  }

  function insertAtCaret(emoji: string): void {
    const el = textRef.current
    if (!el) {
      setText((prev) => prev + emoji)
      return
    }
    const start = el.selectionStart ?? text.length
    const end = el.selectionEnd ?? text.length
    setText(text.slice(0, start) + emoji + text.slice(end))
    requestAnimationFrame(() => {
      el.focus()
      const caret = start + emoji.length
      el.setSelectionRange(caret, caret)
    })
  }

  const editMutation = useMutation({
    mutationFn: () =>
      api.post<{ channel?: 'edited' | 'no-post' | 'unaddressable' | 'failed' }>(
        `/admin/broadcast/${encodeURIComponent(broadcastId)}/edit`,
        { text, parseMode: data?.payload.parseMode ?? null },
      ),
    onSuccess: (response) => {
      queryClient.invalidateQueries({ queryKey: adminQueryKeys.broadcast.all })
      // The channel copy is the public one. A correction that reached every
      // private message and not that one leaves the ORIGINAL text up where
      // anyone can read it, so it cannot report as a plain success — including
      // when the reason is that its message id was never recorded.
      const channel = response?.data?.channel
      if (channel === 'failed' || channel === 'unaddressable') {
        toast.warning(t('broadcastPage.edit.channelFailed'))
      } else {
        toast.success(t('broadcastPage.edit.saved'))
      }
      onClose()
    },
    onError: (err) => toast.error(getErrorMessage(err, t('broadcastPage.edit.saveFailed'))),
  })

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="broadcast-edit-text">{t('broadcastPage.form.text')}</Label>
        {isLoading ? (
          <Skeleton className="h-28 w-full" />
        ) : (
          <EmojiFieldOverlay
            value={text}
            multiline
            liveStrip={false}
            overlayClassName="pr-10"
            adornment={
              <div className="absolute right-1.5 top-1.5">
                <EmojiPicker onSelect={insertAtCaret} ariaLabel={t('broadcastPage.emoji.trigger')} />
              </div>
            }
          >
            <Textarea
              id="broadcast-edit-text"
              ref={textRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={5}
              className="resize-none pr-10"
              placeholder={t('broadcastPage.form.textPlaceholder')}
            />
          </EmojiFieldOverlay>
        )}
        <p className="text-xs text-muted-foreground">{t('broadcastPage.edit.hint')}</p>
        {/*
          A LOSS THE PANEL CANNOT PREVENT, SO IT SAYS SO.

          Telegram reads an edit with no `reply_markup` as "remove the
          keyboard", and the panel cannot supply one: the promo button is
          resolved by the bot against a Mini App url that lives only in the
          bot's config. Sending the panel's own version of that button instead
          is what a previous attempt did — Telegram refused every call with a
          400, so the correction reached nobody at all.

          Between losing the button and losing the correction, the operator
          should get to choose, which means knowing before they press save.
        */}
        {(data?.promoCode ?? null) !== null && (
          <p className="text-xs text-amber-600 dark:text-amber-500">
            {t('broadcastPage.edit.promoButtonLost', { code: data?.promoCode ?? '' })}
          </p>
        )}
        {text.trim().length > 0 && (
          <div className="space-y-1">
            <p className="text-[11px] font-medium text-muted-foreground">{t('broadcastPage.form.preview')}</p>
            <RenderedCopyPreview value={text} />
          </div>
        )}
      </div>
      <div className="flex gap-3 justify-end">
        <Button type="button" variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
        <Button
          type="button"
          disabled={editMutation.isPending || isLoading || text.trim().length === 0}
          onClick={() => editMutation.mutate()}
        >
          {editMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Pencil className="h-4 w-4 mr-2" />}
          {t('broadcastPage.edit.save')}
        </Button>
      </div>
    </div>
  )
}

function flattenHookFormErrors(errors: FieldErrors<BroadcastFormDraft>): Record<string, string> {
  const flattenedErrors: Record<string, string> = {}
  collectHookFormErrors(errors, [], flattenedErrors)
  return flattenedErrors
}

function collectHookFormErrors(value: unknown, path: string[], output: Record<string, string>): void {
  if (value === null || typeof value !== 'object') return

  const maybeError = value as { readonly message?: unknown }
  if (typeof maybeError.message === 'string') {
    const key = path.length > 0 ? path.join('.') : 'form'
    output[key] ??= maybeError.message
  }

  for (const [key, child] of Object.entries(value)) {
    if (key === 'message' || key === 'type' || key === 'types' || key === 'ref') continue
    collectHookFormErrors(child, [...path, key], output)
  }
}
