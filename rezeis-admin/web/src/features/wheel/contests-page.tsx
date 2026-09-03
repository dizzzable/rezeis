import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { AlertTriangle, Check, Dices, Pencil, Plus, Trash2, X } from 'lucide-react'

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
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'

import {
  cancelContest,
  createContest,
  deleteContest,
  drawContest,
  issueContestPrize,
  listContestWinners,
  listContests,
  publishContest,
  refuseContestPrize,
  updateContest,
  type Contest,
  type ContestPayload,
  type ContestPrize,
  type ContestWinner,
} from './contests-api'
import { listKeyPools } from './wheel-keys-api'
import { sectorTitle, type WheelSectorKind } from './wheel-config-api'
import { PromoPrizeFields } from './promo-prize-fields'
import { emptyPromoDraft, promoDraftOf, promoPayload, type PromoDraft } from './promo-prize'

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

interface PrizeDraft {
  kind: WheelSectorKind
  titleRu: string
  amount: string
  keyPoolId: string
  manualInstructions: string
  /** What a PROMOCODE prize's code actually does. */
  promo: PromoDraft
}

interface Draft {
  titleRu: string
  titleEn: string
  descriptionRu: string
  startAt: string
  endAt: string
  maxEntries: string
  prizes: PrizeDraft[]
}

function emptyPrize(): PrizeDraft {
  return {
    kind: 'POINTS',
    titleRu: '',
    amount: '100',
    keyPoolId: '',
    manualInstructions: '',
    promo: emptyPromoDraft(),
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
    startAt: toLocalInput(start.toISOString()),
    endAt: toLocalInput(end.toISOString()),
    maxEntries: '',
    prizes: [emptyPrize()],
  }
}

function toDraft(contest: Contest): Draft {
  return {
    titleRu: contest.title?.ru ?? '',
    titleEn: contest.title?.en ?? '',
    descriptionRu: contest.description?.ru ?? '',
    startAt: toLocalInput(contest.startAt),
    endAt: toLocalInput(contest.endAt),
    maxEntries: contest.maxEntries === null ? '' : String(contest.maxEntries),
    prizes: contest.prizes.map((prize) => ({
      kind: prize.kind,
      titleRu: prize.title?.ru ?? '',
      amount: String(prize.amount),
      keyPoolId: prize.keyPoolId ?? '',
      manualInstructions: prize.manualInstructions ?? '',
      promo: promoDraftOf(prize),
    })),
  }
}

/** `datetime-local` gives back '' when the field is cleared. */
function isValidLocalDate(value: string): boolean {
  return value.trim() !== '' && !Number.isNaN(new Date(value).getTime())
}

function toPayload(draft: Draft): ContestPayload {
  const maxEntries = draft.maxEntries.trim() === '' ? null : Math.trunc(Number(draft.maxEntries))
  return {
    title: { ru: draft.titleRu.trim(), en: draft.titleEn.trim() || draft.titleRu.trim() },
    description: { ru: draft.descriptionRu.trim(), en: draft.descriptionRu.trim() },
    startAt: new Date(draft.startAt).toISOString(),
    endAt: new Date(draft.endAt).toISOString(),
    maxEntries: Number.isFinite(maxEntries) ? maxEntries : null,
    // Places follow the list order: the first row is first prize.
    prizes: draft.prizes.map<Omit<ContestPrize, 'id'>>((prize, index) => ({
      place: index + 1,
      kind: prize.kind,
      title: { ru: prize.titleRu.trim(), en: prize.titleRu.trim() },
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
 * Contests: an event with a draw at the end.
 *
 * The page is built around the status a contest is in, because that is what
 * decides which buttons make sense. A draft can be edited and published; a
 * live one can be cancelled, and drawn once its end has passed; a drawn one
 * shows its winners, with the prizes a human hands over settled right here.
 */
export default function ContestsPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState<{ id: string | null; draft: Draft } | null>(null)
  const [removing, setRemoving] = useState<Contest | null>(null)
  const [winnersOf, setWinnersOf] = useState<Contest | null>(null)

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
      toast.success(t('contestsPage.toast.cancelled'))
    },
    onError: fail,
  })
  const draw = useMutation({
    mutationFn: drawContest,
    onSuccess: (result) => {
      refresh()
      if (result.drawn) {
        toast.success(t('contestsPage.toast.drawn', { winners: result.winners, entrants: result.entrants }))
      } else {
        toast.error(t(`contestsPage.drawRefused.${result.reason}`))
      }
    },
    onError: fail,
  })

  const items = contests.data ?? []

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
                          {t('contestsPage.prizesCount', { count: contest.prizes.length })}
                        </div>
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
                      </TableCell>
                      <TableCell className="align-top text-xs text-muted-foreground">
                        {new Date(contest.startAt).toLocaleString()}
                        <br />
                        {new Date(contest.endAt).toLocaleString()}
                      </TableCell>
                      <TableCell className="align-top text-right tabular-nums">
                        {contest.entries}
                        {contest.maxEntries !== null ? ` / ${contest.maxEntries}` : ''}
                      </TableCell>
                      <TableCell className="align-top">
                        <Badge variant={contest.status === 'ACTIVE' ? 'default' : 'secondary'}>
                          {t(`contestsPage.status.${contest.status}`)}
                        </Badge>
                        {contest.status === 'ACTIVE' && over ? (
                          <div className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                            {t('contestsPage.awaitingDraw')}
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
                              <Button variant="outline" size="sm" disabled={cancel.isPending} onClick={() => cancel.mutate(contest.id)}>
                                {t('contestsPage.actions.cancel')}
                              </Button>
                            </>
                          ) : null}
                          {contest.status === 'DRAWN' ? (
                            <Button variant="outline" size="sm" onClick={() => setWinnersOf(contest)}>
                              {t('contestsPage.actions.winners', { count: contest.winners })}
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
              locked={
                editing.id !== null &&
                (items.find((c) => c.id === editing.id)?.status ?? 'DRAFT') !== 'DRAFT'
              }
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

      <WinnersDialog contest={winnersOf} onClose={() => setWinnersOf(null)} />
    </div>
  )
}

function ContestForm({
  draft,
  locked,
  pools,
  onChange,
}: {
  readonly draft: Draft
  /** Live: only the wording may change. */
  readonly locked: boolean
  readonly pools: ReadonlyArray<{ id: string; name: string; available: number }>
  readonly onChange: (draft: Draft) => void
}) {
  const { t } = useTranslation()
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => onChange({ ...draft, [key]: value })
  const setPrize = (index: number, patch: Partial<PrizeDraft>) =>
    set(
      'prizes',
      draft.prizes.map((prize, i) => (i === index ? { ...prize, ...patch } : prize)),
    )

  return (
    <div className="space-y-4">
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
      <div className="space-y-1.5">
        <Label htmlFor="contest-description">{t('contestsPage.form.description')}</Label>
        <Textarea id="contest-description" rows={3} value={draft.descriptionRu} onChange={(e) => set('descriptionRu', e.target.value)} />
      </div>

      {locked ? (
        <p className="text-xs text-muted-foreground">{t('contestsPage.form.locked')}</p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="contest-start">{t('contestsPage.form.startAt')}</Label>
              <Input id="contest-start" type="datetime-local" value={draft.startAt} onChange={(e) => set('startAt', e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="contest-end">{t('contestsPage.form.endAt')}</Label>
              <Input id="contest-end" type="datetime-local" value={draft.endAt} onChange={(e) => set('endAt', e.target.value)} />
            </div>
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
          </div>

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
            <p className="text-xs text-muted-foreground">{t('contestsPage.form.prizesHint')}</p>
            {draft.prizes.map((prize, index) => (
              <div key={index} className="space-y-2 rounded-lg border p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{t('contestsPage.form.place', { place: index + 1 })}</span>
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
                <div className="grid gap-2 sm:grid-cols-3">
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
                  <Input
                    placeholder={t('contestsPage.form.prizeTitle')}
                    value={prize.titleRu}
                    onChange={(e) => setPrize(index, { titleRu: e.target.value })}
                  />
                  {NEEDS_AMOUNT.has(prize.kind) ? (
                    <Input
                      inputMode="numeric"
                      placeholder={t(`wheelConfigPage.amountLabel.${prize.kind}`)}
                      value={prize.amount}
                      onChange={(e) => setPrize(index, { amount: e.target.value })}
                    />
                  ) : null}
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

/** The winners of one drawn contest, with the manual prizes settled in place. */
function WinnersDialog({ contest, onClose }: { readonly contest: Contest | null; readonly onClose: () => void }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [settling, setSettling] = useState<{ winner: ContestWinner; action: 'issue' | 'refuse' } | null>(null)
  const [note, setNote] = useState('')

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
                  </div>
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
