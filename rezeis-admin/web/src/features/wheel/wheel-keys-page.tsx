import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { toast } from 'sonner'
import { Eye, EyeOff, KeyRound, Plus, Trash2, Upload } from 'lucide-react'

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
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'

import {
  createKeyPool,
  deleteKeyPool,
  deletePoolKey,
  listKeyPools,
  listPoolKeys,
  loadKeys,
  type KeyPool,
} from './wheel-keys-api'

type KeyFilter = 'available' | 'claimed'

/**
 * The prize inventory: batches of one-use secrets a KEY sector hands out.
 *
 * Built around the three questions an operator actually has — how many are
 * left, who got which one, and did my paste land — because everything else
 * about a pool is a name and a note.
 */
export default function WheelKeysPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState<string | null>(null)
  const [filter, setFilter] = useState<KeyFilter>('available')
  const [reveal, setReveal] = useState(false)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [note, setNote] = useState('')
  const [loading, setLoading] = useState(false)
  const [paste, setPaste] = useState('')
  const [deletingPool, setDeletingPool] = useState<KeyPool | null>(null)

  const pools = useQuery({ queryKey: ['admin', 'wheel', 'key-pools'], queryFn: listKeyPools })
  const list = pools.data ?? []

  // The operator's click is stored; which pool is actually SHOWN is derived
  // from it. An effect that corrected the stored id would have to run after
  // the list changed — one render of a table querying a pool that is gone —
  // and `selected` would briefly disagree with the screen. Falling back here
  // means a pool deleted elsewhere simply shows the first one instead.
  const current = list.find((pool) => pool.id === selected) ?? list[0] ?? null
  const currentId = current?.id ?? null

  // Paged, not truncated. A pool of five thousand keys is a supported size —
  // the loader accepts that many in one paste — and a page that showed the
  // first five hundred and stopped made the winner of key 501 unfindable,
  // which is the one question this screen exists to answer.
  const keys = useInfiniteQuery({
    queryKey: ['admin', 'wheel', 'key-pools', currentId, filter, reveal],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      listPoolKeys(currentId as string, {
        claimed: filter === 'claimed',
        // Revealing is opt-in AND permission-gated on the server: without
        // `wheel:view_secrets` the values come back masked whatever is asked.
        reveal,
        cursor: pageParam,
        limit: 200,
      }),
    getNextPageParam: (last) => last.nextCursor,
    enabled: currentId !== null,
  })
  const keyRows = (keys.data?.pages ?? []).flatMap((page) => page.items)

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['admin', 'wheel', 'key-pools'] })
  }, [queryClient])

  const fail = useCallback(
    (error: unknown) => toast.error(getErrorMessage(error, t('common.error'))),
    [t],
  )

  const create = useMutation({
    mutationFn: () =>
      createKeyPool({ name: name.trim(), ...(note.trim() ? { note: note.trim() } : {}) }),
    onSuccess: (pool) => {
      invalidate()
      setSelected(pool.id)
      setCreating(false)
      setName('')
      setNote('')
      toast.success(t('wheelKeysPage.toast.poolCreated'))
    },
    onError: fail,
  })

  const load = useMutation({
    mutationFn: () => loadKeys(currentId as string, paste),
    onSuccess: (result) => {
      invalidate()
      queryClient.invalidateQueries({ queryKey: ['admin', 'wheel', 'key-pools', currentId] })
      setLoading(false)
      setPaste('')
      // The counts, always — a paste of 200 that adds 3 is visibly not what
      // the operator expected, and only the numbers can tell them that.
      toast.success(
        t('wheelKeysPage.toast.loaded', {
          added: result.added,
          duplicates: result.duplicates,
        }),
      )
    },
    onError: fail,
  })

  const removePool = useMutation({
    mutationFn: (poolId: string) => deleteKeyPool(poolId),
    onSuccess: () => {
      invalidate()
      setDeletingPool(null)
      toast.success(t('wheelKeysPage.toast.poolDeleted'))
    },
    onError: (error: unknown) => {
      fail(error)
      setDeletingPool(null)
    },
  })

  const removeKey = useMutation({
    mutationFn: (keyId: string) => deletePoolKey(currentId as string, keyId),
    onSuccess: () => {
      invalidate()
      queryClient.invalidateQueries({ queryKey: ['admin', 'wheel', 'key-pools', currentId] })
      toast.success(t('wheelKeysPage.toast.keyRemoved'))
    },
    onError: fail,
  })

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <KeyRound className="h-6 w-6" />
            {t('wheelKeysPage.title')}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('wheelKeysPage.subtitle')}</p>
        </div>
        <Button className="gap-1" onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" />
          {t('wheelKeysPage.actions.newPool')}
        </Button>
      </header>

      {pools.isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : list.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            {t('wheelKeysPage.emptyPools')}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
          <nav className="space-y-2" aria-label={t('wheelKeysPage.title')}>
            {list.map((pool) => (
              <button
                key={pool.id}
                type="button"
                onClick={() => setSelected(pool.id)}
                className={`w-full rounded-lg border p-3 text-left transition-colors ${
                  pool.id === currentId ? 'border-primary bg-accent' : 'hover:bg-accent/50'
                }`}
              >
                <div className="font-medium">{pool.name}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {t('wheelKeysPage.counts', {
                    available: pool.available,
                    total: pool.total,
                  })}
                </div>
                {pool.available === 0 && pool.total > 0 ? (
                  <Badge variant="secondary" className="mt-2">
                    {t('wheelKeysPage.exhausted')}
                  </Badge>
                ) : null}
              </button>
            ))}
          </nav>

          <div className="space-y-4">
            {current === null ? null : (
              <>
                <Card>
                  <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
                    <div>
                      <div className="text-lg font-semibold">{current.name}</div>
                      {current.note ? (
                        <p className="mt-1 text-sm text-muted-foreground">{current.note}</p>
                      ) : null}
                      <p className="mt-2 text-sm">
                        {t('wheelKeysPage.stats', {
                          available: current.available,
                          claimed: current.claimed,
                          total: current.total,
                        })}
                      </p>
                      {current.sectors.length > 0 ? (
                        <p className="mt-1 text-xs text-muted-foreground">
                          {t('wheelKeysPage.usedBy')}:{' '}
                          {current.sectors
                            .map(
                              (sector) =>
                                sector.title?.ru || sector.title?.en || sector.id,
                            )
                            .join(', ')}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button className="gap-1" onClick={() => setLoading(true)}>
                        <Upload className="h-4 w-4" />
                        {t('wheelKeysPage.actions.load')}
                      </Button>
                      <Button
                        variant="destructive"
                        className="gap-1"
                        onClick={() => setDeletingPool(current)}
                      >
                        <Trash2 className="h-4 w-4" />
                        {t('wheelKeysPage.actions.deletePool')}
                      </Button>
                    </div>
                  </CardContent>
                </Card>

                <div className="flex flex-wrap items-center justify-between gap-3">
                  <Tabs value={filter} onValueChange={(value) => setFilter(value as KeyFilter)}>
                    <TabsList>
                      <TabsTrigger value="available">
                        {t('wheelKeysPage.filters.available')}
                      </TabsTrigger>
                      <TabsTrigger value="claimed">
                        {t('wheelKeysPage.filters.claimed')}
                      </TabsTrigger>
                    </TabsList>
                  </Tabs>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1"
                    onClick={() => setReveal((value) => !value)}
                  >
                    {reveal ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    {reveal ? t('wheelKeysPage.actions.hide') : t('wheelKeysPage.actions.reveal')}
                  </Button>
                </div>

                <Card>
                  <CardContent className="p-0">
                    {keys.isLoading ? (
                      <div className="space-y-2 p-4">
                        <Skeleton className="h-8 w-full" />
                        <Skeleton className="h-8 w-full" />
                      </div>
                    ) : keyRows.length === 0 ? (
                      <p className="p-8 text-center text-sm text-muted-foreground">
                        {t(`wheelKeysPage.emptyKeys.${filter}`)}
                      </p>
                    ) : (
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>{t('wheelKeysPage.columns.key')}</TableHead>
                            {filter === 'claimed' ? (
                              <>
                                <TableHead>{t('wheelKeysPage.columns.winner')}</TableHead>
                                <TableHead>{t('wheelKeysPage.columns.claimedAt')}</TableHead>
                              </>
                            ) : (
                              <TableHead className="text-right">
                                {t('wheelKeysPage.columns.actions')}
                              </TableHead>
                            )}
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {keyRows.map((key) => (
                            <TableRow key={key.id}>
                              <TableCell className="font-mono text-sm">
                                {key.value}
                                {key.masked && reveal ? (
                                  // Asked to reveal and still masked: the
                                  // server refused, and saying so beats
                                  // leaving the operator to wonder.
                                  <span className="ml-2 text-xs text-muted-foreground">
                                    {t('wheelKeysPage.revealDenied')}
                                  </span>
                                ) : null}
                              </TableCell>
                              {filter === 'claimed' ? (
                                <>
                                  <TableCell className="text-sm">
                                    {key.claimedBy === null ? (
                                      '—'
                                    ) : key.claimedBy.telegramId ? (
                                      <Link
                                        className="underline-offset-2 hover:underline"
                                        to={`/users/${key.claimedBy.telegramId}`}
                                      >
                                        {key.claimedBy.name || key.claimedBy.id}
                                      </Link>
                                    ) : (
                                      key.claimedBy.name || key.claimedBy.id
                                    )}
                                  </TableCell>
                                  <TableCell className="text-sm text-muted-foreground">
                                    {key.claimedAt
                                      ? new Date(key.claimedAt).toLocaleString()
                                      : '—'}
                                  </TableCell>
                                </>
                              ) : (
                                <TableCell className="text-right">
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    aria-label={t('wheelKeysPage.actions.removeKey')}
                                    onClick={() => removeKey.mutate(key.id)}
                                  >
                                    <Trash2 className="h-4 w-4" />
                                  </Button>
                                </TableCell>
                              )}
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    )}
                    {keys.hasNextPage ? (
                      <div className="mt-3 flex justify-center">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={keys.isFetchingNextPage}
                          onClick={() => {
                            void keys.fetchNextPage()
                          }}
                        >
                          {t('wheelKeysPage.loadMore')}
                        </Button>
                      </div>
                    ) : null}
                  </CardContent>
                </Card>
              </>
            )}
          </div>
        </div>
      )}

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('wheelKeysPage.createDialog.title')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="pool-name">{t('wheelKeysPage.createDialog.nameLabel')}</Label>
              <Input
                id="pool-name"
                value={name}
                maxLength={200}
                onChange={(event) => setName(event.target.value)}
                placeholder={t('wheelKeysPage.createDialog.namePlaceholder')}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pool-note">{t('wheelKeysPage.createDialog.noteLabel')}</Label>
              <Input
                id="pool-note"
                value={note}
                maxLength={1000}
                onChange={(event) => setNote(event.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreating(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              disabled={name.trim() === '' || create.isPending}
              onClick={() => create.mutate()}
            >
              {t('wheelKeysPage.actions.newPool')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={loading} onOpenChange={setLoading}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('wheelKeysPage.loadDialog.title')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              {t('wheelKeysPage.loadDialog.description')}
            </p>
            <Textarea
              rows={10}
              className="font-mono text-sm"
              value={paste}
              onChange={(event) => setPaste(event.target.value)}
              placeholder={t('wheelKeysPage.loadDialog.placeholder')}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLoading(false)}>
              {t('common.cancel')}
            </Button>
            <Button disabled={paste.trim() === '' || load.isPending} onClick={() => load.mutate()}>
              {t('wheelKeysPage.actions.load')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={deletingPool !== null}
        onOpenChange={(open) => (open ? undefined : setDeletingPool(null))}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('wheelKeysPage.deleteDialog.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('wheelKeysPage.deleteDialog.description', { name: deletingPool?.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deletingPool !== null) removePool.mutate(deletingPool.id)
              }}
            >
              {t('wheelKeysPage.actions.deletePool')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
