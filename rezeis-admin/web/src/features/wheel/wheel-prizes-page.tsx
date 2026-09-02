import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Check, Gift, MessageSquare, X } from 'lucide-react'

import { getErrorMessage } from '@/lib/http-errors'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'

import {
  issueManualPrize,
  listManualPrizes,
  prizeTitle,
  refuseManualPrize,
  type ManualPrize,
  type WheelSpinStatus,
} from './wheel-prizes-api'

/** The three states an operator sorts this queue by. */
const TABS: readonly WheelSpinStatus[] = ['PENDING', 'SETTLED', 'REFUSED']

type Settlement = { readonly prize: ManualPrize; readonly action: 'issue' | 'refuse' }

/**
 * The prizes waiting on a human.
 *
 * A jackpot is a bank transfer somebody makes and a T-shirt is a parcel
 * somebody posts, so the screen is built around the two things an operator
 * actually needs: WHO won, and WHAT the operator told themselves to do about
 * it when they set the sector up. Everything else is one click away — the
 * conversation with the winner, and their card.
 */
export default function WheelPrizesPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [status, setStatus] = useState<WheelSpinStatus>('PENDING')
  const [settling, setSettling] = useState<Settlement | null>(null)
  const [note, setNote] = useState('')

  const prizes = useQuery({
    queryKey: ['admin', 'wheel', 'prizes', status],
    queryFn: () => listManualPrizes({ status, limit: 100 }),
  })

  const close = useCallback(() => {
    setSettling(null)
    setNote('')
  }, [])

  const settle = useMutation({
    mutationFn: async ({ prize, action }: Settlement) =>
      action === 'issue'
        ? issueManualPrize(prize.spinId, note.trim() === '' ? null : note.trim())
        : refuseManualPrize(prize.spinId, note.trim()),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'wheel', 'prizes'] })
      toast.success(
        variables.action === 'issue'
          ? t('wheelPrizesPage.toast.issued')
          : t('wheelPrizesPage.toast.refused'),
      )
      close()
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error, t('common.error')))
      // The prize is gone from under them — a colleague settled it first — so
      // the list has to catch up before they try again on a stale row.
      queryClient.invalidateQueries({ queryKey: ['admin', 'wheel', 'prizes'] })
    },
  })

  const items = prizes.data?.items ?? []
  // A refusal has to say why; handing something over does not.
  const canSubmit = useMemo(
    () => settling?.action !== 'refuse' || note.trim().length >= 3,
    [settling, note],
  )

  return (
    <div className="space-y-6">
      <header>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <Gift className="h-6 w-6" />
          {t('wheelPrizesPage.title')}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('wheelPrizesPage.subtitle')}</p>
      </header>

      <Tabs value={status} onValueChange={(value) => setStatus(value as WheelSpinStatus)}>
        <TabsList>
          {TABS.map((tab) => (
            <TabsTrigger key={tab} value={tab}>
              {t(`wheelPrizesPage.tabs.${tab}`)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <Card>
        <CardContent className="p-0">
          {prizes.isLoading ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : items.length === 0 ? (
            <p className="p-8 text-center text-sm text-muted-foreground">
              {t(`wheelPrizesPage.empty.${status}`)}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('wheelPrizesPage.columns.prize')}</TableHead>
                  <TableHead>{t('wheelPrizesPage.columns.winner')}</TableHead>
                  <TableHead>{t('wheelPrizesPage.columns.won')}</TableHead>
                  <TableHead className="text-right">
                    {t('wheelPrizesPage.columns.actions')}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((prize) => (
                  <TableRow key={prize.spinId}>
                    <TableCell className="align-top">
                      <div className="font-medium">
                        {prizeTitle(prize, t('wheelPrizesPage.unnamedPrize'))}
                      </div>
                      {prize.instructions ? (
                        // What the operator told themselves to do. Shown here
                        // and nowhere near the winner: it is a work note, not
                        // a promise made to anybody.
                        <p className="mt-1 max-w-md whitespace-pre-wrap text-xs text-muted-foreground">
                          {prize.instructions}
                        </p>
                      ) : null}
                      {prize.settlementNote ? (
                        <p className="mt-2 max-w-md whitespace-pre-wrap text-xs">
                          <span className="text-muted-foreground">
                            {t('wheelPrizesPage.noteLabel')}:{' '}
                          </span>
                          {prize.settlementNote}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell className="align-top">
                      <WinnerCell prize={prize} />
                    </TableCell>
                    <TableCell className="align-top text-sm text-muted-foreground">
                      {new Date(prize.createdAt).toLocaleString()}
                      {prize.settledAt ? (
                        <div className="text-xs">
                          {t('wheelPrizesPage.settledAt')}:{' '}
                          {new Date(prize.settledAt).toLocaleString()}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="align-top">
                      <div className="flex flex-wrap justify-end gap-2">
                        {prize.ticketId ? (
                          <Button asChild variant="outline" size="sm" className="gap-1">
                            <Link to={`/support-tickets?ticket=${encodeURIComponent(prize.ticketId)}`}>
                              <MessageSquare className="h-4 w-4" />
                              {t('wheelPrizesPage.actions.openChat')}
                            </Link>
                          </Button>
                        ) : null}
                        {prize.status === 'PENDING' ? (
                          <>
                            <Button
                              size="sm"
                              className="gap-1"
                              onClick={() => {
                                setSettling({ prize, action: 'issue' })
                                setNote('')
                              }}
                            >
                              <Check className="h-4 w-4" />
                              {t('wheelPrizesPage.actions.issue')}
                            </Button>
                            <Button
                              size="sm"
                              variant="destructive"
                              className="gap-1"
                              onClick={() => {
                                setSettling({ prize, action: 'refuse' })
                                setNote('')
                              }}
                            >
                              <X className="h-4 w-4" />
                              {t('wheelPrizesPage.actions.refuse')}
                            </Button>
                          </>
                        ) : (
                          <Badge variant={prize.status === 'SETTLED' ? 'default' : 'secondary'}>
                            {t(`wheelPrizesPage.tabs.${prize.status}`)}
                          </Badge>
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

      <Dialog open={settling !== null} onOpenChange={(open) => (open ? undefined : close())}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {settling?.action === 'refuse'
                ? t('wheelPrizesPage.refuseDialog.title')
                : t('wheelPrizesPage.issueDialog.title')}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {settling?.action === 'refuse'
                ? t('wheelPrizesPage.refuseDialog.description')
                : t('wheelPrizesPage.issueDialog.description')}
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="wheel-prize-note">
                {settling?.action === 'refuse'
                  ? t('wheelPrizesPage.refuseDialog.reasonLabel')
                  : t('wheelPrizesPage.issueDialog.noteLabel')}
              </Label>
              <Textarea
                id="wheel-prize-note"
                rows={4}
                value={note}
                maxLength={2000}
                onChange={(event) => setNote(event.target.value)}
                placeholder={
                  settling?.action === 'refuse'
                    ? t('wheelPrizesPage.refuseDialog.reasonPlaceholder')
                    : t('wheelPrizesPage.issueDialog.notePlaceholder')
                }
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={close}>
              {t('common.cancel')}
            </Button>
            <Button
              variant={settling?.action === 'refuse' ? 'destructive' : 'default'}
              disabled={!canSubmit || settle.isPending}
              onClick={() => {
                if (settling !== null) settle.mutate(settling)
              }}
            >
              {settling?.action === 'refuse'
                ? t('wheelPrizesPage.actions.refuse')
                : t('wheelPrizesPage.actions.issue')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/**
 * Who won it, and a way to reach them.
 *
 * The link to the user card is offered only when there is a telegram id: the
 * card is addressed by one, and a web-only account has none — a link that
 * lands on a broken page is worse than no link.
 */
function WinnerCell({ prize }: { readonly prize: ManualPrize }) {
  const { winner } = prize
  const label = winner.name?.trim() !== '' ? winner.name : winner.username || winner.id
  return (
    <div className="text-sm">
      {winner.telegramId ? (
        <Link className="font-medium underline-offset-2 hover:underline" to={`/users/${winner.telegramId}`}>
          {label}
        </Link>
      ) : (
        <span className="font-medium">{label}</span>
      )}
      <div className="text-xs text-muted-foreground">
        {winner.username ? `@${winner.username}` : winner.email || winner.id}
      </div>
    </div>
  )
}
