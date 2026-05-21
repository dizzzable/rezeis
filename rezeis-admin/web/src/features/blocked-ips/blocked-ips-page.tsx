/**
 * Blocked IPs management page.
 *
 * The list shows manual entries alongside ones created by automation
 * rules (`source === 'automation'`). Manual entries can be edited; the
 * automation source is read-only on this surface to make the
 * provenance unambiguous (operators who want to override an automation
 * entry should disable / edit the rule instead).
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
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { formatDateTime } from '@/lib/utils'
import {
  type BlockedIp,
  createBlockedIp,
  deleteBlockedIp,
  listBlockedIps,
} from './blocked-ips-api'

const KEY = ['admin', 'blocked-ips'] as const

interface BlockedIpsPageProps {
  readonly embedded?: boolean
}

export default function BlockedIpsPage({ embedded = false }: BlockedIpsPageProps = {}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { data, isLoading, error } = useQuery({
    queryKey: KEY,
    queryFn: () => listBlockedIps({ limit: 100 }),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteBlockedIp(id),
    onSuccess: () => {
      toast.success(t('blockedIpsPage.toast.deleted'))
      queryClient.invalidateQueries({ queryKey: KEY })
    },
    onError: (err) =>
      toast.error(t('blockedIpsPage.toast.deleteFailed', { message: (err as Error).message })),
  })

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between flex-wrap gap-3">
        {!embedded ? (
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <ShieldBan className="h-6 w-6" />
              {t('blockedIpsPage.title')}
            </h1>
            <p className="text-sm text-muted-foreground mt-1">{t('blockedIpsPage.subtitle')}</p>
          </div>
        ) : (
          <div />
        )}
        <CreateDialog onCreated={() => queryClient.invalidateQueries({ queryKey: KEY })} />
      </header>

      {error ? (
        <Alert variant="destructive">
          <AlertTitle>{t('common.error')}</AlertTitle>
          <AlertDescription>{t('blockedIpsPage.errors.list')}</AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{t('blockedIpsPage.entriesTitle')}</CardTitle>
          <CardDescription>
            {data
              ? t('blockedIpsPage.entriesSummary', {
                  total: data.total,
                  shown: data.items.length,
                })
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
              <p>{t('blockedIpsPage.empty')}</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('blockedIpsPage.columns.address')}</TableHead>
                  <TableHead>{t('blockedIpsPage.columns.source')}</TableHead>
                  <TableHead>{t('blockedIpsPage.columns.reason')}</TableHead>
                  <TableHead>{t('blockedIpsPage.columns.expires')}</TableHead>
                  <TableHead>{t('blockedIpsPage.columns.added')}</TableHead>
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

function Row({ row, onDelete }: { row: BlockedIp; onDelete: (id: string) => void }) {
  const { t } = useTranslation()
  // eslint-disable-next-line react-hooks/purity -- Date.now() is acceptable for display-only expiry check
  const isExpired = row.expiresAt !== null && new Date(row.expiresAt).getTime() < Date.now()
  return (
    <TableRow className={isExpired ? 'opacity-60' : undefined}>
      <TableCell className="font-mono text-xs">{row.address}</TableCell>
      <TableCell>
        <Badge variant={row.source === 'automation' ? 'secondary' : 'default'}>
          {String(t(`blockedIpsPage.sources.${row.source}`, row.source))}
        </Badge>
      </TableCell>
      <TableCell
        className="text-xs text-muted-foreground max-w-md truncate"
        title={row.reason ?? undefined}
      >
        {row.reason ?? '—'}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
        {row.expiresAt ? formatDateTime(row.expiresAt) : t('blockedIpsPage.permanent')}
        {isExpired ? (
          <Badge variant="outline" className="ml-2 text-[10px]">
            {t('blockedIpsPage.expired')}
          </Badge>
        ) : null}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
        {formatDateTime(row.createdAt)}
      </TableCell>
      <TableCell className="text-right">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => onDelete(row.id)}
          aria-label={t('blockedIpsPage.deleteAria')}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </TableCell>
    </TableRow>
  )
}

function CreateDialog({ onCreated }: { onCreated: () => void }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [address, setAddress] = useState('')
  const [reason, setReason] = useState('')
  const [expiresAt, setExpiresAt] = useState('')

  const mutation = useMutation({
    mutationFn: () =>
      createBlockedIp({
        address: address.trim(),
        reason: reason.trim() || undefined,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
      }),
    onSuccess: () => {
      toast.success(t('blockedIpsPage.toast.added'))
      setOpen(false)
      setAddress('')
      setReason('')
      setExpiresAt('')
      onCreated()
    },
    onError: (err) =>
      toast.error(t('blockedIpsPage.toast.createFailed', { message: (err as Error).message })),
  })

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="mr-2 h-4 w-4" />
          {t('blockedIpsPage.addAddress')}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('blockedIpsPage.dialog.title')}</DialogTitle>
          <DialogDescription>{t('blockedIpsPage.dialog.description')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>{t('blockedIpsPage.dialog.addressLabel')}</Label>
            <Input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="1.2.3.4 / 1.2.3.0/24"
              maxLength={64}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t('blockedIpsPage.dialog.reasonLabel')}</Label>
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('blockedIpsPage.dialog.reasonPlaceholder')}
              maxLength={256}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t('blockedIpsPage.dialog.expiresLabel')}</Label>
            <Input
              type="datetime-local"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || address.trim().length === 0}
          >
            {mutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('blockedIpsPage.dialog.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
