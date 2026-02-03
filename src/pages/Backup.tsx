import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Database,
  Plus,
  RotateCcw,
  Trash2,
  Clock,
  Calendar,
  HardDrive,
  Loader2,
  FileArchive,
  Settings,
  ChevronDown,
  ChevronUp,
  AlertTriangle,
} from 'lucide-react';
import { format } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { backupService } from '@/api/backup.service';

/**
 * Format bytes to human readable string
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Backup page component
 */
function Backup(): React.ReactElement {
  const { t } = useTranslation('admin');
  const queryClient = useQueryClient();
  
  // Dialog states
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isRestoreDialogOpen, setIsRestoreDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isConfigOpen, setIsConfigOpen] = useState(false);
  const [selectedBackup, setSelectedBackup] = useState<string | null>(null);
  const [expandedBackups, setExpandedBackups] = useState<Set<string>>(new Set());
  
  // Create backup form state
  const [backupName, setBackupName] = useState('');
  const [backupDescription, setBackupDescription] = useState('');
  const [selectedTables, setSelectedTables] = useState<string[]>([]);
  const [selectAllTables, setSelectAllTables] = useState(true);
  
  // Restore form state
  const [restoreMode, setRestoreMode] = useState<'merge' | 'clear'>('merge');

  // Fetch data
  const { data: backupsData, isLoading: isBackupsLoading } = useQuery({
    queryKey: ['backups'],
    queryFn: () => backupService.getBackups(),
  });

  const { data: tables } = useQuery({
    queryKey: ['backup-tables'],
    queryFn: () => backupService.getTables(),
  });

  const { data: config, isLoading: isConfigLoading } = useQuery({
    queryKey: ['backup-config'],
    queryFn: () => backupService.getConfig(),
  });

  // Toast notification
  const showToast = (title: string, description?: string, isError?: boolean) => {
    // Simple toast using alert for now
    if (isError) {
      console.error(`${title}: ${description}`);
    } else {
      console.log(`${title}: ${description}`);
    }
  };

  // Mutations
  const createBackupMutation = useMutation({
    mutationFn: backupService.createBackup,
    onSuccess: (result) => {
      if (result.success) {
        showToast('Backup Created', `Created ${result.filename} (${formatBytes(result.size || 0)})`);
        queryClient.invalidateQueries({ queryKey: ['backups'] });
        setIsCreateDialogOpen(false);
        resetCreateForm();
      } else {
        showToast('Error', result.message, true);
      }
    },
    onError: (error: Error) => {
      showToast('Error', error.message || 'Failed to create backup', true);
    },
  });

  const restoreBackupMutation = useMutation({
    mutationFn: ({ filename, mode }: { filename: string; mode: 'merge' | 'clear' }) =>
      backupService.restoreBackup(filename, { mode }),
    onSuccess: (result) => {
      if (result.success) {
        showToast('Restore Completed', `Restored ${result.restoredCount} records to ${result.restoredTables?.length} tables`);
        setIsRestoreDialogOpen(false);
        setSelectedBackup(null);
      } else {
        showToast('Error', result.message, true);
      }
    },
    onError: (error: Error) => {
      showToast('Error', error.message || 'Failed to restore backup', true);
    },
  });

  const deleteBackupMutation = useMutation({
    mutationFn: backupService.deleteBackup,
    onSuccess: () => {
      showToast('Backup Deleted', 'Backup removed successfully');
      queryClient.invalidateQueries({ queryKey: ['backups'] });
      setIsDeleteDialogOpen(false);
      setSelectedBackup(null);
    },
    onError: (error: Error) => {
      showToast('Error', error.message || 'Failed to delete backup', true);
    },
  });

  const resetCreateForm = () => {
    setBackupName('');
    setBackupDescription('');
    setSelectedTables([]);
    setSelectAllTables(true);
  };

  const handleCreateBackup = () => {
    createBackupMutation.mutate({
      name: backupName || undefined,
      description: backupDescription || undefined,
      tables: selectAllTables ? undefined : selectedTables,
    });
  };

  const handleRestoreClick = (filename: string) => {
    setSelectedBackup(filename);
    setRestoreMode('merge');
    setIsRestoreDialogOpen(true);
  };

  const handleConfirmRestore = () => {
    if (selectedBackup) {
      restoreBackupMutation.mutate({
        filename: selectedBackup,
        mode: restoreMode,
      });
    }
  };

  const handleDeleteClick = (filename: string) => {
    setSelectedBackup(filename);
    setIsDeleteDialogOpen(true);
  };

  const handleConfirmDelete = () => {
    if (selectedBackup) {
      deleteBackupMutation.mutate(selectedBackup);
    }
  };

  const toggleTableSelection = (table: string) => {
    setSelectedTables((prev) =>
      prev.includes(table) ? prev.filter((t) => t !== table) : [...prev, table]
    );
  };

  const toggleBackupExpand = (filename: string) => {
    setExpandedBackups((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(filename)) {
        newSet.delete(filename);
      } else {
        newSet.add(filename);
      }
      return newSet;
    });
  };

  const backups = backupsData?.backups || [];
  const stats = backupsData?.stats;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t('backup:title')}</h1>
          <p className="text-muted-foreground">
            {t('backup:description')}
          </p>
        </div>
        <Button
          onClick={() => setIsCreateDialogOpen(true)}
          disabled={createBackupMutation.isPending}
        >
          {createBackupMutation.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Plus className="mr-2 h-4 w-4" />
          )}
          {t('backup:create')}
        </Button>
      </div>

      {/* Stats Cards */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t('backup:stats.totalBackups')}</CardTitle>
            <Database className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.totalBackups || 0}</div>
            <p className="text-xs text-muted-foreground">
              {backups.length} {t('backup:availableLocally')}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t('backup:stats.storageUsed')}</CardTitle>
            <HardDrive className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatBytes(stats?.totalSize || 0)}</div>
            <p className="text-xs text-muted-foreground">
              {t('backup:compressedBackups')}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t('backup:stats.latestBackup')}</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {stats?.latestBackup
                ? format(new Date(stats.latestBackup), 'MMM d')
                : t('backup:never')}
            </div>
            <p className="text-xs text-muted-foreground">
              {stats?.latestBackup
                ? format(new Date(stats.latestBackup), 'HH:mm')
                : t('backup:noBackupsYet')}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t('backup:stats.autoBackup')}</CardTitle>
            <Settings className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {config?.enabled ? t('backup:on') : t('backup:off')}
            </div>
            <p className="text-xs text-muted-foreground">
              {config?.enabled
                ? t('backup:scheduleInterval', { hours: config.intervalHours, time: config.time })
                : t('backup:manualOnly')}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Configuration */}
      <Card>
        <CardHeader>
          <div
            className="flex items-center justify-between cursor-pointer"
            onClick={() => setIsConfigOpen(!isConfigOpen)}
          >
            <div>
              <CardTitle>{t('backup:configuration')}</CardTitle>
              <CardDescription>
                {t('backup:viewConfiguration')}
              </CardDescription>
            </div>
            <Button variant="ghost" size="sm">
              {isConfigOpen ? (
                <ChevronUp className="h-4 w-4" />
              ) : (
                <ChevronDown className="h-4 w-4" />
              )}
            </Button>
          </div>
        </CardHeader>
        {isConfigOpen && (
          <CardContent className="space-y-6">
            {isConfigLoading ? (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                <div className="space-y-2">
                  <Label>{t('backup:config.automaticBackups')}</Label>
                  <div className="flex items-center space-x-2">
                    <Switch checked={config?.enabled} disabled />
                    <span className="text-sm text-muted-foreground">
                      {config?.enabled ? t('backup:config.enabled') : t('backup:config.disabled')}
                    </span>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>{t('backup:config.backupInterval')}</Label>
                  <p className="text-sm">{config?.intervalHours} {t('backup:hours')}</p>
                </div>

                <div className="space-y-2">
                  <Label>{t('backup:config.backupTime')}</Label>
                  <p className="text-sm">{config?.time}</p>
                </div>

                <div className="space-y-2">
                  <Label>{t('backup:config.maxBackupsKept')}</Label>
                  <p className="text-sm">{config?.maxKeep} {t('backup:files')}</p>
                </div>

                <div className="space-y-2">
                  <Label>{t('backup:config.compression')}</Label>
                  <p className="text-sm">{config?.compression ? t('backup:config.compressionEnabled') : t('backup:config.compressionDisabled')}</p>
                </div>

                <div className="space-y-2">
                  <Label>{t('backup:config.telegramNotifications')}</Label>
                  <p className="text-sm">{config?.telegramEnabled ? t('backup:config.enabled') : t('backup:config.disabled')}</p>
                </div>

                <div className="space-y-2 md:col-span-2 lg:col-span-3">
                  <Label>{t('backup:config.tablesIncluded')}</Label>
                  <div className="flex flex-wrap gap-2 mt-2">
                    {config?.includeTables.map((table) => (
                      <Badge key={table} variant="secondary">
                        {table}
                      </Badge>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        )}
      </Card>

      {/* Backups List */}
      <Card>
        <CardHeader>
          <CardTitle>{t('backup:backupHistory')}</CardTitle>
          <CardDescription>
            {t('backup:backupHistoryDescription')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isBackupsLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : backups.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Database className="mx-auto h-12 w-12 mb-4 opacity-50" />
              <p>{t('backup:noBackups')}</p>
              <p className="text-sm">{t('backup:createFirstBackup')}</p>
            </div>
          ) : (
            <div className="space-y-4">
              {backups.map((backup) => (
                <div key={backup.filename} className="border rounded-lg overflow-hidden">
                  <div 
                    className="p-4 cursor-pointer hover:bg-muted/50"
                    onClick={() => toggleBackupExpand(backup.filename)}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-4">
                        <FileArchive className="h-8 w-8 text-muted-foreground" />
                        <div>
                          <p className="font-mono text-sm font-medium">
                            {backup.filename}
                          </p>
                          <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <Calendar className="h-3 w-3" />
                            {format(new Date(backup.createdAt), 'MMM d, yyyy HH:mm')}
                            <span>•</span>
                            {formatBytes(backup.size)}
                            {backup.compressed && (
                              <>
                                <span>•</span>
                                <Badge variant="outline" className="text-xs">{t('backup:compressed')}</Badge>
                              </>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button variant="ghost" size="sm">
                          {expandedBackups.has(backup.filename) ? (
                            <ChevronUp className="h-4 w-4" />
                          ) : (
                            <ChevronDown className="h-4 w-4" />
                          )}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleRestoreClick(backup.filename);
                          }}
                          disabled={restoreBackupMutation.isPending}
                          title={t('backup:restore')}
                        >
                          {restoreBackupMutation.isPending && selectedBackup === backup.filename ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <RotateCcw className="h-4 w-4" />
                          )}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteClick(backup.filename);
                          }}
                          disabled={deleteBackupMutation.isPending}
                          title={t('backup:delete')}
                          className="text-destructive hover:text-destructive"
                        >
                          {deleteBackupMutation.isPending && selectedBackup === backup.filename ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Trash2 className="h-4 w-4" />
                          )}
                        </Button>
                      </div>
                    </div>
                  </div>
                  {expandedBackups.has(backup.filename) && (
                    <div className="px-4 pb-4 border-t bg-muted/30">
                      <div className="pt-4 grid gap-4 md:grid-cols-2">
                        <div>
                          <Label className="text-muted-foreground">{t('backup:tables')}</Label>
                          <div className="flex flex-wrap gap-1 mt-1">
                            {backup.tables.length > 0 ? (
                              backup.tables.map((table) => (
                                <Badge key={table} variant="secondary" className="text-xs">
                                  {table}
                                </Badge>
                              ))
                            ) : (
                              <span className="text-sm text-muted-foreground">{t('backup:allTables')}</span>
                            )}
                          </div>
                        </div>
                        <div>
                          <Label className="text-muted-foreground">{t('backup:records')}</Label>
                          <p className="text-sm mt-1">{backup.recordCount.toLocaleString()} {t('backup:recordsCount')}</p>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Create Backup Dialog */}
      <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Create New Backup</DialogTitle>
            <DialogDescription>
              Select tables to backup. Leave empty to backup all tables.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="backup-name">Name (optional)</Label>
              <Input
                id="backup-name"
                placeholder="e.g., before-migration"
                value={backupName}
                onChange={(e) => setBackupName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="backup-desc">Description (optional)</Label>
              <Input
                id="backup-desc"
                placeholder="e.g., Backup before database migration"
                value={backupDescription}
                onChange={(e) => setBackupDescription(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Tables to Backup</Label>
                <div className="flex items-center space-x-2">
                  <input
                    type="checkbox"
                    id="select-all"
                    checked={selectAllTables}
                    onChange={(e) => {
                      setSelectAllTables(e.target.checked);
                      if (e.target.checked) setSelectedTables([]);
                    }}
                    className="rounded border-gray-300"
                  />
                  <Label htmlFor="select-all" className="text-sm font-normal">
                    All tables
                  </Label>
                </div>
              </div>
              {!selectAllTables && (
                <div className="border rounded-md p-3 max-h-48 overflow-y-auto">
                  <div className="grid grid-cols-2 gap-2">
                    {tables?.map((table) => (
                      <div key={table} className="flex items-center space-x-2">
                        <input
                          type="checkbox"
                          id={`table-${table}`}
                          checked={selectedTables.includes(table)}
                          onChange={() => toggleTableSelection(table)}
                          className="rounded border-gray-300"
                        />
                        <Label htmlFor={`table-${table}`} className="text-sm font-normal">
                          {table}
                        </Label>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsCreateDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleCreateBackup}
              disabled={createBackupMutation.isPending || (!selectAllTables && selectedTables.length === 0)}
            >
              {createBackupMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Create Backup
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Restore Dialog */}
      <AlertDialog open={isRestoreDialogOpen} onOpenChange={setIsRestoreDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Restore Database
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-4">
              <p>
                Are you sure you want to restore from{' '}
                <span className="font-mono font-medium">{selectedBackup}</span>?
              </p>
              
              <div className="space-y-2">
                <Label>Restore Mode</Label>
                <div className="flex gap-4">
                  <div className="flex items-center space-x-2">
                    <input
                      type="radio"
                      id="mode-merge"
                      name="restore-mode"
                      value="merge"
                      checked={restoreMode === 'merge'}
                      onChange={() => setRestoreMode('merge')}
                      className="rounded border-gray-300"
                    />
                    <Label htmlFor="mode-merge" className="font-normal">
                      Merge (skip existing)
                    </Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <input
                      type="radio"
                      id="mode-clear"
                      name="restore-mode"
                      value="clear"
                      checked={restoreMode === 'clear'}
                      onChange={() => setRestoreMode('clear')}
                      className="rounded border-gray-300"
                    />
                    <Label htmlFor="mode-clear" className="font-normal text-destructive">
                      Clear (replace all)
                    </Label>
                  </div>
                </div>
              </div>

              {restoreMode === 'clear' && (
                <p className="text-destructive text-sm">
                  <strong>Warning:</strong> Clear mode will delete all existing data before restoring.
                  This action cannot be undone!
                </p>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setSelectedBackup(null)}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmRestore}
              disabled={restoreBackupMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {restoreBackupMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Restoring...
                </>
              ) : (
                'Restore'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Dialog */}
      <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Backup</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete{' '}
              <span className="font-mono font-medium">{selectedBackup}</span>?
              <br />
              <br />
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setSelectedBackup(null)}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDelete}
              disabled={deleteBackupMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteBackupMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Deleting...
                </>
              ) : (
                'Delete'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default Backup;
