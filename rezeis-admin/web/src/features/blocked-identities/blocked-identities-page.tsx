/**
 * Identity blocklist — the screen for keeping people out before they arrive.
 *
 * ── What makes this different from the IP list beside it ─────────────────
 *
 * PASTE, NOT TYPE. The operator need this exists for is "here is a list of ids
 * to keep out", so the input is a textarea that accepts whatever their source
 * gave them — a spreadsheet column, a comma-joined chat message, a
 * space-separated log line. A single-value field would turn a list of two
 * hundred into two hundred submissions.
 *
 * A PER-ROW REPORT. Three typos in a two-hundred-line paste must not fail as a
 * unit, and the operator has to see WHICH three. The result panel stays on
 * screen after a submit for exactly that, rather than collapsing into a toast
 * that says "some entries were rejected".
 *
 * PROVENANCE IS VISIBLE. `cascade` rows were captured automatically when a user
 * was blocked; `manual` rows somebody typed. Unblocking that user removes only
 * the first kind, so an operator deleting entries needs to know which is which
 * before deciding whether their edit will survive.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Plus, ShieldBan, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { formatDateTime } from '@/lib/utils'
import {
  addBlockedIdentities,
  type AddBlockedIdentitiesResult,
  type BlockedIdentity,
  type BlockedIdentityKind,
  deleteBlockedIdentity,
  listBlockedIdentities,
  splitPastedValues,
} from './blocked-identities-api'

const KEY = ['admin', 'blocked-identities'] as const

/**
 * The kinds an operator may TYPE.
 *
 * The two device kinds are deliberately absent: nobody has a hardware id or a
 * browser fingerprint to hand, they are captured when an account is blocked.
 * Offering them would be offering a field that cannot be filled in.
 */
const TYPEABLE_KINDS: readonly BlockedIdentityKind[] = ['TELEGRAM_ID', 'EMAIL', 'WEB_LOGIN']

interface BlockedIdentitiesPageProps {
  readonly embedded?: boolean
}

export default function BlockedIdentitiesPage({
  embedded = false,
}: BlockedIdentitiesPageProps = {}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { data, isLoading, error } = useQuery({
    queryKey: KEY,
    queryFn: () => listBlockedIdentities(),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteBlockedIdentity(id),
    onSuccess: () => {
      toast.success(t('blockedIdentitiesPage.toast.deleted'))
      queryClient.invalidateQueries({ queryKey: KEY })
    },
    onError: (err) =>
      toast.error(
        t('blockedIdentitiesPage.toast.deleteFailed', { message: (err as Error).message }),
      ),
  })

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        {!embedded ? (
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
              <ShieldBan className="h-6 w-6" />
              {t('blockedIdentitiesPage.title')}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('blockedIdentitiesPage.subtitle')}
            </p>
          </div>
        ) : (
          <div />
        )}
        <AddDialog onAdded={() => queryClient.invalidateQueries({ queryKey: KEY })} />
      </header>

      {error ? (
        <Alert variant="destructive">
          <AlertTitle>{t('common.error')}</AlertTitle>
          <AlertDescription>{t('blockedIdentitiesPage.errors.list')}</AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{t('blockedIdentitiesPage.entriesTitle')}</CardTitle>
          <CardDescription>
            {data
              ? t('blockedIdentitiesPage.entriesSummary', { total: data.items.length })
              : ''}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, idx) => (
                <Skeleton key={idx} className="h-12 w-full" />
              ))}
            </div>
          ) : !data || data.items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-12 text-muted-foreground">
              <ShieldBan className="h-10 w-10 opacity-30" />
              <p>{t('blockedIdentitiesPage.empty')}</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('blockedIdentitiesPage.columns.kind')}</TableHead>
                  <TableHead>{t('blockedIdentitiesPage.columns.value')}</TableHead>
                  <TableHead>{t('blockedIdentitiesPage.columns.source')}</TableHead>
                  <TableHead>{t('blockedIdentitiesPage.columns.reason')}</TableHead>
                  <TableHead>{t('blockedIdentitiesPage.columns.expires')}</TableHead>
                  <TableHead>{t('blockedIdentitiesPage.columns.added')}</TableHead>
                  <TableHead className="w-12 text-right" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((row) => (
                  <Row key={row.id} row={row} onDelete={(id) => deleteMutation.mutate(id)} />
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function Row({ row, onDelete }: { row: BlockedIdentity; onDelete: (id: string) => void }) {
  const { t } = useTranslation()
  // eslint-disable-next-line react-hooks/purity -- display-only expiry check
  const isExpired = row.expiresAt !== null && new Date(row.expiresAt).getTime() < Date.now()
  return (
    <TableRow className={isExpired ? 'opacity-60' : undefined}>
      <TableCell>
        <Badge variant="outline">{t(`blockedIdentitiesPage.kinds.${row.kind}`, row.kind)}</Badge>
      </TableCell>
      <TableCell className="max-w-xs truncate font-mono text-xs" title={row.value}>
        {row.value}
      </TableCell>
      <TableCell>
        {/* `cascade` is muted on purpose: it is the row an unblock will remove
            by itself, so it is not the one an operator should reach for. */}
        <Badge variant={row.source === 'manual' ? 'default' : 'secondary'}>
          {String(t(`blockedIdentitiesPage.sources.${row.source}`, row.source))}
        </Badge>
      </TableCell>
      <TableCell
        className="max-w-md truncate text-xs text-muted-foreground"
        title={row.reason ?? undefined}
      >
        {row.reason ?? '—'}
      </TableCell>
      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
        {row.expiresAt ? formatDateTime(row.expiresAt) : t('blockedIdentitiesPage.permanent')}
        {isExpired ? (
          <Badge variant="outline" className="ml-2 text-[10px]">
            {t('blockedIdentitiesPage.expired')}
          </Badge>
        ) : null}
      </TableCell>
      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
        {formatDateTime(row.createdAt)}
      </TableCell>
      <TableCell className="text-right">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => onDelete(row.id)}
          aria-label={t('blockedIdentitiesPage.deleteAria')}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </TableCell>
    </TableRow>
  )
}

function AddDialog({ onAdded }: { onAdded: () => void }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<BlockedIdentityKind>('TELEGRAM_ID')
  const [pasted, setPasted] = useState('')
  const [reason, setReason] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [result, setResult] = useState<AddBlockedIdentitiesResult | null>(null)

  const values = splitPastedValues(pasted)

  const mutation = useMutation({
    mutationFn: () =>
      addBlockedIdentities({
        kind,
        values,
        reason: reason.trim() || undefined,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
      }),
    onSuccess: (outcome) => {
      // The dialog deliberately STAYS OPEN. Closing it would take the per-row
      // report with it, and the report is the reason a partial paste is
      // reported instead of refused.
      setResult(outcome)
      setPasted('')
      toast.success(t('blockedIdentitiesPage.toast.added', { count: outcome.added }))
      onAdded()
    },
    onError: (err) =>
      toast.error(
        t('blockedIdentitiesPage.toast.addFailed', { message: (err as Error).message }),
      ),
  })

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setResult(null)
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <Plus className="mr-2 h-4 w-4" />
          {t('blockedIdentitiesPage.addEntries')}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('blockedIdentitiesPage.dialog.title')}</DialogTitle>
          <DialogDescription>{t('blockedIdentitiesPage.dialog.description')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="blocklist-kind">
              {t('blockedIdentitiesPage.dialog.kindLabel')}
            </Label>
            <Select value={kind} onValueChange={(next) => setKind(next as BlockedIdentityKind)}>
              <SelectTrigger id="blocklist-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TYPEABLE_KINDS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {t(`blockedIdentitiesPage.kinds.${option}`, option)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="blocklist-values">
              {t('blockedIdentitiesPage.dialog.valuesLabel')}
            </Label>
            <Textarea
              id="blocklist-values"
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              placeholder={t('blockedIdentitiesPage.dialog.valuesPlaceholder')}
              rows={6}
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              {t('blockedIdentitiesPage.dialog.valuesCount', { count: values.length })}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="blocklist-reason">
              {t('blockedIdentitiesPage.dialog.reasonLabel')}
            </Label>
            <Input
              id="blocklist-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('blockedIdentitiesPage.dialog.reasonPlaceholder')}
              maxLength={500}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="blocklist-expires">
              {t('blockedIdentitiesPage.dialog.expiresLabel')}
            </Label>
            <Input
              id="blocklist-expires"
              type="datetime-local"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {t('blockedIdentitiesPage.dialog.expiresHint')}
            </p>
          </div>

          {result !== null ? <AddResult result={result} /> : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            {t('common.close')}
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || values.length === 0}
          >
            {mutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('blockedIdentitiesPage.dialog.submit', { count: values.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * What a paste actually did, row by row.
 *
 * Duplicates are reported as neutral rather than as failures: re-pasting a list
 * that overlaps the previous one is ordinary operator behaviour, and colouring
 * it as an error would teach people that a correct action went wrong.
 */
function AddResult({ result }: { result: AddBlockedIdentitiesResult }) {
  const { t } = useTranslation()
  return (
    <div className="space-y-2 rounded-md border bg-muted/40 p-3 text-xs">
      <p className="font-medium">
        {t('blockedIdentitiesPage.result.added', { count: result.added })}
      </p>
      {result.duplicates.length > 0 ? (
        <p className="text-muted-foreground">
          {t('blockedIdentitiesPage.result.duplicates', { count: result.duplicates.length })}
        </p>
      ) : null}
      {result.rejected.length > 0 ? (
        <div className="space-y-1">
          <p className="text-destructive">
            {t('blockedIdentitiesPage.result.rejected', { count: result.rejected.length })}
          </p>
          <ul className="max-h-32 space-y-0.5 overflow-y-auto font-mono">
            {result.rejected.map((entry) => (
              <li key={`${entry.value}:${entry.reason}`} className="truncate">
                <span className="text-destructive">{entry.value}</span>
                {' — '}
                <span className="text-muted-foreground">
                  {t(`blockedIdentitiesPage.rejections.${entry.reason}`, entry.reason)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
