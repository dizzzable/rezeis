import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Plus, Download, Trash2, AlertCircle, Archive, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

interface BackupRecord {
  id: string;
  filename: string;
  scope: string;
  sizeBytes: string | number;
  checksum: string | null;
  deliveryChannel: string | null;
  deliveryRecipient: string | null;
  deliveredAt: string | null;
  errorMessage: string | null;
  createdAt: string;
}

interface BackupListResponse {
  items: BackupRecord[];
  total: number;
  limit: number;
  offset: number;
}

async function fetchBackups(): Promise<BackupListResponse> {
  const res = await api.get<BackupListResponse>('/admin/backup', { params: { limit: 50 } });
  return res.data;
}

function formatBytes(bytes: string | number): string {
  const n = Number(bytes);
  if (!n) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function BackupStatusBadge({ record }: { record: BackupRecord }) {
  const { t } = useTranslation();
  if (record.errorMessage) {
    return <Badge variant="destructive">{t('backupBadges.failed')}</Badge>;
  }
  if (Number(record.sizeBytes) > 0 && record.deliveredAt) {
    return <Badge variant="success">{t('backupBadges.ready')}</Badge>;
  }
  if (Number(record.sizeBytes) === 0) {
    return <Badge variant="warning" className="animate-pulse">{t('backupBadges.processing')}</Badge>;
  }
  return <Badge variant="secondary">{t('backupBadges.pending')}</Badge>;
}

export default function BackupPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [scope, setScope] = useState<'DB' | 'FULL'>('DB');
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['backups'],
    queryFn: fetchBackups,
    refetchInterval: (query) => {
      // Auto-refresh if any backup is processing
      const items = query.state.data?.items ?? [];
      const hasProcessing = items.some((b) => Number(b.sizeBytes) === 0 && !b.errorMessage);
      return hasProcessing ? 5000 : false;
    },
  });

  const createMutation = useMutation({
    mutationFn: () => api.post<BackupRecord>('/admin/backup', { scope }),
    onSuccess: () => {
      toast.success(t('backupPage.toasts.started'));
      queryClient.invalidateQueries({ queryKey: ['backups'] });
    },
    onError: () => toast.error(t('backupPage.toasts.createFailed')),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/backup/${id}`),
    onSuccess: () => {
      toast.success(t('backupPage.toasts.deleted'));
      queryClient.invalidateQueries({ queryKey: ['backups'] });
      setDeleteId(null);
    },
    onError: () => toast.error(t('backupPage.toasts.deleteFailed')),
  });

  async function downloadBackup(filename: string): Promise<void> {
    try {
      const token = localStorage.getItem('rezeis_admin_token') ?? '';
      const response = await fetch(`/api/admin/backup/download/${encodeURIComponent(filename)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        toast.error(t('backupPage.toasts.downloadNotFound'));
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(t('backupPage.toasts.downloadStarted'));
    } catch {
      toast.error(t('backupPage.toasts.downloadError'));
    }
  }

  if (error)
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>{t('backupPage.error')}</AlertTitle>
        <AlertDescription>{t('backupPage.errorDescription')}</AlertDescription>
      </Alert>
    );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t('backupPage.title')}</h1>
          <p className="text-muted-foreground">{t('backupPage.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={scope} onValueChange={(v) => setScope(v as 'DB' | 'FULL')}>
            <SelectTrigger className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="DB">{t('backupPage.dbOnly')}</SelectItem>
              <SelectItem value="FULL">{t('backupPage.full')}</SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="icon"
            onClick={() => refetch()}
            disabled={isFetching}
            aria-label={t('backupPage.refresh')}
          >
            <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
          </Button>
          <Button onClick={() => createMutation.mutate()} disabled={createMutation.isPending}>
            <Plus className="mr-2 h-4 w-4" />
            {createMutation.isPending ? t('backupPage.creating') : t('backupPage.createBackup')}
          </Button>
        </div>
      </div>

      {/* Stats */}
      {data && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Card>
            <CardContent className="pt-4">
              <p className="text-2xl font-bold">{data.total}</p>
              <p className="text-xs text-muted-foreground">{t('backupPage.stats.total')}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <p className="text-2xl font-bold text-green-600">
                {data.items.filter((b) => Number(b.sizeBytes) > 0 && !b.errorMessage).length}
              </p>
              <p className="text-xs text-muted-foreground">{t('backupPage.stats.ready')}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <p className="text-2xl font-bold text-yellow-600">
                {data.items.filter((b) => Number(b.sizeBytes) === 0 && !b.errorMessage).length}
              </p>
              <p className="text-xs text-muted-foreground">{t('backupPage.stats.processing')}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <p className="text-2xl font-bold text-destructive">
                {data.items.filter((b) => b.errorMessage).length}
              </p>
              <p className="text-xs text-muted-foreground">{t('backupPage.stats.failed')}</p>
            </CardContent>
          </Card>
        </div>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Archive className="h-5 w-5 text-muted-foreground" />
            <CardTitle>{t('backupPage.table.title')}</CardTitle>
          </div>
          <CardDescription>{data ? t('backupPage.table.count', { count: data.total }) : ''}</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : !data || data.items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-12 text-muted-foreground">
              <Archive className="h-10 w-10 opacity-30" />
              <p>{t('backupPage.table.empty')}</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('backupPage.table.columns.filename')}</TableHead>
                  <TableHead>{t('backupPage.table.columns.scope')}</TableHead>
                  <TableHead>{t('backupPage.table.columns.size')}</TableHead>
                  <TableHead>{t('backupPage.table.columns.status')}</TableHead>
                  <TableHead>{t('backupPage.table.columns.delivery')}</TableHead>
                  <TableHead>{t('backupPage.table.columns.created')}</TableHead>
                  <TableHead>{t('backupPage.table.columns.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((b) => (
                  <TableRow key={b.id}>
                    <TableCell className="font-mono text-xs max-w-48 truncate" title={b.filename}>
                      {b.filename}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{b.scope}</Badge>
                    </TableCell>
                    <TableCell className="text-sm">{formatBytes(b.sizeBytes)}</TableCell>
                    <TableCell>
                      <BackupStatusBadge record={b} />
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {b.deliveryChannel === 'telegram' ? (
                        <span className="text-blue-500">Telegram ✓</span>
                      ) : b.deliveryChannel === 'local' ? (
                        'Local'
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDateTime(b.createdAt)}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          title={t('backupBadges.download')}
                          aria-label={t('backupBadges.download')}
                          onClick={() => downloadBackup(b.filename)}
                          disabled={Number(b.sizeBytes) === 0}
                        >
                          <Download className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title={t('backupBadges.delete')}
                          aria-label={t('backupBadges.delete')}
                          className="text-destructive hover:text-destructive"
                          onClick={() => setDeleteId(b.id)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteId} onOpenChange={(v) => !v && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('backupPage.deleteDialog.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('backupPage.deleteDialog.description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('backupPage.deleteDialog.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteId && deleteMutation.mutate(deleteId)}
            >
              {t('backupPage.deleteDialog.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
