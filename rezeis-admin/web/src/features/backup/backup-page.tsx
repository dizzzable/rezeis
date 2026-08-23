import { useState, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';import { Plus, Download, Trash2, AlertCircle, Archive, RefreshCw, Settings, Send, RotateCcw, Loader2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { adminQueryKeys } from '@/lib/admin-query-keys';
import { authStorage } from '@/lib/auth-storage';
import { formatDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { useHasPermission } from '@/features/rbac';
import { getBackupSettings, saveBackupSettings, type BackupSettings } from './backup-api';
import { getBackupSettingsFormKey } from './backup-settings-form-key';
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

/**
 * A restore the server refused because it cannot prove it produced the archive,
 * held so the operator can acknowledge it and re-send.
 *
 * The FILE is kept, not just its name. `AlertDialogAction` closes its dialog on
 * click, which runs `onOpenChange(false)` and clears `uploadFile` — so by the
 * time the refusal comes back the only `File` handle the page had is gone, and
 * "restore anyway" would have had nothing to send.
 */
type ForeignArchivePrompt =
  | { readonly source: 'stored'; readonly filename: string; readonly serverMessage: string }
  | { readonly source: 'upload'; readonly file: File; readonly serverMessage: string };

/** The permission `AdminBackupController.resolveForeignArchiveConsent` demands on top of `backups:run`. */
const FOREIGN_ARCHIVE_PERMISSION = { resource: 'admins', action: 'edit' } as const;

interface StoredRestoreInput {
  readonly filename: string;
  readonly acknowledgeForeignArchive?: boolean;
}

interface UploadRestoreInput {
  readonly file: File;
  readonly acknowledgeForeignArchive?: boolean;
}

/**
 * Recognise the one refusal that has a next step, and pull the server's own
 * explanation out of it.
 *
 * WHY A SUBSTRING AND NOT A CODE. `AdminSafeExceptionFilter` only forwards a
 * machine-readable `code` for members of its `SAFE_PRODUCT_CODES` allowlist
 * (`src/common/filters/admin-safe-exception.filter.ts:41-100`); this refusal is
 * a plain `BadRequestException`, so what arrives is
 * `{ statusCode: 400, errorCode: 'BAD_REQUEST', message: '…' }` and the message
 * is the only thing that distinguishes it from "invalid filename" or "not a
 * gzip backup". The token matched is the field name the message instructs the
 * caller to re-send (`backup.service.ts:427`) — the most stable string in it,
 * and the one that cannot change without this client changing too, since it is
 * also the field name the retry puts on the wire.
 *
 * Verified to survive the filter: none of `SENSITIVE_HTTP_TEXT_PATTERNS`
 * matches this message for any of the seven `ForeignArchiveReason` values, so
 * it is not replaced by the generic 'Request failed'.
 */
function foreignArchiveRefusal(error: unknown): string | null {
  const response = (error as { response?: { status?: number; data?: { message?: unknown } } })?.response;
  if (response?.status !== 400) return null;
  const message = response.data?.message;
  const text = typeof message === 'string' ? message : Array.isArray(message) ? message.join(' ') : '';
  return text.includes('acknowledgeForeignArchive') ? text : null;
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
  const [restoreFilename, setRestoreFilename] = useState<string | null>(null);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [foreignPrompt, setForeignPrompt] = useState<ForeignArchivePrompt | null>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const canViewBackups = useHasPermission('backups', 'view');
  // `backups:run` alone restores anything this deployment stamped. An archive it
  // cannot verify — a migration from another server, or a dump older than
  // provenance stamping — additionally needs this, because such a restore runs
  // arbitrary SQL as the database owner and can mint admin accounts.
  const canAcknowledgeForeignArchive = useHasPermission(
    FOREIGN_ARCHIVE_PERMISSION.resource,
    FOREIGN_ARCHIVE_PERMISSION.action,
  );
  const canCreateBackups = useHasPermission('backups', 'create');
  const canDeleteBackups = useHasPermission('backups', 'delete');
  const canRunBackups = useHasPermission('backups', 'run');
  // Downloading is no longer part of `backups:view`. The archive is an
  // unencrypted dump of the whole database — every customer, every transaction,
  // admin password hashes — so a permission that promises "may see the list"
  // must not also hand it over. Listing stays on `view`; the file needs `export`.
  const canExportBackups = useHasPermission('backups', 'export');

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: adminQueryKeys.backups.all,
    queryFn: fetchBackups,
    enabled: canViewBackups,
    refetchInterval: (query) => {
      const items = query.state.data?.items ?? [];
      const hasProcessing = items.some((b) => Number(b.sizeBytes) === 0 && !b.errorMessage);
      return hasProcessing ? 5000 : false;
    },
  });

  const createMutation = useMutation({
    mutationFn: () => {
      if (!canCreateBackups) throw new Error('Missing backups:create');
      return api.post<BackupRecord>('/admin/backup', { scope });
    },
    onSuccess: () => {
      toast.success(t('backupPage.toasts.started'));
      queryClient.invalidateQueries({ queryKey: adminQueryKeys.backups.all });
    },
    onError: () => toast.error(t('backupPage.toasts.createFailed')),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => {
      if (!canDeleteBackups) throw new Error('Missing backups:delete');
      return api.delete(`/admin/backup/${id}`);
    },
    onSuccess: () => {
      toast.success(t('backupPage.toasts.deleted'));
      queryClient.invalidateQueries({ queryKey: adminQueryKeys.backups.all });
      setDeleteId(null);
    },
    onError: () => toast.error(t('backupPage.toasts.deleteFailed')),
  });

  const restoreMutation = useMutation({
    mutationFn: ({ filename, acknowledgeForeignArchive }: StoredRestoreInput) => {
      if (!canRunBackups) throw new Error('Missing backups:run');
      // JSON body: `@Body('acknowledgeForeignArchive')` accepts the literal
      // `true` here (`isAcknowledged`, admin-backup.controller.ts:182).
      return api.post(
        `/admin/backup/restore/${encodeURIComponent(filename)}`,
        acknowledgeForeignArchive ? { acknowledgeForeignArchive: true } : {},
      );
    },
    onSuccess: () => {
      toast.success(t('backupPage.toasts.restoreStarted'));
      setRestoreFilename(null);
      setForeignPrompt(null);
    },
    onError: (error: unknown, variables) => {
      const refusal = foreignArchiveRefusal(error);
      // Only the FIRST refusal opens the prompt. If the retry that already
      // carried the acknowledgement is refused too, the reason is something
      // else and re-opening the same dialog would loop the operator.
      if (refusal !== null && !variables.acknowledgeForeignArchive) {
        setRestoreFilename(null);
        setForeignPrompt({ source: 'stored', filename: variables.filename, serverMessage: refusal });
        return;
      }
      setForeignPrompt(null);
      toast.error(t('backupPage.toasts.restoreFailed'));
    },
  });

  const uploadRestoreMutation = useMutation({
    mutationFn: ({ file, acknowledgeForeignArchive }: UploadRestoreInput) => {
      if (!canRunBackups) throw new Error('Missing backups:run');
      const form = new FormData();
      form.append('file', file);
      // Multipart: every field arrives as a string, and the backend accepts
      // exactly `'true'` / `'1'` — a bare truthy value is not consent there,
      // which is why the string is spelled out rather than coerced.
      if (acknowledgeForeignArchive) form.append('acknowledgeForeignArchive', 'true');
      return api.post('/admin/backup/restore-upload', form);
    },
    onSuccess: () => {
      toast.success(t('backupPage.toasts.uploadRestoreStarted'));
      queryClient.invalidateQueries({ queryKey: adminQueryKeys.backups.all });
      setUploadFile(null);
      setForeignPrompt(null);
    },
    onError: (error: unknown, variables) => {
      const refusal = foreignArchiveRefusal(error);
      if (refusal !== null && !variables.acknowledgeForeignArchive) {
        setUploadFile(null);
        setForeignPrompt({ source: 'upload', file: variables.file, serverMessage: refusal });
        return;
      }
      setForeignPrompt(null);
      toast.error(t('backupPage.toasts.uploadRestoreFailed'));
    },
  });

  function confirmForeignArchiveRestore(): void {
    if (foreignPrompt === null) return;
    if (foreignPrompt.source === 'stored') {
      restoreMutation.mutate({ filename: foreignPrompt.filename, acknowledgeForeignArchive: true });
      return;
    }
    uploadRestoreMutation.mutate({ file: foreignPrompt.file, acknowledgeForeignArchive: true });
  }

  function onUploadInputChange(e: React.ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0] ?? null;
    // Reset the input so picking the same file again still fires onChange.
    e.target.value = '';
    if (!file) return;
    if (!/\.(sql\.)?gz$/i.test(file.name)) {
      toast.error(t('backupPage.toasts.uploadInvalidFile'));
      return;
    }
    setUploadFile(file);
  }

  async function downloadBackup(filename: string): Promise<void> {
    try {
      const token = authStorage.getToken();
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

  if (!canViewBackups)
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('backupPage.accessDeniedTitle')}</CardTitle>
          <CardDescription>{t('backupPage.accessDeniedDescription')}</CardDescription>
        </CardHeader>
      </Card>
    );

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
          {canCreateBackups ? (
            <Select value={scope} onValueChange={(v) => setScope(v as 'DB' | 'FULL')}>
              <SelectTrigger className="w-28" aria-label={t('backupPage.table.columns.scope')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="DB">{t('backupPage.dbOnly')}</SelectItem>
                <SelectItem value="FULL">{t('backupPage.full')}</SelectItem>
              </SelectContent>
            </Select>
          ) : null}
          <Button
            variant="outline"
            size="icon"
            onClick={() => refetch()}
            disabled={isFetching}
            aria-label={t('backupPage.refresh')}
          >
            <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
          </Button>
          {canCreateBackups ? (
            <Button onClick={() => createMutation.mutate()} disabled={createMutation.isPending}>
              <Plus className="mr-2 h-4 w-4" />
              {createMutation.isPending ? t('backupPage.creating') : t('backupPage.createBackup')}
            </Button>
          ) : null}
          {canRunBackups ? (
            <>
              <input
                ref={uploadInputRef}
                type="file"
                accept=".gz,.sql.gz,application/gzip"
                className="hidden"
                onChange={onUploadInputChange}
              />
              <Button
                variant="outline"
                onClick={() => uploadInputRef.current?.click()}
                disabled={uploadRestoreMutation.isPending}
              >
                {uploadRestoreMutation.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Upload className="mr-2 h-4 w-4" />
                )}
                {t('backupPage.restoreUpload')}
              </Button>
            </>
          ) : null}
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

      {/* Settings */}
      <BackupSettings />

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
                      {b.deliveryChannel === 'telegram' || b.deliveryChannel === 'telegram-relay' ? (
                        <span className="text-blue-500">{t('backupPage.delivery.telegram')}</span>
                      ) : b.deliveryChannel === 'uploaded' ? (
                        t('backupPage.delivery.uploaded')
                      ) : b.deliveryChannel === 'local' ? (
                        t('backupPage.delivery.local')
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDateTime(b.createdAt)}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        {canExportBackups ? (
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
                        ) : null}
                        {canRunBackups ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            title={t('backupPage.restore')}
                            aria-label={t('backupPage.restore')}
                            onClick={() => setRestoreFilename(b.filename)}
                            disabled={Number(b.sizeBytes) === 0 || !!b.errorMessage}
                          >
                            <RotateCcw className="h-4 w-4" />
                          </Button>
                        ) : null}
                        {canDeleteBackups ? (
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
                        ) : null}
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

      {/* Restore confirmation */}
      <AlertDialog open={!!restoreFilename} onOpenChange={(v) => !v && setRestoreFilename(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('backupPage.restoreDialog.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('backupPage.restoreDialog.description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('backupPage.restoreDialog.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => restoreFilename && restoreMutation.mutate({ filename: restoreFilename })}
            >
              {t('backupPage.restoreDialog.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Upload-and-restore confirmation */}
      <AlertDialog open={!!uploadFile} onOpenChange={(v) => !v && setUploadFile(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('backupPage.uploadRestoreDialog.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('backupPage.uploadRestoreDialog.description', { filename: uploadFile?.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('backupPage.uploadRestoreDialog.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => uploadFile && uploadRestoreMutation.mutate({ file: uploadFile })}
            >
              {t('backupPage.uploadRestoreDialog.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Foreign-archive acknowledgement.
          ─────────────────────────────────
          The backend refuses an archive it cannot prove it produced and tells
          the caller, in prose, to re-send with `"acknowledgeForeignArchive":
          true`. Until this dialog existed the panel had no way to send that
          field at all — `grep acknowledgeForeignArchive web/src/` returned
          nothing — so a server migration or a rebuild from an off-site dump,
          the two moments a restore matters most, ended at an error telling the
          operator to hand-craft an HTTP request.

          It is a SEPARATE, second confirmation on purpose. A silent retry would
          turn "this file is not yours" into a formality, and this restore pipes
          the archive into `psql` as the database owner: whatever SQL it holds
          runs, including rows in `admin_users`. */}
      <AlertDialog open={foreignPrompt !== null} onOpenChange={(v) => !v && setForeignPrompt(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('backupPage.foreignArchiveDialog.title')}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>{t('backupPage.foreignArchiveDialog.intro')}</p>
                {foreignPrompt ? (
                  <p
                    className="rounded-md bg-muted p-2 font-mono text-[11px] leading-relaxed text-muted-foreground"
                    data-foreign-archive-server-message
                  >
                    {foreignPrompt.serverMessage}
                  </p>
                ) : null}
                <p className="font-medium text-destructive">
                  {t('backupPage.foreignArchiveDialog.consequence')}
                </p>
                <p>{t('backupPage.foreignArchiveDialog.legitimate')}</p>
                {canAcknowledgeForeignArchive && foreignPrompt?.source === 'upload' ? (
                  <p>
                    {t('backupPage.foreignArchiveDialog.reuploadNote', {
                      filename: foreignPrompt.file.name,
                    })}
                  </p>
                ) : null}
                {!canAcknowledgeForeignArchive ? (
                  <p className="font-medium">
                    {t('backupPage.foreignArchiveDialog.needsPermission')}
                  </p>
                ) : null}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('backupPage.foreignArchiveDialog.cancel')}</AlertDialogCancel>
            {/* Gated, not merely disabled: without `admins:edit` the backend
                answers 403 — and on the upload path it does so AFTER multer has
                written the whole file, leaving it on disk with no BackupRecord
                and no way to reach it from the panel. Not offering the button
                is what keeps the panel off that path. */}
            {canAcknowledgeForeignArchive ? (
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={confirmForeignArchiveRestore}
              >
                {t('backupPage.foreignArchiveDialog.confirm')}
              </AlertDialogAction>
            ) : null}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ── Backup Settings Sub-component ───────────────────────────────────────────

interface BackupSettingsData {
  autoEnabled: boolean;
  intervalHours: number;
  maxKeep: number;
  telegramEnabled: boolean;
  telegramChatId: string;
  telegramTopicId: string;
}

const DEFAULT_BACKUP_SETTINGS: BackupSettingsData = {
  autoEnabled: true,
  intervalHours: 24,
  maxKeep: 7,
  telegramEnabled: false,
  telegramChatId: '',
  telegramTopicId: '',
};

function toBackupSettingsData(data: BackupSettings | undefined): BackupSettingsData {
  if (!data) return DEFAULT_BACKUP_SETTINGS;

  return {
    autoEnabled: data.autoEnabled,
    intervalHours: data.intervalHours,
    maxKeep: data.maxKeep,
    telegramEnabled: data.telegram.enabled,
    telegramChatId: data.telegram.chatId ?? '',
    telegramTopicId: data.telegram.topicId != null ? String(data.telegram.topicId) : '',
  };
}

function BackupSettings() {
  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'backup', 'settings'],
    queryFn: getBackupSettings,
  });

  return (
    <BackupSettingsForm
      key={getBackupSettingsFormKey(data)}
      initialSettings={toBackupSettingsData(data)}
      hasData={data !== undefined}
      isLoading={isLoading}
      botTokenConfigured={data?.botTokenConfigured ?? false}
    />
  );
}

function BackupSettingsForm({
  initialSettings,
  hasData,
  isLoading,
  botTokenConfigured,
}: {
  initialSettings: BackupSettingsData;
  hasData: boolean;
  isLoading: boolean;
  botTokenConfigured: boolean;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const canEdit = useHasPermission('backups', 'create');
  const [settings, setSettings] = useState<BackupSettingsData>(initialSettings);

  const saveMutation = useMutation({
    mutationFn: () =>
      saveBackupSettings({
        autoEnabled: settings.autoEnabled,
        intervalHours: settings.intervalHours,
        maxKeep: settings.maxKeep,
        telegram: {
          enabled: settings.telegramEnabled,
          chatId: settings.telegramChatId.trim() || null,
          topicId: settings.telegramTopicId.trim() || null,
        },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'backup', 'settings'] })
      toast.success(t('backupPage.settings.saved'))
    },
    onError: () => toast.error(t('backupPage.settings.saveFailed')),
  })

  const showTokenWarning =
    settings.telegramEnabled && hasData && !botTokenConfigured

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Settings className="h-5 w-5 text-muted-foreground" />
          <CardTitle>{t('backupPage.settings.title')}</CardTitle>
        </div>
        <CardDescription>{t('backupPage.settings.subtitle')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Auto-backup */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-sm font-medium">{t('backupPage.settings.autoBackup')}</Label>
              <p className="text-xs text-muted-foreground">{t('backupPage.settings.autoBackupDesc')}</p>
            </div>
            <Switch
              checked={settings.autoEnabled}
              disabled={!canEdit || isLoading}
              onCheckedChange={(v) => setSettings((s) => ({ ...s, autoEnabled: v }))}
              aria-label={t('backupPage.settings.autoBackup')}
            />
          </div>

          {settings.autoEnabled && (
            <div className="grid grid-cols-2 gap-4 pl-4 border-l-2 border-muted">
              <div className="space-y-1">
                <Label className="text-xs">{t('backupPage.settings.interval')}</Label>
                <Input
                  type="number"
                  min={1}
                  max={168}
                  value={settings.intervalHours}
                  disabled={!canEdit || isLoading}
                  onChange={(e) => setSettings((s) => ({ ...s, intervalHours: Number(e.target.value) }))}
                  className="h-8"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">{t('backupPage.settings.retention')}</Label>
                <Input
                  type="number"
                  min={1}
                  max={100}
                  value={settings.maxKeep}
                  disabled={!canEdit || isLoading}
                  onChange={(e) => setSettings((s) => ({ ...s, maxKeep: Number(e.target.value) }))}
                  className="h-8"
                />
              </div>
            </div>
          )}
        </div>

        <Separator />

        {/* Telegram delivery */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-sm font-medium">{t('backupPage.settings.telegramDelivery')}</Label>
              <p className="text-xs text-muted-foreground">{t('backupPage.settings.telegramDeliveryDesc')}</p>
            </div>
            <Switch
              checked={settings.telegramEnabled}
              disabled={!canEdit || isLoading}
              onCheckedChange={(v) => setSettings((s) => ({ ...s, telegramEnabled: v }))}
              aria-label={t('backupPage.settings.telegramDelivery')}
            />
          </div>

          {settings.telegramEnabled && (
            <div className="space-y-3 pl-4 border-l-2 border-muted">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <Label className="text-xs">{t('backupPage.settings.chatId')}</Label>
                  <Input
                    value={settings.telegramChatId}
                    disabled={!canEdit || isLoading}
                    onChange={(e) => setSettings((s) => ({ ...s, telegramChatId: e.target.value }))}
                    placeholder="-100123456789"
                    className="h-8 font-mono text-xs"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">{t('backupPage.settings.topicId')}</Label>
                  <Input
                    value={settings.telegramTopicId}
                    disabled={!canEdit || isLoading}
                    onChange={(e) => setSettings((s) => ({ ...s, telegramTopicId: e.target.value }))}
                    placeholder={t('backupPage.settings.topicIdPlaceholder')}
                    className="h-8 font-mono text-xs"
                  />
                </div>
              </div>
              {showTokenWarning && (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertTitle>{t('backupPage.settings.noTokenTitle')}</AlertTitle>
                  <AlertDescription>{t('backupPage.settings.noTokenDesc')}</AlertDescription>
                </Alert>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-end">
          <Button
            variant="outline"
            size="sm"
            disabled={!canEdit || isLoading || saveMutation.isPending}
            onClick={() => saveMutation.mutate()}
          >
            {saveMutation.isPending ? (
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="mr-2 h-3.5 w-3.5" />
            )}
            {t('backupPage.settings.save')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
