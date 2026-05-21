import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Wallet,
  AlertCircle,
  CheckCircle2,
  XCircle,
  Clock,
  Filter,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';

interface Withdrawal {
  id: number;
  partnerId: number;
  amount: number;
  requestedAmount: string | null;
  requestedCurrency: string | null;
  quoteRate: string | null;
  status: string;
  method: string;
  requisites: string;
  adminComment: string | null;
  processedBy: string | null;
  createdAt: string;
  partner: {
    user: { username: string | null; telegramId: string };
  };
}

function statusVariant(status: string): 'default' | 'success' | 'destructive' | 'warning' | 'secondary' {
  if (status === 'COMPLETED') return 'success';
  if (status === 'REJECTED') return 'destructive';
  if (status === 'PENDING') return 'warning';
  return 'secondary';
}

function formatKopecks(kopecks: number): string {
  return `${(kopecks / 100).toFixed(2)} ₽`;
}

interface WithdrawalsPageProps {
  /**
   * When `true`, the outer page-level header (title + subtitle) is hidden
   * so the component can be embedded inside a tab without duplicating
   * headings.
   */
  readonly embedded?: boolean;
}

export default function WithdrawalsPage({ embedded = false }: WithdrawalsPageProps = {}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState('PENDING');
  const [rejectDialog, setRejectDialog] = useState<{ id: number } | null>(null);
  const [rejectComment, setRejectComment] = useState('');

  const { data, isLoading, error } = useQuery({
    queryKey: ['withdrawals', statusFilter],
    queryFn: async () => {
      const params: Record<string, string> = { limit: '100' };
      if (statusFilter && statusFilter !== 'all') params.status = statusFilter;
      const res = await api.get<Withdrawal[] | { items: Withdrawal[]; total: number }>(
        '/admin/partners/withdrawals',
        { params },
      );
      // Backend may return either a raw array or an envelope; normalize.
      const raw = res.data;
      const items = Array.isArray(raw) ? raw : (raw?.items ?? []);
      const total = Array.isArray(raw) ? items.length : (raw?.total ?? items.length);
      return { items, total };
    },
  });

  const approveMutation = useMutation({
    mutationFn: (id: number) => api.post(`/admin/partners/withdrawals/${id}/approve`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['withdrawals'] });
      toast.success(t('withdrawalsPage.approved'));
    },
    onError: () => toast.error(t('withdrawalsPage.approveFailed')),
  });

  const rejectMutation = useMutation({
    mutationFn: ({ id, comment }: { id: number; comment: string }) =>
      api.post(`/admin/partners/withdrawals/${id}/reject`, { comment }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['withdrawals'] });
      setRejectDialog(null);
      setRejectComment('');
      toast.success(t('withdrawalsPage.rejected'));
    },
    onError: () => toast.error(t('withdrawalsPage.rejectFailed')),
  });

  const pendingCount = data?.items.filter((w) => w.status === 'PENDING').length ?? 0;

  if (error)
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>{t('withdrawalsPage.error.title')}</AlertTitle>
        <AlertDescription>{t('withdrawalsPage.error.body')}</AlertDescription>
      </Alert>
    );

  return (
    <div className="space-y-6">
      {!embedded && (
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">{t('withdrawalsPage.title')}</h1>
            <p className="text-muted-foreground">{t('withdrawalsPage.subtitle')}</p>
          </div>
          {pendingCount > 0 && (
            <Badge variant="warning" className="text-sm px-3 py-1">
              <Clock className="h-3.5 w-3.5 mr-1" />
              {t('withdrawalsPage.pendingCount', { count: pendingCount })}
            </Badge>
          )}
        </div>
      )}

      {/* Stats */}
      {data && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Card>
            <CardContent className="pt-4">
              <p className="text-2xl font-bold">{data.total}</p>
              <p className="text-xs text-muted-foreground">{t('withdrawalsPage.stats.total')}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <p className="text-2xl font-bold text-yellow-600">
                {data.items.filter((w) => w.status === 'PENDING').length}
              </p>
              <p className="text-xs text-muted-foreground">{t('withdrawalsPage.stats.pending')}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <p className="text-2xl font-bold text-green-600">
                {formatKopecks(
                  data.items
                    .filter((w) => w.status === 'COMPLETED')
                    .reduce((s, w) => s + w.amount, 0),
                )}
              </p>
              <p className="text-xs text-muted-foreground">{t('withdrawalsPage.stats.paid')}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <p className="text-2xl font-bold text-destructive">
                {data.items.filter((w) => w.status === 'REJECTED').length}
              </p>
              <p className="text-xs text-muted-foreground">{t('withdrawalsPage.stats.rejected')}</p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Filter */}
      <div className="flex items-center gap-3">
        <Filter className="h-4 w-4 text-muted-foreground" />
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('withdrawalsPage.filter.all')}</SelectItem>
            <SelectItem value="PENDING">{t('withdrawalsPage.filter.pending')}</SelectItem>
            <SelectItem value="COMPLETED">{t('withdrawalsPage.filter.completed')}</SelectItem>
            <SelectItem value="REJECTED">{t('withdrawalsPage.filter.rejected')}</SelectItem>
            <SelectItem value="CANCELED">{t('withdrawalsPage.filter.canceled')}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Wallet className="h-5 w-5 text-muted-foreground" />
            <CardTitle>{t('withdrawalsPage.tableTitle')}</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : !data || data.items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-12 text-muted-foreground">
              <Wallet className="h-10 w-10 opacity-30" />
              <p>{t('withdrawalsPage.empty')}</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('withdrawalsPage.columns.partner')}</TableHead>
                  <TableHead>{t('withdrawalsPage.columns.amount')}</TableHead>
                  <TableHead>{t('withdrawalsPage.columns.method')}</TableHead>
                  <TableHead>{t('withdrawalsPage.columns.requisites')}</TableHead>
                  <TableHead>{t('withdrawalsPage.columns.status')}</TableHead>
                  <TableHead>{t('withdrawalsPage.columns.date')}</TableHead>
                  <TableHead>{t('withdrawalsPage.columns.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((w) => (
                  <TableRow key={w.id}>
                    <TableCell className="text-sm">
                      <span className="font-medium">
                        {w.partner?.user?.username ?? `ID ${w.partnerId}`}
                      </span>
                      <br />
                      <span className="text-xs text-muted-foreground font-mono">
                        {w.partner?.user?.telegramId}
                      </span>
                    </TableCell>
                    <TableCell className="font-bold">{formatKopecks(w.amount)}</TableCell>
                    <TableCell className="text-sm">{w.method || '—'}</TableCell>
                    <TableCell className="text-xs font-mono max-w-32 truncate" title={w.requisites}>
                      {w.requisites || '—'}
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(w.status)}>{w.status}</Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDateTime(w.createdAt)}
                    </TableCell>
                    <TableCell>
                      {w.status === 'PENDING' && (
                        <div className="flex gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-green-600 hover:text-green-700"
                            onClick={() => approveMutation.mutate(w.id)}
                            disabled={approveMutation.isPending}
                          >
                            <CheckCircle2 className="h-4 w-4 mr-1" />
                            {t('withdrawalsPage.actions.approve')}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive hover:text-destructive"
                            onClick={() => setRejectDialog({ id: w.id })}
                          >
                            <XCircle className="h-4 w-4 mr-1" />
                            {t('withdrawalsPage.actions.reject')}
                          </Button>
                        </div>
                      )}
                      {w.adminComment && (
                        <p className="text-[10px] text-muted-foreground mt-1 italic">
                          {w.adminComment}
                        </p>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
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
              onClick={() =>
                rejectDialog &&
                rejectMutation.mutate({ id: rejectDialog.id, comment: rejectComment })
              }
              disabled={rejectMutation.isPending}
            >
              {t('withdrawalsPage.reject.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
