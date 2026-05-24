import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Filter,
  Search,
  ShieldCheck,
  Wallet,
  XCircle,
} from 'lucide-react'
import { toast } from 'sonner'

import { formatDateTime } from '@/lib/utils'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { FadeIn } from '@/lib/motion'

import { formatKopecks, formatKopecksCompact } from './partner-formatters'
import {
  PARTNER_WITHDRAWAL_STATUSES,
  PartnerWithdrawal,
  PartnerWithdrawalStatus,
} from './partners-api'
import {
  usePartnerMutations,
  usePartnerStats,
  useWithdrawalsList,
} from './partners-queries'

type StatusFilter = PartnerWithdrawalStatus | 'all'

function variantForStatus(
  status: PartnerWithdrawalStatus,
): 'success' | 'destructive' | 'warning' | 'secondary' {
  if (status === 'COMPLETED') return 'success'
  if (status === 'REJECTED') return 'destructive'
  if (status === 'PENDING') return 'warning'
  return 'secondary'
}

export default function PartnersWithdrawalsTab() {
  const { t } = useTranslation()
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('PENDING')
  const [search, setSearch] = useState('')
  const [selectedIds, setSelectedIds] = useState<readonly string[]>([])
  const [rejectDialog, setRejectDialog] = useState<PartnerWithdrawal | null>(null)
  const [rejectComment, setRejectComment] = useState('')
  const [bulkComment, setBulkComment] = useState('')
  const [bulkDialogOpen, setBulkDialogOpen] = useState(false)

  const { data, isLoading, error } = useWithdrawalsList({
    status: statusFilter,
    search: search.trim() || undefined,
  })
  const { data: stats } = usePartnerStats()
  const { approveWithdrawal, rejectWithdrawal, bulkApprove } = usePartnerMutations()

  const visibleSelectable = useMemo(() => (data ?? []).filter((w) => w.status === 'PENDING'), [data])
  const allChecked = visibleSelectable.length > 0 && selectedIds.length === visibleSelectable.length
  const someChecked = selectedIds.length > 0 && selectedIds.length < visibleSelectable.length

  function toggleSelect(id: string) {
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((x) => x !== id) : [...current, id],
    )
  }

  function toggleAll() {
    setSelectedIds(allChecked ? [] : visibleSelectable.map((w) => w.id))
  }

  function handleApprove(withdrawalId: string) {
    approveWithdrawal.mutate(
      { withdrawalId },
      {
        onSuccess: () => toast.success(t('withdrawalsPage.approved')),
        onError: () => toast.error(t('withdrawalsPage.approveFailed')),
      },
    )
  }

  function handleReject() {
    if (!rejectDialog) return
    rejectWithdrawal.mutate(
      { withdrawalId: rejectDialog.id, adminComment: rejectComment || undefined },
      {
        onSuccess: () => {
          toast.success(t('withdrawalsPage.rejected'))
          setRejectDialog(null)
          setRejectComment('')
        },
        onError: () => toast.error(t('withdrawalsPage.rejectFailed')),
      },
    )
  }

  function handleBulkApprove() {
    if (selectedIds.length === 0) return
    bulkApprove.mutate(
      { withdrawalIds: selectedIds, adminComment: bulkComment || undefined },
      {
        onSuccess: (result) => {
          if (result.failed === 0) {
            toast.success(
              t('withdrawalsPage.bulk.success', { count: result.approved }),
            )
          } else {
            toast.warning(
              t('withdrawalsPage.bulk.partial', {
                approved: result.approved,
                failed: result.failed,
              }),
            )
          }
          setBulkDialogOpen(false)
          setBulkComment('')
          setSelectedIds([])
        },
        onError: () => toast.error(t('withdrawalsPage.approveFailed')),
      },
    )
  }

  // keep enum reference live so bundler keeps it
  void PARTNER_WITHDRAWAL_STATUSES

  if (error) {
    return (
      <Alert variant="destructive" className="mt-4">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>{t('withdrawalsPage.error.title')}</AlertTitle>
        <AlertDescription>{t('withdrawalsPage.error.body')}</AlertDescription>
      </Alert>
    )
  }

  return (
    <FadeIn className="space-y-4 mt-4">
      {/* Quick stats from /admin/partners/stats */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Card>
            <CardContent className="pt-4">
              <p className="text-2xl font-bold tabular-nums text-yellow-500">
                {stats.pendingWithdrawals}
              </p>
              <p className="text-[11px] text-muted-foreground uppercase">
                {t('withdrawalsPage.stats.pending')}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <p className="text-2xl font-bold tabular-nums text-emerald-500">
                {stats.completedWithdrawals}
              </p>
              <p className="text-[11px] text-muted-foreground uppercase">
                {t('withdrawalsPage.stats.completed')}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <p className="text-2xl font-bold tabular-nums text-destructive">
                {stats.rejectedWithdrawals}
              </p>
              <p className="text-[11px] text-muted-foreground uppercase">
                {t('withdrawalsPage.stats.rejected')}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <p className="text-2xl font-bold tabular-nums">
                {formatKopecksCompact(stats.totalWithdrawn)}
              </p>
              <p className="text-[11px] text-muted-foreground uppercase">
                {t('withdrawalsPage.stats.paid')}
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Toolbar */}
      <Card>
        <CardContent className="pt-4">
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder={t('withdrawalsPage.searchPlaceholder')}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="pl-9"
                aria-label={t('withdrawalsPage.searchAria')}
              />
            </div>
            <Select
              value={statusFilter}
              onValueChange={(value) => setStatusFilter(value as StatusFilter)}
            >
              <SelectTrigger className="w-44" aria-label={t('withdrawalsPage.filter.aria')}>
                <Filter className="h-3.5 w-3.5 mr-2" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('withdrawalsPage.filter.all')}</SelectItem>
                <SelectItem value="PENDING">{t('withdrawalsPage.filter.pending')}</SelectItem>
                <SelectItem value="COMPLETED">
                  {t('withdrawalsPage.filter.completed')}
                </SelectItem>
                <SelectItem value="REJECTED">{t('withdrawalsPage.filter.rejected')}</SelectItem>
                <SelectItem value="CANCELED">{t('withdrawalsPage.filter.canceled')}</SelectItem>
              </SelectContent>
            </Select>
            {selectedIds.length > 0 && (
              <Button
                size="sm"
                onClick={() => setBulkDialogOpen(true)}
                disabled={bulkApprove.isPending}
              >
                <ShieldCheck className="h-3.5 w-3.5 mr-2" />
                {t('withdrawalsPage.bulk.button', { count: selectedIds.length })}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : !data || data.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-12 text-muted-foreground">
              <Wallet className="h-10 w-10 opacity-30" />
              <p>{t('withdrawalsPage.empty')}</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-9">
                    <Checkbox
                      checked={allChecked ? true : someChecked ? 'indeterminate' : false}
                      onCheckedChange={toggleAll}
                      aria-label={t('withdrawalsPage.selectAllAria')}
                    />
                  </TableHead>
                  <TableHead>{t('withdrawalsPage.columns.partner')}</TableHead>
                  <TableHead className="text-right">
                    {t('withdrawalsPage.columns.amount')}
                  </TableHead>
                  <TableHead>{t('withdrawalsPage.columns.method')}</TableHead>
                  <TableHead>{t('withdrawalsPage.columns.requisites')}</TableHead>
                  <TableHead>{t('withdrawalsPage.columns.status')}</TableHead>
                  <TableHead>
                    <Clock className="h-3.5 w-3.5 inline" />{' '}
                    {t('withdrawalsPage.columns.date')}
                  </TableHead>
                  <TableHead>{t('withdrawalsPage.columns.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.map((row) => {
                  const partnerName =
                    row.partner?.user?.name ??
                    row.partner?.user?.username ??
                    `partner ${row.partnerId.slice(0, 8)}`
                  return (
                    <TableRow key={row.id}>
                      <TableCell>
                        {row.status === 'PENDING' ? (
                          <Checkbox
                            checked={selectedIds.includes(row.id)}
                            onCheckedChange={() => toggleSelect(row.id)}
                            aria-label={t('withdrawalsPage.selectRowAria')}
                          />
                        ) : null}
                      </TableCell>
                      <TableCell className="text-sm">
                        <p className="font-medium leading-tight">{partnerName}</p>
                        <p className="text-[10px] text-muted-foreground font-mono">
                          {row.partner?.user?.telegramId ?? '—'}
                        </p>
                      </TableCell>
                      <TableCell className="text-right font-mono font-semibold">
                        {formatKopecks(row.amount)}
                      </TableCell>
                      <TableCell className="text-xs">{row.method || '—'}</TableCell>
                      <TableCell
                        className="text-[11px] font-mono max-w-32 truncate"
                        title={row.requisites}
                      >
                        {row.requisites || '—'}
                      </TableCell>
                      <TableCell>
                        <Badge variant={variantForStatus(row.status)}>
                          {t(`withdrawalsPage.statuses.${row.status}`)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-[11px] text-muted-foreground">
                        {formatDateTime(row.createdAt)}
                      </TableCell>
                      <TableCell>
                        {row.status === 'PENDING' ? (
                          <div className="flex gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-emerald-600 hover:text-emerald-700"
                              onClick={() => handleApprove(row.id)}
                              disabled={approveWithdrawal.isPending}
                            >
                              <CheckCircle2 className="h-4 w-4 mr-1" />
                              {t('withdrawalsPage.actions.approve')}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-destructive hover:text-destructive"
                              onClick={() => setRejectDialog(row)}
                            >
                              <XCircle className="h-4 w-4 mr-1" />
                              {t('withdrawalsPage.actions.reject')}
                            </Button>
                          </div>
                        ) : row.adminComment ? (
                          <p
                            className="text-[10px] italic text-muted-foreground max-w-32 truncate"
                            title={row.adminComment}
                          >
                            {row.adminComment}
                          </p>
                        ) : (
                          <span className="text-[10px] text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Reject dialog */}
      <Dialog open={!!rejectDialog} onOpenChange={(v) => !v && setRejectDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('withdrawalsPage.reject.title')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Label>{t('withdrawalsPage.reject.reasonLabel')}</Label>
            <Textarea
              placeholder={t('withdrawalsPage.reject.reasonPlaceholder')}
              value={rejectComment}
              onChange={(e) => setRejectComment(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectDialog(null)}>
              {t('withdrawalsPage.reject.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={handleReject}
              disabled={rejectWithdrawal.isPending}
            >
              {t('withdrawalsPage.reject.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk approve dialog */}
      <Dialog open={bulkDialogOpen} onOpenChange={setBulkDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t('withdrawalsPage.bulk.dialogTitle', { count: selectedIds.length })}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {t('withdrawalsPage.bulk.description')}
            </p>
            <Label>{t('withdrawalsPage.bulk.commentLabel')}</Label>
            <Textarea
              placeholder={t('withdrawalsPage.bulk.commentPlaceholder')}
              value={bulkComment}
              onChange={(e) => setBulkComment(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkDialogOpen(false)}>
              {t('withdrawalsPage.bulk.cancel')}
            </Button>
            <Button onClick={handleBulkApprove} disabled={bulkApprove.isPending}>
              <ShieldCheck className="h-3.5 w-3.5 mr-2" />
              {t('withdrawalsPage.bulk.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </FadeIn>
  )
}
