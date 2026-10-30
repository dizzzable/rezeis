import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  AlertTriangle,
  Check,
  Copy,
  Dices,
  Megaphone,
  Pencil,
  Plus,
  Repeat,
  ShieldAlert,
  Ticket,
  Trash2,
  Trophy,
  Users,
  X,
} from 'lucide-react'

import { getErrorMessage } from '@/lib/http-errors'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { usePlans } from '@/features/plans/plans-api'

import {
  cancelContest,
  countContestAudience,
  createContest,
  deleteContest,
  drawContest,
  issueContestPrize,
  listContestEntrants,
  listContestStandings,
  listContestWinners,
  listContests,
  publishContest,
  refuseContestPrize,
  updateContest,
  type Contest,
  type ContestAudienceFilter,
  type ContestKind,
  type ContestMetric,
  type ContestPayload,
  type ContestPrize,
  type ContestPrizeDelivery,
  type ContestWinner,
} from './contests-api'
import { listKeyPools } from './wheel-keys-api'
import { sectorTitle, type WheelSectorKind } from './wheel-config-api'
import { PromoPrizeFields } from './promo-prize-fields'
import { emptyPromoDraft, promoDraftOf, promoPayload, type PromoDraft } from './promo-prize'
import { activeLocale, cn } from '@/lib/utils'

/** Prize kinds a contest may hand out — everything on the wheel but a loss. */
const PRIZE_KINDS: readonly WheelSectorKind[] = [
  'POINTS',
  'SPINS',
  'DAYS',
  'TRAFFIC',
  'DISCOUNT',
  'PROMOCODE',
  'KEY',
  'MANUAL',
]

const NEEDS_AMOUNT: ReadonlySet<WheelSectorKind> = new Set<WheelSectorKind>([
  'POINTS',
  'SPINS',
  'DAYS',
  'TRAFFIC',
  'DISCOUNT',
  'PROMOCODE',
])

/** The broadcast filter's buckets — the same shape the server reads. */
const SUB_BUCKETS = ['ACTIVE', 'EXPIRED', 'TRIAL', 'LIMITED', 'NONE'] as const
const PLATFORM_OPTS = ['telegram', 'miniapp', 'web'] as const
const CONTACT_OPTS = ['hasTelegram', 'hasEmail', 'hasWebPush'] as const

/** Entrants loaded per page of the participants list. */
const ENTRANTS_PAGE = 50

const METRICS: readonly ContestMetric[] = ['REFERRALS_PAID', 'PAYMENTS_SUM', 'TRAFFIC', 'POINTS_EARNED']
const DELIVERIES: readonly ContestPrizeDelivery[] = ['AUTO', 'REVIEW', 'SUPPORT']
const GB = 1024 ** 3

/** What «Новый конкурс» can start from. */
const TEMPLATES = ['draw', 'referrals', 'payments', 'traffic', 'points'] as const
type TemplateKey = (typeof TEMPLATES)[number]
const TEMPLATE_METRIC: Record<Exclude<TemplateKey, 'draw'>, ContestMetric> = {
  referrals: 'REFERRALS_PAID',
  payments: 'PAYMENTS_SUM',
  traffic: 'TRAFFIC',
  points: 'POINTS_EARNED',
}

/**
 * The threshold as the operator types it — friends, roubles, gigabytes,
 * points — and as the server stores it: friends, kopecks, bytes, points.
 */
const SCORE_SCALE: Record<ContestMetric, number> = {
  REFERRALS_PAID: 1,
  PAYMENTS_SUM: 100,
  TRAFFIC: GB,
  POINTS_EARNED: 1,
}

interface PrizeDraft {
  kind: WheelSectorKind
  titleRu: string
  titleEn: string
  amount: string
  keyPoolId: string
  manualInstructions: string
  /** What a PROMOCODE prize's code actually does. */
  promo: PromoDraft
  /** How many places in a row get this prize: «4–10 место» is 7. */
  places: string
}

interface Draft {
  titleRu: string
  titleEn: string
  descriptionRu: string
  descriptionEn: string
  startAt: string
  endAt: string
  maxEntries: string
  announce: boolean
  /** One reminder a day before the end. */
  remind: boolean
  subscription: string[]
  planIds: string[]
  platforms: string[]
  contact: string[]
  inactiveDays: string
  channelLink: string
  channelId: string
  ticketsPerPurchase: string
  ticketsPerReferral: string
  maxTicketsPerUser: string
  kind: ContestKind
  metric: ContestMetric
  /** In the unit the operator types: friends, roubles, gigabytes, points. */
  minScore: string
  leaderboardSize: string
  prizeDelivery: ContestPrizeDelivery
  repeatMonthly: boolean
  prizes: PrizeDraft[]
}

function emptyPrize(): PrizeDraft {
  return {
    kind: 'POINTS',
    titleRu: '',
    titleEn: '',
    amount: '100',
    keyPoolId: '',
    manualInstructions: '',
    promo: emptyPromoDraft(),
    places: '1',
  }
}

/** `datetime-local` wants local wall-clock time without a zone. */
function toLocalInput(iso: string): string {
  const date = new Date(iso)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function emptyDraft(): Draft {
  const start = new Date()
  const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000)
  return {
    titleRu: '',
    titleEn: '',
    descriptionRu: '',
    descriptionEn: '',
    startAt: toLocalInput(start.toISOString()),
    endAt: toLocalInput(end.toISOString()),
    maxEntries: '',
    // A new contest nobody hears about is the complaint this page answers.
    announce: true,
    remind: true,
    subscription: [],
    planIds: [],
    platforms: [],
    contact: [],
    inactiveDays: '',
    channelLink: '',
    channelId: '',
    ticketsPerPurchase: '0',
    ticketsPerReferral: '0',
    maxTicketsPerUser: '',
    kind: 'DRAW',
    metric: 'REFERRALS_PAID',
    minScore: '',
    leaderboardSize: '10',
    prizeDelivery: 'AUTO',
    repeatMonthly: false,
    prizes: [emptyPrize()],
  }
}

/**
 * A new contest from a template: the kind, what it ranks by, and a set of
 * places that fits — a month long and repeating for a leaderboard, the usual
 * week for a draw. Everything stays editable; the template only fills in.
 */
function applyTemplate(draft: Draft, key: TemplateKey, title: string): Draft {
  if (key === 'draw') {
    return { ...draft, kind: 'DRAW', repeatMonthly: false, titleRu: draft.titleRu || title }
  }
  const start = new Date()
  const end = new Date(start.getFullYear(), start.getMonth() + 1, 1, 0, 0)
  const prize = (amount: string, places: string): PrizeDraft => ({ ...emptyPrize(), amount, places })
  return {
    ...draft,
    kind: 'LEADERBOARD',
    metric: TEMPLATE_METRIC[key],
    titleRu: draft.titleRu || title,
    startAt: toLocalInput(start.toISOString()),
    endAt: toLocalInput(end.toISOString()),
    leaderboardSize: '10',
    repeatMonthly: true,
    prizes: [prize('1000', '1'), prize('500', '1'), prize('300', '1'), prize('100', '7')],
  }
}

/** A threshold from the server's unit into the one typed. */
function scoreToInput(metric: ContestMetric | null, value: number | null): string {
  if (value === null || metric === null) return ''
  const shown = value / SCORE_SCALE[metric]
  return String(Math.round(shown * 100) / 100)
}

function scoreFromInput(metric: ContestMetric, value: string): number | null {
  const typed = Number(value.replace(',', '.'))
  if (value.trim() === '' || !Number.isFinite(typed) || typed <= 0) return null
  return Math.round(typed * SCORE_SCALE[metric])
}

function toDraft(contest: Contest): Draft {
  const filter = contest.audienceFilter ?? {}
  const chatId = contest.channel?.chatId ?? ''
  return {
    titleRu: contest.title?.ru ?? '',
    titleEn: contest.title?.en ?? '',
    descriptionRu: contest.description?.ru ?? '',
    descriptionEn: contest.description?.en ?? '',
    startAt: toLocalInput(contest.startAt),
    endAt: toLocalInput(contest.endAt),
    maxEntries: contest.maxEntries === null ? '' : String(contest.maxEntries),
    announce: contest.announce,
    remind: contest.remind ?? false,
    subscription: [...(filter.subscription ?? [])],
    planIds: [...(filter.planIds ?? [])],
    platforms: [...(filter.platforms ?? [])],
    contact: [...(filter.contact ?? [])],
    inactiveDays: filter.inactiveDays === undefined ? '' : String(filter.inactiveDays),
    channelLink: contest.channel?.joinUrl ?? '',
    // A public channel is checked by its @username, which the link already
    // carries; only a numeric id is something the operator typed.
    channelId: chatId.startsWith('-100') ? chatId : '',
    ticketsPerPurchase: String(contest.ticketsPerPurchase ?? 0),
    ticketsPerReferral: String(contest.ticketsPerReferral ?? 0),
    maxTicketsPerUser: contest.maxTicketsPerUser == null ? '' : String(contest.maxTicketsPerUser),
    kind: contest.kind ?? 'DRAW',
    metric: contest.metric ?? 'REFERRALS_PAID',
    minScore: scoreToInput(contest.metric ?? null, contest.minScore ?? null),
    leaderboardSize: String(contest.leaderboardSize ?? 10),
    prizeDelivery: contest.prizeDelivery ?? 'AUTO',
    repeatMonthly: contest.repeatMonthly ?? false,
    prizes: [...contest.prizes].sort((a, b) => a.place - b.place).map((prize) => ({
      kind: prize.kind,
      titleRu: prize.title?.ru ?? '',
      titleEn: prize.title?.en ?? '',
      amount: String(prize.amount),
      keyPoolId: prize.keyPoolId ?? '',
      manualInstructions: prize.manualInstructions ?? '',
      promo: promoDraftOf(prize),
      places: String(Math.max(1, (prize.placeTo ?? prize.place) - prize.place + 1)),
    })),
  }
}

/** Each row's first and last place: the rows follow one another down the board. */
function placeRanges(prizes: readonly PrizeDraft[]): Array<{ from: number; to: number }> {
  let next = 1
  return prizes.map((prize) => {
    const count = Math.max(1, readCount(prize.places, 1) ?? 1)
    const range = { from: next, to: next + count - 1 }
    next += count
    return range
  })
}

/** `datetime-local` gives back '' when the field is cleared. */
function isValidLocalDate(value: string): boolean {
  return value.trim() !== '' && !Number.isNaN(new Date(value).getTime())
}

/** A whole number from a field, or `fallback` for an empty or unreadable one. */
function readCount(value: string, fallback: number | null): number | null {
  if (value.trim() === '') return fallback
  const parsed = Math.trunc(Number(value))
  return Number.isFinite(parsed) ? parsed : fallback
}

function toAudience(draft: Draft): ContestAudienceFilter | null {
  const inactiveDays = readCount(draft.inactiveDays, null)
  const filter: ContestAudienceFilter = {
    ...(draft.subscription.length > 0 ? { subscription: draft.subscription } : {}),
    ...(draft.planIds.length > 0 ? { planIds: draft.planIds } : {}),
    ...(draft.platforms.length > 0 ? { platforms: draft.platforms } : {}),
    ...(draft.contact.length > 0 ? { contact: draft.contact } : {}),
    ...(inactiveDays !== null && inactiveDays > 0 ? { inactiveDays } : {}),
  }
  return Object.keys(filter).length === 0 ? null : filter
}

/** The English field when it was filled, the Russian one when it was not. */
function bilingual(ru: string, en: string): { ru: string; en: string } {
  return { ru: ru.trim(), en: en.trim() || ru.trim() }
}

function toPayload(draft: Draft): ContestPayload {
  const maxTickets = readCount(draft.maxTicketsPerUser, null)
  const ranges = placeRanges(draft.prizes)
  const ranked = draft.kind === 'LEADERBOARD'
  return {
    title: bilingual(draft.titleRu, draft.titleEn),
    description: bilingual(draft.descriptionRu, draft.descriptionEn),
    startAt: new Date(draft.startAt).toISOString(),
    endAt: new Date(draft.endAt).toISOString(),
    audienceFilter: toAudience(draft),
    maxEntries: readCount(draft.maxEntries, null),
    announce: draft.announce,
    remind: draft.remind,
    ticketsPerPurchase: Math.max(0, readCount(draft.ticketsPerPurchase, 0) ?? 0),
    ticketsPerReferral: Math.max(0, readCount(draft.ticketsPerReferral, 0) ?? 0),
    maxTicketsPerUser: maxTickets !== null && maxTickets >= 1 ? maxTickets : null,
    channelLink: draft.channelLink.trim() === '' ? null : draft.channelLink.trim(),
    channelId: draft.channelId.trim() === '' ? null : draft.channelId.trim(),
    kind: draft.kind,
    metric: ranked ? draft.metric : null,
    minScore: ranked ? scoreFromInput(draft.metric, draft.minScore) : null,
    leaderboardSize: Math.min(100, Math.max(3, readCount(draft.leaderboardSize, 10) ?? 10)),
    prizeDelivery: draft.prizeDelivery,
    repeatMonthly: draft.repeatMonthly,
    // Places follow the list order: the first row is first prize, and a row
    // for several places takes them one after another.
    prizes: draft.prizes.map<Omit<ContestPrize, 'id'>>((prize, index) => ({
      place: ranges[index]?.from ?? index + 1,
      placeTo: (ranges[index]?.to ?? 0) > (ranges[index]?.from ?? 0) ? (ranges[index]?.to ?? null) : null,
      kind: prize.kind,
      title: bilingual(prize.titleRu, prize.titleEn),
      amount: NEEDS_AMOUNT.has(prize.kind) ? Math.trunc(Number(prize.amount)) || 0 : 0,
      ...promoPayload(prize.kind, prize.promo),
      keyPoolId: prize.kind === 'KEY' && prize.keyPoolId !== '' ? prize.keyPoolId : null,
      manualInstructions:
        prize.kind === 'MANUAL' && prize.manualInstructions.trim() !== ''
          ? prize.manualInstructions.trim()
          : null,
    })),
  }
}

/**
 * A new draft with this contest's terms and prizes, starting now and as long
 * as the original — what «Копировать» opens. Nothing is saved until «Сохранить».
 */
function copyDraft(contest: Contest, now: number): Draft {
  const draft = toDraft(contest)
  const length = Math.max(60 * 60 * 1000, new Date(contest.endAt).getTime() - new Date(contest.startAt).getTime())
  return {
    ...draft,
    startAt: toLocalInput(new Date(now).toISOString()),
    endAt: toLocalInput(new Date(now + length).toISOString()),
  }
}

function toggleIn(list: readonly string[], value: string): string[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value]
}

/**
 * Contests: an event with a draw at the end.
 *
 * The page is built around the status a contest is in, because that is what
 * decides which buttons make sense. A draft can be edited and published; a
 * live one can have its wording fixed and its end moved later, can be
 * cancelled, and drawn once its end has passed; a drawn one shows its
 * winners, with the prizes a human hands over settled right here. Every
 * contest past the draft shows who entered — or, for a leaderboard, the
 * board as it stands.
 */
export default function ContestsPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState<{ id: string | null; draft: Draft } | null>(null)
  const [removing, setRemoving] = useState<Contest | null>(null)
  const [cancelling, setCancelling] = useState<Contest | null>(null)
  const [winnersOf, setWinnersOf] = useState<Contest | null>(null)
  const [entrantsOf, setEntrantsOf] = useState<Contest | null>(null)
  const [standingsOf, setStandingsOf] = useState<Contest | null>(null)

  // Refetched on a timer so "over, waiting for the draw" appears without a
  // reload; `dataUpdatedAt` is then the clock the rows are judged against,
  // which keeps the render pure and the sweep's minute cadence visible.
  const contests = useQuery({
    queryKey: ['admin', 'contests'],
    queryFn: listContests,
    refetchInterval: 60_000,
  })
  const pools = useQuery({ queryKey: ['admin', 'wheel', 'key-pools'], queryFn: listKeyPools })

  const fail = useCallback(
    (error: unknown) => toast.error(getErrorMessage(error, t('common.error'))),
    [t],
  )
  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['admin', 'contests'] }),
    [queryClient],
  )

  const save = useMutation({
    mutationFn: ({ id, draft }: { id: string | null; draft: Draft }) =>
      id === null ? createContest(toPayload(draft)) : updateContest(id, toPayload(draft)),
    onSuccess: () => {
      refresh()
      setEditing(null)
      toast.success(t('contestsPage.toast.saved'))
    },
    onError: fail,
  })
  const remove = useMutation({
    mutationFn: deleteContest,
    onSuccess: () => {
      refresh()
      setRemoving(null)
      toast.success(t('contestsPage.toast.deleted'))
    },
    onError: (error: unknown) => {
      fail(error)
      setRemoving(null)
    },
  })
  const publish = useMutation({
    mutationFn: publishContest,
    onSuccess: () => {
      refresh()
      toast.success(t('contestsPage.toast.published'))
    },
    onError: fail,
  })
  const cancel = useMutation({
    mutationFn: cancelContest,
    onSuccess: () => {
      refresh()
      setCancelling(null)
      toast.success(t('contestsPage.toast.cancelled'))
    },
    onError: (error: unknown) => {
      fail(error)
      setCancelling(null)
    },
  })
  const draw = useMutation({
    mutationFn: drawContest,
    onSuccess: (result) => {
      refresh()
      if (result.drawn) {
        toast.success(
          result.tickets === null
            ? t('contestsPage.toastExtra.finished', { winners: result.winners, entrants: result.entrants })
            : t('contestsPage.toast.drawn', { winners: result.winners, entrants: result.entrants }),
        )
        if (result.repeatedBy) toast.success(t('contestsPage.toastExtra.repeated'))
      } else {
        toast.error(t(`contestsPage.drawRefused.${result.reason}`))
      }
    },
    onError: (error: unknown) => {
      // The reason is now on the row as well; refetch so it shows.
      refresh()
      fail(error)
    },
  })

  const items = contests.data ?? []
  const editingStatus =
    editing === null || editing.id === null ? 'DRAFT' : (items.find((c) => c.id === editing.id)?.status ?? 'DRAFT')

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <Dices className="h-6 w-6" />
            {t('contestsPage.title')}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('contestsPage.subtitle')}</p>
        </div>
        <Button className="gap-1" onClick={() => setEditing({ id: null, draft: emptyDraft() })}>
          <Plus className="h-4 w-4" />
          {t('contestsPage.actions.new')}
        </Button>
      </header>

      <Card>
        <CardContent className="p-0">
          {contests.isLoading ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : items.length === 0 ? (
            <p className="p-8 text-center text-sm text-muted-foreground">{t('contestsPage.empty')}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('contestsPage.columns.contest')}</TableHead>
                  <TableHead>{t('contestsPage.columns.window')}</TableHead>
                  <TableHead className="text-right">{t('contestsPage.columns.entries')}</TableHead>
                  <TableHead>{t('contestsPage.columns.status')}</TableHead>
                  <TableHead className="text-right">{t('contestsPage.columns.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((contest) => {
                  const over = new Date(contest.endAt).getTime() <= contests.dataUpdatedAt
                  return (
                    <TableRow key={contest.id}>
                      <TableCell className="align-top">
                        <div className="font-medium">
                          {sectorTitle(contest, t('contestsPage.unnamed'))}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {t('contestsPage.prizesCount', { count: contest.places ?? contest.prizes.length })}
                        </div>
                        <ContestBadges contest={contest} />
                        {contest.status === 'DRAFT' && contest.problems.length > 0 ? (
                          <ul className="mt-1 space-y-0.5 text-xs text-destructive">
                            {contest.problems.map((problem) => (
                              <li key={problem} className="flex gap-1">
                                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                                {problem}
                              </li>
                            ))}
                          </ul>
                        ) : null}
                        {contest.status === 'ACTIVE' && contest.drawError ? (
                          <div className="mt-1 text-xs text-destructive" data-testid="contest-draw-error">
                            <div className="flex gap-1">
                              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                              {t('contestsPage.row.drawError', { error: contest.drawError })}
                            </div>
                            <div className="text-muted-foreground">{t('contestsPage.row.drawErrorHint')}</div>
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell className="align-top text-xs text-muted-foreground">
                        {new Date(contest.startAt).toLocaleString(activeLocale())}
                        <br />
                        {new Date(contest.endAt).toLocaleString(activeLocale())}
                      </TableCell>
                      <TableCell className="align-top text-right tabular-nums">
                        {contest.kind === 'LEADERBOARD' && contest.status !== 'DRAWN' ? (
                          '—'
                        ) : (
                          <>
                            {contest.entries}
                            {contest.maxEntries !== null ? ` / ${contest.maxEntries}` : ''}
                          </>
                        )}
                      </TableCell>
                      <TableCell className="align-top">
                        <Badge variant={contest.status === 'ACTIVE' ? 'default' : 'secondary'}>
                          {t(`contestsPage.status.${contest.status}`)}
                        </Badge>
                        {contest.status === 'ACTIVE' && over ? (
                          <div className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                            {contest.kind !== 'LEADERBOARD'
                              ? t('contestsPage.awaitingDraw')
                              : contest.metric === 'TRAFFIC' &&
                                  (contest.trafficReadAt === null ||
                                    new Date(contest.trafficReadAt).getTime() < new Date(contest.endAt).getTime())
                                ? t('contestsPage.row.awaitingTraffic')
                                : t('contestsPage.row.awaitingResults')}
                          </div>
                        ) : null}
                        <NoticeState contest={contest} />
                        {contest.status === 'DRAWN' && (contest.pendingPrizes ?? 0) > 0 ? (
                          <div className="mt-1 text-xs text-amber-600 dark:text-amber-400" data-testid="contest-pending-prizes">
                            {t('contestsPage.row.pendingPrizes', { count: contest.pendingPrizes })}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell className="align-top">
                        <div className="flex flex-wrap justify-end gap-1">
                          {contest.status === 'DRAFT' ? (
                            <>
                              <Button
                                size="sm"
                                disabled={contest.problems.length > 0 || publish.isPending}
                                onClick={() => publish.mutate(contest.id)}
                              >
                                {t('contestsPage.actions.publish')}
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label={t('contestsPage.actions.edit')}
                                onClick={() => setEditing({ id: contest.id, draft: toDraft(contest) })}
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label={t('contestsPage.actions.delete')}
                                onClick={() => setRemoving(contest)}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </>
                          ) : null}
                          {contest.status === 'ACTIVE' ? (
                            <>
                              {over ? (
                                <Button size="sm" className="gap-1" disabled={draw.isPending} onClick={() => draw.mutate(contest.id)}>
                                  <Dices className="h-4 w-4" />
                                  {t('contestsPage.actions.draw')}
                                </Button>
                              ) : null}
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label={t('contestsPage.actions.edit')}
                                onClick={() => setEditing({ id: contest.id, draft: toDraft(contest) })}
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button variant="outline" size="sm" disabled={cancel.isPending} onClick={() => setCancelling(contest)}>
                                {t('contestsPage.actions.cancel')}
                              </Button>
                            </>
                          ) : null}
                          {contest.status === 'DRAWN' ? (
                            <Button
                              variant={(contest.pendingPrizes ?? 0) > 0 ? 'default' : 'outline'}
                              size="sm"
                              onClick={() => setWinnersOf(contest)}
                            >
                              {t('contestsPage.actions.winners', { count: contest.winners })}
                            </Button>
                          ) : null}
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={t('contestsPage.actionsExtra.copy')}
                            title={t('contestsPage.actionsExtra.copy')}
                            onClick={() => setEditing({ id: null, draft: copyDraft(contest, contests.dataUpdatedAt) })}
                          >
                            <Copy className="h-4 w-4" />
                          </Button>
                          {contest.status !== 'DRAFT' && contest.kind === 'LEADERBOARD' ? (
                            <Button variant="outline" size="sm" className="gap-1" onClick={() => setStandingsOf(contest)}>
                              <Trophy className="h-4 w-4" />
                              {contest.status === 'DRAWN'
                                ? t('contestsPage.actionsExtra.results')
                                : t('contestsPage.actionsExtra.standings')}
                            </Button>
                          ) : null}
                          {contest.status !== 'DRAFT' && contest.kind !== 'LEADERBOARD' ? (
                            <Button variant="outline" size="sm" className="gap-1" onClick={() => setEntrantsOf(contest)}>
                              <Users className="h-4 w-4" />
                              {t('contestsPage.actionsExtra.entrants')}
                            </Button>
                          ) : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={editing !== null} onOpenChange={(open) => (open ? undefined : setEditing(null))}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editing?.id === null ? t('contestsPage.actions.new') : t('contestsPage.actions.edit')}
            </DialogTitle>
          </DialogHeader>
          {editing !== null ? (
            <ContestForm
              draft={editing.draft}
              isNew={editing.id === null}
              locked={editingStatus !== 'DRAFT'}
              pools={(pools.data ?? []).map((pool) => ({ id: pool.id, name: pool.name, available: pool.available }))}
              onChange={(draft) => setEditing({ id: editing.id, draft })}
            />
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              // A cleared date is `''`, and `new Date('').toISOString()` throws
              // — the operator saw "Invalid time value" instead of a form that
              // simply would not submit yet.
              disabled={
                save.isPending ||
                (editing?.draft.titleRu.trim() ?? '') === '' ||
                !isValidLocalDate(editing?.draft.startAt ?? '') ||
                !isValidLocalDate(editing?.draft.endAt ?? '')
              }
              onClick={() => {
                if (editing !== null) save.mutate(editing)
              }}
            >
              {t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={removing !== null} onOpenChange={(open) => (open ? undefined : setRemoving(null))}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('contestsPage.deleteDialog.title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('contestsPage.deleteDialog.description')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (removing !== null) remove.mutate(removing.id)
              }}
            >
              {t('contestsPage.actions.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Cancelling a live contest throws away everybody's entry; one stray click used to do it. */}
      <AlertDialog open={cancelling !== null} onOpenChange={(open) => (open ? undefined : setCancelling(null))}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('contestsPage.cancelDialog.title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('contestsPage.cancelDialog.description')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={cancel.isPending}
              onClick={() => {
                if (cancelling !== null) cancel.mutate(cancelling.id)
              }}
            >
              {t('contestsPage.cancelDialog.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <WinnersDialog contest={winnersOf} onClose={() => setWinnersOf(null)} />
      <EntrantsDialog contest={entrantsOf} onClose={() => setEntrantsOf(null)} />
      <StandingsDialog contest={standingsOf} onClose={() => setStandingsOf(null)} />
    </div>
  )
}

/** What a contest asks of people beyond the button, and how it ends: a channel, tickets, a leaderboard, held prizes, a repeat. */
function ContestBadges({ contest }: { readonly contest: Contest }) {
  const { t } = useTranslation()
  const tickets = contest.ticketsPerPurchase > 0 || contest.ticketsPerReferral > 0
  const ranked = contest.kind === 'LEADERBOARD'
  const held = contest.prizeDelivery === 'REVIEW' || contest.prizeDelivery === 'SUPPORT'
  if (contest.channel === null && !tickets && !ranked && !held && !contest.repeatMonthly) return null
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {ranked && contest.metric ? (
        <Badge variant="outline" className="gap-1 text-[10px]">
          <Trophy className="h-3 w-3" />
          {t('contestsPage.row.leaderboard', { metric: t(`contestsPage.form.metrics.${contest.metric}`) })}
        </Badge>
      ) : null}
      {held ? (
        <Badge variant="outline" className="text-[10px]">
          {t(`contestsPage.row.delivery.${contest.prizeDelivery}`)}
        </Badge>
      ) : null}
      {contest.repeatMonthly ? (
        <Badge variant="outline" className="gap-1 text-[10px]">
          <Repeat className="h-3 w-3" />
          {t('contestsPage.row.repeat')}
        </Badge>
      ) : null}
      {contest.channel !== null ? (
        <Badge variant="outline" className="text-[10px]">
          {t('contestsPage.row.channel')}
        </Badge>
      ) : null}
      {tickets ? (
        <Badge variant="outline" className="gap-1 text-[10px]">
          <Ticket className="h-3 w-3" />
          {t('contestsPage.row.tickets')}
        </Badge>
      ) : null}
    </div>
  )
}

/** Whether the announcement and the results have gone out yet. */
function NoticeState({ contest }: { readonly contest: Contest }) {
  const { t } = useTranslation()
  const lines: string[] = []
  if (contest.announce && contest.status === 'ACTIVE') {
    lines.push(contest.announcedAt === null ? t('contestsPage.row.announceSending') : t('contestsPage.row.announceSent'))
  }
  if (contest.remindedAt) lines.push(t('contestsPage.row.remindSent'))
  if (contest.status === 'DRAWN') {
    lines.push(contest.resultsNotifiedAt === null ? t('contestsPage.row.resultsSending') : t('contestsPage.row.resultsSent'))
  }
  if (lines.length === 0) return null
  return (
    <div className="mt-1 space-y-0.5 text-xs text-muted-foreground">
      {lines.map((line) => (
        <div key={line} className="flex items-center gap-1">
          <Megaphone className="h-3 w-3 shrink-0" />
          {line}
        </div>
      ))}
    </div>
  )
}

/** A row of toggle chips for one multi-select audience category. */
function ChipGroup({
  label,
  options,
  selected,
  onToggle,
}: {
  readonly label: string
  readonly options: ReadonlyArray<{ value: string; label: string }>
  readonly selected: readonly string[]
  readonly onToggle: (value: string) => void
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="flex flex-wrap gap-1.5">
        {options.map((option) => {
          const active = selected.includes(option.value)
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={active}
              onClick={() => onToggle(option.value)}
              className={cn(
                'rounded-full border px-3 py-1 text-xs transition-colors',
                active ? 'border-primary bg-primary/15 text-primary' : 'border-border text-muted-foreground hover:bg-muted',
              )}
            >
              {option.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** How many people the filter takes in right now — before anybody presses «Опубликовать». */
function AudienceEstimate({ filter }: { readonly filter: ContestAudienceFilter | null }) {
  const { t } = useTranslation()
  const count = useQuery({
    queryKey: ['admin', 'contests', 'audience', JSON.stringify(filter)],
    queryFn: () => countContestAudience(filter),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  })
  return (
    <p className="text-xs font-medium" data-testid="contest-audience-count">
      {count.data === undefined
        ? t('contestsPage.form.audienceCounting')
        : t('contestsPage.form.audienceCount', { value: count.data.toLocaleString(activeLocale()) })}
    </p>
  )
}

/** «Напомнить за сутки до конца» — on a draft, and on a live contest too. */
function RemindToggle({ checked, onChange }: { readonly checked: boolean; readonly onChange: (value: boolean) => void }) {
  const { t } = useTranslation()
  return (
    <div className="flex items-start gap-2 rounded-lg border p-3">
      <Checkbox
        id="contest-remind"
        checked={checked}
        onCheckedChange={(value) => onChange(value === true)}
        className="mt-0.5"
      />
      <div className="space-y-0.5">
        <Label htmlFor="contest-remind" className="text-sm">
          {t('contestsPage.form.remind')}
        </Label>
        <p className="text-xs text-muted-foreground">{t('contestsPage.form.remindHint')}</p>
      </div>
    </div>
  )
}

/** What an operator checking a prize should look at; amber where it is worth a second look. */
function WinnerSignalsLine({ signals }: { readonly signals: NonNullable<ContestWinner['signals']> }) {
  const { t } = useTranslation()
  const friends = signals.friends
  const parts: Array<{ text: string; alarm: boolean }> = [
    { text: t('contestsPage.signals.age', { value: signals.accountAgeDays }), alarm: false },
  ]
  if (signals.reviewFlags > 0) parts.push({ text: t('contestsPage.signals.flags', { value: signals.reviewFlags }), alarm: true })
  if (friends !== null) {
    parts.push({ text: t('contestsPage.signals.friends', { value: friends.counted }), alarm: false })
    if (friends.sharedDevice > 0) {
      parts.push({ text: t('contestsPage.signals.sharedDevice', { value: friends.sharedDevice }), alarm: true })
    }
    if (friends.sharedIp > 0) parts.push({ text: t('contestsPage.signals.sharedIp', { value: friends.sharedIp }), alarm: true })
    if (friends.blocked > 0) parts.push({ text: t('contestsPage.signals.blocked', { value: friends.blocked }), alarm: true })
  }
  const alarm = parts.some((part) => part.alarm)
  return (
    <div
      className={cn('flex flex-wrap items-center gap-x-2 text-xs', alarm ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground')}
      data-testid="contest-winner-signals"
      title={t('contestsPage.signals.hint')}
    >
      {alarm ? <ShieldAlert className="h-3.5 w-3.5 shrink-0" /> : null}
      {parts.map((part) => (
        <span key={part.text}>{part.text}</span>
      ))}
    </div>
  )
}

/** «Повторять каждый месяц» — on a draft, and on a live contest too. */
function RepeatToggle({ checked, onChange }: { readonly checked: boolean; readonly onChange: (value: boolean) => void }) {
  const { t } = useTranslation()
  return (
    <div className="flex items-start gap-2 rounded-lg border p-3">
      <Checkbox
        id="contest-repeat"
        checked={checked}
        onCheckedChange={(value) => onChange(value === true)}
        className="mt-0.5"
      />
      <div className="space-y-0.5">
        <Label htmlFor="contest-repeat" className="text-sm">
          {t('contestsPage.form.repeat')}
        </Label>
        <p className="text-xs text-muted-foreground">{t('contestsPage.form.repeatHint')}</p>
      </div>
    </div>
  )
}

function ContestForm({
  draft,
  isNew,
  locked,
  pools,
  onChange,
}: {
  readonly draft: Draft
  /** A contest not saved yet: offered the templates. */
  readonly isNew: boolean
  /** Live: the wording may change, and the end may move later. */
  readonly locked: boolean
  readonly pools: ReadonlyArray<{ id: string; name: string; available: number }>
  readonly onChange: (draft: Draft) => void
}) {
  const { t } = useTranslation()
  const { data: plans = [] } = usePlans()
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => onChange({ ...draft, [key]: value })
  const setPrize = (index: number, patch: Partial<PrizeDraft>) =>
    set(
      'prizes',
      draft.prizes.map((prize, i) => (i === index ? { ...prize, ...patch } : prize)),
    )
  const ranked = draft.kind === 'LEADERBOARD'
  const ranges = placeRanges(draft.prizes)

  return (
    <div className="space-y-4">
      {isNew ? (
        <div className="space-y-1.5" data-testid="contest-templates">
          <p className="text-xs font-medium text-muted-foreground">{t('contestsPage.form.template')}</p>
          <div className="flex flex-wrap gap-1.5">
            {TEMPLATES.map((key) => {
              const active = key === 'draw' ? draft.kind === 'DRAW' : ranked && draft.metric === TEMPLATE_METRIC[key]
              return (
                <button
                  key={key}
                  type="button"
                  aria-pressed={active}
                  onClick={() =>
                    onChange(
                      applyTemplate(
                        draft,
                        key,
                        key === 'draw' ? '' : t(`contestsPage.form.templateTitles.${key}`),
                      ),
                    )
                  }
                  className={cn(
                    'rounded-full border px-3 py-1 text-xs transition-colors',
                    active ? 'border-primary bg-primary/15 text-primary' : 'border-border text-muted-foreground hover:bg-muted',
                  )}
                >
                  {t(`contestsPage.form.templates.${key}`)}
                </button>
              )
            })}
          </div>
        </div>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="contest-title-ru">{t('contestsPage.form.titleRu')}</Label>
          <Input id="contest-title-ru" value={draft.titleRu} onChange={(e) => set('titleRu', e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="contest-title-en">{t('contestsPage.form.titleEn')}</Label>
          <Input id="contest-title-en" value={draft.titleEn} onChange={(e) => set('titleEn', e.target.value)} />
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="contest-description">{t('contestsPage.form.descriptionRu')}</Label>
          <Textarea id="contest-description" rows={4} value={draft.descriptionRu} onChange={(e) => set('descriptionRu', e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="contest-description-en">{t('contestsPage.form.descriptionEn')}</Label>
          <Textarea id="contest-description-en" rows={4} value={draft.descriptionEn} onChange={(e) => set('descriptionEn', e.target.value)} />
        </div>
      </div>
      <p className="-mt-2 text-xs text-muted-foreground">{t('contestsPage.form.descriptionHint')}</p>

      {locked ? (
        <>
          <p className="text-xs text-muted-foreground">{t('contestsPage.form.lockedLive')}</p>
          <div className="space-y-1.5 sm:max-w-xs">
            <Label htmlFor="contest-end">{t('contestsPage.form.endAtExtend')}</Label>
            <Input id="contest-end" type="datetime-local" value={draft.endAt} onChange={(e) => set('endAt', e.target.value)} />
          </div>
          <RepeatToggle checked={draft.repeatMonthly} onChange={(value) => set('repeatMonthly', value)} />
          <RemindToggle checked={draft.remind} onChange={(value) => set('remind', value)} />
        </>
      ) : (
        <>
          <div className="space-y-1.5">
            <Label>{t('contestsPage.form.kind')}</Label>
            <Select value={draft.kind} onValueChange={(value) => set('kind', value as ContestKind)}>
              <SelectTrigger aria-label={t('contestsPage.form.kind')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(['DRAW', 'LEADERBOARD'] as const).map((kind) => (
                  <SelectItem key={kind} value={kind}>
                    {t(`contestsPage.form.kinds.${kind}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {ranked ? (
            <fieldset className="space-y-3 rounded-lg border p-3" data-testid="contest-leaderboard-fields">
              <legend className="px-1 text-sm font-medium">{t('contestsPage.form.metric')}</legend>
              <Select value={draft.metric} onValueChange={(value) => set('metric', value as ContestMetric)}>
                <SelectTrigger aria-label={t('contestsPage.form.metric')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {METRICS.map((metric) => (
                    <SelectItem key={metric} value={metric}>
                      {t(`contestsPage.form.metrics.${metric}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{t(`contestsPage.form.metricHints.${draft.metric}`)}</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="contest-min-score">
                    {t('contestsPage.form.minScore')}, {t(`contestsPage.form.minScoreUnits.${draft.metric}`)}
                  </Label>
                  <Input
                    id="contest-min-score"
                    inputMode="decimal"
                    placeholder={t('contestsPage.form.minScorePlaceholder')}
                    value={draft.minScore}
                    onChange={(e) => set('minScore', e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="contest-board-size">{t('contestsPage.form.leaderboardSize')}</Label>
                  <Input
                    id="contest-board-size"
                    inputMode="numeric"
                    value={draft.leaderboardSize}
                    onChange={(e) => set('leaderboardSize', e.target.value)}
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">{t('contestsPage.form.leaderboardSizeHint')}</p>
              <p className="text-xs text-muted-foreground">{t('contestsPage.form.leaderboardEntry')}</p>
            </fieldset>
          ) : null}

          <div className={cn('grid gap-3', ranked ? 'sm:grid-cols-2' : 'sm:grid-cols-3')}>
            <div className="space-y-1.5">
              <Label htmlFor="contest-start">{t('contestsPage.form.startAt')}</Label>
              <Input id="contest-start" type="datetime-local" value={draft.startAt} onChange={(e) => set('startAt', e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="contest-end">{t('contestsPage.form.endAt')}</Label>
              <Input id="contest-end" type="datetime-local" value={draft.endAt} onChange={(e) => set('endAt', e.target.value)} />
            </div>
            {ranked ? null : (
              <div className="space-y-1.5">
                <Label htmlFor="contest-max">{t('contestsPage.form.maxEntries')}</Label>
                <Input
                  id="contest-max"
                  inputMode="numeric"
                  placeholder={t('contestsPage.form.noLimit')}
                  value={draft.maxEntries}
                  onChange={(e) => set('maxEntries', e.target.value)}
                />
              </div>
            )}
          </div>

          <fieldset className="space-y-3 rounded-lg border p-3">
            <legend className="px-1 text-sm font-medium">{t('contestsPage.form.audience')}</legend>
            <p className="text-xs text-muted-foreground">{t('contestsPage.form.audienceHint')}</p>
            <ChipGroup
              label={t('contestsPage.form.subscription')}
              options={SUB_BUCKETS.map((value) => ({ value, label: t(`contestsPage.form.sub.${value}`) }))}
              selected={draft.subscription}
              onToggle={(value) => set('subscription', toggleIn(draft.subscription, value))}
            />
            {plans.length > 0 ? (
              <ChipGroup
                label={t('contestsPage.form.plan')}
                options={plans.map((plan) => ({ value: plan.id, label: plan.name }))}
                selected={draft.planIds}
                onToggle={(value) => set('planIds', toggleIn(draft.planIds, value))}
              />
            ) : (
              <p className="text-xs text-muted-foreground">{t('contestsPage.form.planEmpty')}</p>
            )}
            <ChipGroup
              label={t('contestsPage.form.platform')}
              options={PLATFORM_OPTS.map((value) => ({ value, label: t(`contestsPage.form.platforms.${value}`) }))}
              selected={draft.platforms}
              onToggle={(value) => set('platforms', toggleIn(draft.platforms, value))}
            />
            <ChipGroup
              label={t('contestsPage.form.contact')}
              options={CONTACT_OPTS.map((value) => ({ value, label: t(`contestsPage.form.contacts.${value}`) }))}
              selected={draft.contact}
              onToggle={(value) => set('contact', toggleIn(draft.contact, value))}
            />
            <div className="space-y-1.5">
              <Label htmlFor="contest-inactive-days" className="text-xs font-medium text-muted-foreground">
                {t('contestsPage.form.inactiveDays')}
              </Label>
              <Input
                id="contest-inactive-days"
                inputMode="numeric"
                className="max-w-[160px]"
                placeholder={t('contestsPage.form.inactiveDaysPlaceholder')}
                value={draft.inactiveDays}
                onChange={(e) => set('inactiveDays', e.target.value)}
              />
            </div>
            <AudienceEstimate filter={toAudience(draft)} />
          </fieldset>

          {ranked ? null : (
          <>
          <fieldset className="space-y-3 rounded-lg border p-3">
            <legend className="px-1 text-sm font-medium">{t('contestsPage.form.channel')}</legend>
            <p className="text-xs text-muted-foreground">{t('contestsPage.form.channelHint')}</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="contest-channel-link">{t('contestsPage.form.channelLink')}</Label>
                <Input
                  id="contest-channel-link"
                  placeholder={t('contestsPage.form.channelLinkPlaceholder')}
                  value={draft.channelLink}
                  onChange={(e) => set('channelLink', e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="contest-channel-id">{t('contestsPage.form.channelId')}</Label>
                <Input
                  id="contest-channel-id"
                  placeholder={t('contestsPage.form.channelIdPlaceholder')}
                  value={draft.channelId}
                  onChange={(e) => set('channelId', e.target.value)}
                />
              </div>
            </div>
          </fieldset>

          <fieldset className="space-y-3 rounded-lg border p-3">
            <legend className="px-1 text-sm font-medium">{t('contestsPage.form.tickets')}</legend>
            <p className="text-xs text-muted-foreground">{t('contestsPage.form.ticketsHint')}</p>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="contest-tickets-purchase">{t('contestsPage.form.ticketsPerPurchase')}</Label>
                <Input
                  id="contest-tickets-purchase"
                  inputMode="numeric"
                  value={draft.ticketsPerPurchase}
                  onChange={(e) => set('ticketsPerPurchase', e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="contest-tickets-referral">{t('contestsPage.form.ticketsPerReferral')}</Label>
                <Input
                  id="contest-tickets-referral"
                  inputMode="numeric"
                  value={draft.ticketsPerReferral}
                  onChange={(e) => set('ticketsPerReferral', e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="contest-tickets-max">{t('contestsPage.form.maxTicketsPerUser')}</Label>
                <Input
                  id="contest-tickets-max"
                  inputMode="numeric"
                  placeholder={t('contestsPage.form.maxTicketsPlaceholder')}
                  value={draft.maxTicketsPerUser}
                  onChange={(e) => set('maxTicketsPerUser', e.target.value)}
                />
              </div>
            </div>
          </fieldset>
          </>
          )}

          <fieldset className="space-y-2 rounded-lg border p-3">
            <legend className="px-1 text-sm font-medium">{t('contestsPage.form.delivery')}</legend>
            <Select value={draft.prizeDelivery} onValueChange={(value) => set('prizeDelivery', value as ContestPrizeDelivery)}>
              <SelectTrigger aria-label={t('contestsPage.form.delivery')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DELIVERIES.map((delivery) => (
                  <SelectItem key={delivery} value={delivery}>
                    {t(`contestsPage.form.deliveries.${delivery}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{t(`contestsPage.form.deliveryHints.${draft.prizeDelivery}`)}</p>
            <p className="text-xs text-muted-foreground">{t('contestsPage.form.deliveryManual')}</p>
          </fieldset>

          <RepeatToggle checked={draft.repeatMonthly} onChange={(value) => set('repeatMonthly', value)} />

          <div className="flex items-start gap-2 rounded-lg border p-3">
            <Checkbox
              id="contest-announce"
              checked={draft.announce}
              onCheckedChange={(checked) => set('announce', checked === true)}
              className="mt-0.5"
            />
            <div className="space-y-0.5">
              <Label htmlFor="contest-announce" className="text-sm">
                {t('contestsPage.form.announce')}
              </Label>
              <p className="text-xs text-muted-foreground">{t('contestsPage.form.announceHint')}</p>
            </div>
          </div>
          <RemindToggle checked={draft.remind} onChange={(value) => set('remind', value)} />

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>{t('contestsPage.form.prizes')}</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1"
                onClick={() => set('prizes', [...draft.prizes, emptyPrize()])}
              >
                <Plus className="h-4 w-4" />
                {t('contestsPage.form.addPrize')}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t('contestsPage.form.prizesHintRanges')}</p>
            {draft.prizes.map((prize, index) => (
              <div key={index} className="space-y-2 rounded-lg border p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">
                    {(ranges[index]?.to ?? 0) > (ranges[index]?.from ?? 0)
                      ? t('contestsPage.form.placeRange', { from: ranges[index]?.from, to: ranges[index]?.to })
                      : t('contestsPage.form.place', { place: ranges[index]?.from ?? index + 1 })}
                  </span>
                  <div className="ml-auto flex items-center gap-1.5">
                    <Label htmlFor={`contest-prize-places-${index}`} className="text-xs text-muted-foreground">
                      {t('contestsPage.form.placesCount')}
                    </Label>
                    <Input
                      id={`contest-prize-places-${index}`}
                      inputMode="numeric"
                      className="h-8 w-16"
                      value={prize.places}
                      onChange={(e) => setPrize(index, { places: e.target.value })}
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t('contestsPage.form.removePrize')}
                    disabled={draft.prizes.length === 1}
                    onClick={() => set('prizes', draft.prizes.filter((_, i) => i !== index))}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Select value={prize.kind} onValueChange={(value) => setPrize(index, { kind: value as WheelSectorKind })}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PRIZE_KINDS.map((kind) => (
                        <SelectItem key={kind} value={kind}>
                          {t(`wheelConfigPage.kinds.${kind}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {NEEDS_AMOUNT.has(prize.kind) ? (
                    <Input
                      inputMode="numeric"
                      placeholder={t(`wheelConfigPage.amountLabel.${prize.kind}`)}
                      value={prize.amount}
                      onChange={(e) => setPrize(index, { amount: e.target.value })}
                    />
                  ) : null}
                  <Input
                    placeholder={t('contestsPage.form.prizeTitle')}
                    value={prize.titleRu}
                    onChange={(e) => setPrize(index, { titleRu: e.target.value })}
                  />
                  <Input
                    placeholder={t('contestsPage.form.prizeTitleEn')}
                    aria-label={t('contestsPage.form.prizeTitleEn')}
                    value={prize.titleEn}
                    onChange={(e) => setPrize(index, { titleEn: e.target.value })}
                  />
                </div>
                {prize.kind === 'KEY' ? (
                  <Select value={prize.keyPoolId} onValueChange={(value) => setPrize(index, { keyPoolId: value })}>
                    <SelectTrigger>
                      <SelectValue placeholder={t('wheelConfigPage.form.poolPlaceholder')} />
                    </SelectTrigger>
                    <SelectContent>
                      {pools.map((pool) => (
                        <SelectItem key={pool.id} value={pool.id}>
                          {pool.name} · {t('wheelConfigPage.keysLeft', { count: pool.available })}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : null}
                {prize.kind === 'PROMOCODE' ? (
                  <PromoPrizeFields
                    draft={prize.promo}
                    onChange={(next) => setPrize(index, { promo: next })}
                  />
                ) : null}
                {prize.kind === 'MANUAL' ? (
                  <Textarea
                    rows={2}
                    placeholder={t('wheelConfigPage.form.instructionsPlaceholder')}
                    value={prize.manualInstructions}
                    onChange={(e) => setPrize(index, { manualInstructions: e.target.value })}
                  />
                ) : null}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

/** A leaderboard score as a person says it: «3 друга», «1 250 ₽», «12,4 ГБ», «350 баллов». */
function useScoreFormat(): (metric: ContestMetric | null, score: number, currency: string) => string {
  const { t } = useTranslation()
  return (metric, score, currency) => {
    const locale = activeLocale()
    switch (metric) {
      case 'REFERRALS_PAID':
        return t('contestsPage.units.friends', { count: score })
      case 'POINTS_EARNED':
        return t('contestsPage.units.points', { count: score })
      case 'TRAFFIC': {
        const gb = score / GB
        return t('contestsPage.units.gb', { value: gb.toLocaleString(locale, { maximumFractionDigits: gb >= 100 ? 0 : 1 }) })
      }
      case 'PAYMENTS_SUM': {
        const major = score / 100
        try {
          return new Intl.NumberFormat(locale, {
            style: 'currency',
            currency,
            maximumFractionDigits: Number.isInteger(major) ? 0 : 2,
          }).format(major)
        } catch {
          return `${major.toLocaleString(locale)} ${currency}`
        }
      }
      default:
        return String(score)
    }
  }
}

/** A leaderboard's places: live while it runs, as the end counted them after. */
function StandingsDialog({ contest, onClose }: { readonly contest: Contest | null; readonly onClose: () => void }) {
  const { t } = useTranslation()
  const format = useScoreFormat()
  const standings = useInfiniteQuery({
    queryKey: ['admin', 'contests', contest?.id, 'standings'],
    queryFn: ({ pageParam }) => listContestStandings(contest?.id as string, { take: ENTRANTS_PAGE, skip: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((sum, page) => sum + page.rows.length, 0)
      return loaded < last.total && last.rows.length > 0 ? loaded : undefined
    },
    enabled: contest !== null,
  })
  const rows = (standings.data?.pages ?? []).flatMap((page) => page.rows)
  const total = standings.data?.pages[0]?.total ?? 0
  const places = contest?.places ?? 0

  return (
    <Dialog open={contest !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {contest ? sectorTitle(contest, t('contestsPage.unnamed')) : ''} —{' '}
            {t('contestsPage.standings.title', { count: total })}
          </DialogTitle>
        </DialogHeader>
        {contest !== null && contest.status !== 'DRAWN' ? (
          <p className="text-xs text-muted-foreground">{t('contestsPage.standings.liveHint')}</p>
        ) : null}
        {standings.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t('contestsPage.standings.empty')}</p>
        ) : (
          <ul className="divide-y rounded-lg border" data-testid="contest-standings">
            {rows.map((row) => {
              const label = row.name || (row.username ? `@${row.username}` : t('contestsPage.entrants.noName'))
              return (
                <li
                  key={row.userId}
                  className={cn(
                    'flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm',
                    row.rank <= places ? 'bg-primary/5' : '',
                  )}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="w-8 shrink-0 text-right font-mono text-xs text-muted-foreground">#{row.rank}</span>
                    {row.telegramId ? (
                      <Link className="font-medium underline-offset-2 hover:underline" to={`/users/${row.telegramId}`}>
                        {label}
                      </Link>
                    ) : (
                      <span className="font-medium">{label}</span>
                    )}
                    {row.rank <= places ? (
                      <Trophy className="h-3.5 w-3.5 shrink-0 text-amber-500" aria-label={t('contestsPage.standings.prizeLine')} />
                    ) : null}
                  </div>
                  <span className="tabular-nums">{format(contest?.metric ?? null, row.score, contest?.currency ?? 'RUB')}</span>
                </li>
              )
            })}
          </ul>
        )}
        {standings.hasNextPage ? (
          <Button
            variant="outline"
            size="sm"
            className="self-start"
            disabled={standings.isFetchingNextPage}
            onClick={() => void standings.fetchNextPage()}
          >
            {t('contestsPage.entrants.more')}
          </Button>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

/** Who entered, newest first, with their tickets. */
function EntrantsDialog({ contest, onClose }: { readonly contest: Contest | null; readonly onClose: () => void }) {
  const { t } = useTranslation()
  const entrants = useInfiniteQuery({
    queryKey: ['admin', 'contests', contest?.id, 'entrants'],
    queryFn: ({ pageParam }) => listContestEntrants(contest?.id as string, { take: ENTRANTS_PAGE, skip: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((sum, page) => sum + page.rows.length, 0)
      return loaded < last.total && last.rows.length > 0 ? loaded : undefined
    },
    enabled: contest !== null,
  })
  const rows = (entrants.data?.pages ?? []).flatMap((page) => page.rows)
  const total = entrants.data?.pages[0]?.total ?? contest?.entries ?? 0
  const live = contest !== null && contest.status !== 'DRAWN'
  const hasTickets = contest !== null && (contest.ticketsPerPurchase > 0 || contest.ticketsPerReferral > 0)

  return (
    <Dialog open={contest !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {contest ? sectorTitle(contest, t('contestsPage.unnamed')) : ''} —{' '}
            {t('contestsPage.entrants.title', { count: total })}
          </DialogTitle>
        </DialogHeader>
        {hasTickets && live ? (
          <p className="text-xs text-muted-foreground">{t('contestsPage.entrants.liveHint')}</p>
        ) : null}
        {entrants.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t('contestsPage.entrants.empty')}</p>
        ) : (
          <ul className="divide-y rounded-lg border" data-testid="contest-entrants">
            {rows.map((row) => {
              const label = row.name || (row.username ? `@${row.username}` : t('contestsPage.entrants.noName'))
              return (
                <li key={row.userId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                  <div className="min-w-0">
                    {row.telegramId ? (
                      <Link className="font-medium underline-offset-2 hover:underline" to={`/users/${row.telegramId}`}>
                        {label}
                      </Link>
                    ) : (
                      <span className="font-medium">{label}</span>
                    )}
                    <div className="text-xs text-muted-foreground">
                      {new Date(row.enteredAt).toLocaleString(activeLocale())}
                    </div>
                  </div>
                  {hasTickets ? (
                    <Badge variant="secondary" className="gap-1 tabular-nums">
                      <Ticket className="h-3 w-3" />
                      {t('contestsPage.entrants.tickets', { count: row.tickets })}
                    </Badge>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
        {entrants.hasNextPage ? (
          <Button
            variant="outline"
            size="sm"
            className="self-start"
            disabled={entrants.isFetchingNextPage}
            onClick={() => void entrants.fetchNextPage()}
          >
            {t('contestsPage.entrants.more')}
          </Button>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

/** The winners of one drawn contest, with the manual prizes settled in place. */
function WinnersDialog({ contest, onClose }: { readonly contest: Contest | null; readonly onClose: () => void }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [settling, setSettling] = useState<{ winner: ContestWinner; action: 'issue' | 'refuse' } | null>(null)
  const [note, setNote] = useState('')
  const format = useScoreFormat()

  const winners = useQuery({
    queryKey: ['admin', 'contests', contest?.id, 'winners'],
    queryFn: () => listContestWinners(contest?.id as string),
    enabled: contest !== null,
  })

  const settle = useMutation({
    mutationFn: ({ winner, action }: { winner: ContestWinner; action: 'issue' | 'refuse' }) =>
      action === 'issue'
        ? issueContestPrize(winner.id, note.trim() === '' ? null : note.trim())
        : refuseContestPrize(winner.id, note.trim()),
    onSuccess: (_result, variables) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'contests'] })
      setSettling(null)
      setNote('')
      // Refusing a prize and handing it over are opposite acts; one toast for
      // both told the operator the wrong thing half the time.
      toast.success(
        t(variables.action === 'issue' ? 'wheelPrizesPage.toast.issued' : 'wheelPrizesPage.toast.refused'),
      )
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error, t('common.error')))
      queryClient.invalidateQueries({ queryKey: ['admin', 'contests'] })
    },
  })

  return (
    <Dialog open={contest !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {contest ? sectorTitle(contest, t('contestsPage.unnamed')) : ''} —{' '}
            {t('contestsPage.winners.title', { entrants: contest?.drawnEntries ?? 0 })}
          </DialogTitle>
        </DialogHeader>
        {contest !== null && (contest.drawnTickets !== null || contest.drawSeed !== null) ? (
          <div className="space-y-1 rounded-lg bg-muted p-3 text-xs text-muted-foreground">
            {contest.drawnTickets !== null && contest.drawnTickets !== contest.drawnEntries ? (
              <div>{t('contestsPage.draw.tickets', { count: contest.drawnTickets })}</div>
            ) : null}
            {contest.drawSeed !== null ? (
              <>
                <div className="font-medium text-foreground">{t('contestsPage.draw.seed')}</div>
                <code className="block break-all" data-testid="contest-draw-seed">
                  {contest.drawSeed}
                </code>
                <div>{t('contestsPage.draw.seedHint')}</div>
              </>
            ) : null}
          </div>
        ) : null}
        {winners.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : (winners.data?.length ?? 0) === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t('contestsPage.winners.empty')}</p>
        ) : (
          <ul className="space-y-2">
            {(winners.data ?? []).map((winner) => (
              <li key={winner.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3">
                <div className="text-sm">
                  <span className="font-medium">
                    {t('contestsPage.winners.place', { place: winner.place })} ·{' '}
                    {sectorTitle({ title: winner.prizeTitle }, t('wheelPrizesPage.unnamedPrize'))}
                  </span>
                  <div className="text-xs text-muted-foreground">
                    {winner.winner.telegramId ? (
                      <Link className="underline-offset-2 hover:underline" to={`/users/${winner.winner.telegramId}`}>
                        {winner.winner.name || winner.winner.id}
                      </Link>
                    ) : (
                      winner.winner.name || winner.winner.id
                    )}
                    {winner.instructions ? ` · ${winner.instructions}` : ''}
                    {winner.score != null && contest !== null
                      ? ` · ${t('contestsPage.winnersExtra.score', { score: format(contest.metric, winner.score, contest.currency) })}`
                      : ''}
                  </div>
                  {winner.heldForReview && winner.status === 'PENDING' ? (
                    <div className="text-xs text-amber-600 dark:text-amber-400">{t('contestsPage.winnersExtra.held')}</div>
                  ) : null}
                  {winner.signals ? <WinnerSignalsLine signals={winner.signals} /> : null}
                </div>
                <div className="flex gap-1">
                  {winner.status === 'PENDING' ? (
                    <>
                      <Button size="sm" className="gap-1" onClick={() => setSettling({ winner, action: 'issue' })}>
                        <Check className="h-4 w-4" />
                        {t('wheelPrizesPage.actions.issue')}
                      </Button>
                      <Button size="sm" variant="destructive" className="gap-1" onClick={() => setSettling({ winner, action: 'refuse' })}>
                        <X className="h-4 w-4" />
                        {t('wheelPrizesPage.actions.refuse')}
                      </Button>
                    </>
                  ) : (
                    <Badge variant={winner.status === 'SETTLED' ? 'default' : 'secondary'}>
                      {t(`wheelPrizesPage.tabs.${winner.status === 'EMPTY' ? 'SETTLED' : winner.status}`)}
                    </Badge>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        {settling !== null ? (
          <div className="space-y-2 rounded-lg border p-3">
            <Label htmlFor="contest-settle-note">
              {settling.action === 'refuse'
                ? t('wheelPrizesPage.refuseDialog.reasonLabel')
                : t('wheelPrizesPage.issueDialog.noteLabel')}
            </Label>
            <Textarea id="contest-settle-note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setSettling(null)}>
                {t('common.cancel')}
              </Button>
              <Button
                size="sm"
                variant={settling.action === 'refuse' ? 'destructive' : 'default'}
                disabled={settle.isPending || (settling.action === 'refuse' && note.trim().length < 3)}
                onClick={() => settle.mutate(settling)}
              >
                {settling.action === 'refuse' ? t('wheelPrizesPage.actions.refuse') : t('wheelPrizesPage.actions.issue')}
              </Button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
