/**
 * Imports page — tabbed interface for importing users from multiple sources.
 *
 *   • Remnawave — live API pull (one-button import / sync)
 *   • 3x-ui    — file upload (.db SQLite or .json)
 *   • Remnashop — file upload (.tar.gz or .json)
 *   • Altshop   — file upload (.tar.gz or .json)
 *
 * Architecture (v0.3.8+):
 *   The four tabs all share `useImportFlow()` which:
 *     1. Calls the backend enqueue endpoint and gets back { importRecordId }.
 *     2. Opens <ImportProgressDialog> immediately so the operator sees
 *        a stage animation + spinner.
 *     3. The dialog polls GET /admin/imports/:id every second, switches
 *        to a stats screen on terminal status, and offers "Assign plan
 *        to all" → <BulkAssignPlanDialog> for `mode === 'import'`.
 *   The history table at the bottom shows all import records across
 *   sources, refreshed when the dialog closes.
 */
import { useCallback, useRef, useState, type JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Database,
  Download,
  FileUp,
  Loader2,
  RefreshCw,
  Upload,
} from 'lucide-react'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { adminQueryKeys } from '@/lib/admin-query-keys'
import { formatDateTime } from '@/lib/utils'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs'
import { FadeIn, HoverLift } from '@/lib/motion'
import { RemnawaveIcon } from '@/features/remnawave/remnawave-icon'
import { RemnashopIcon } from './remnashop-icon'
import { useHasPermission } from '@/features/rbac'

import {
  ImportProgressDialog,
  type ImportSource,
  type ImportMode,
} from './import-progress-dialog'
import { BulkAssignPlanDialog } from './bulk-assign-plan-dialog'
import { ClonePlansDialog } from './clone-plans-dialog'

// ── Types ─────────────────────────────────────────────────────────────────

interface ImportRecord {
  id: string
  filename: string
  sourceType: string
  status: string
  recordsTotal: number
  recordsOk: number
  recordsFailed: number
  errorMessage: string | null
  createdAt: string
  committedAt: string | null
}

interface ImportEnqueuedResponse {
  importRecordId: string
  jobId: string
  message: string
}

function statusVariant(
  status: string,
): 'default' | 'success' | 'destructive' | 'warning' | 'secondary' {
  if (status === 'COMMITTED') return 'success'
  if (status === 'FAILED') return 'destructive'
  if (status === 'DRY_RUN') return 'warning'
  if (status === 'ROLLED_BACK') return 'secondary'
  return 'default'
}

// ── Page-level orchestration ──────────────────────────────────────────────

interface ProgressState {
  readonly source: ImportSource
  readonly mode: ImportMode
  readonly importRecordId: string | null
}

/**
 * Single source of truth for the modal stack on the page. The four tabs
 * call `start()` on click, the progress dialog opens with whatever
 * `importRecordId` came back from the enqueue request, and on the
 * "assign plan" CTA we hand the id off to <BulkAssignPlanDialog>.
 * `<ClonePlansDialog>` is a sibling slot the operator can open from the
 * same finale (only available for altshop / remnashop sources).
 */
function useImportFlow() {
  const [progress, setProgress] = useState<ProgressState | null>(null)
  const [assignFor, setAssignFor] = useState<string | null>(null)
  const [cloneFor, setCloneFor] = useState<string | null>(null)

  const start = useCallback((source: ImportSource, mode: ImportMode) => {
    setProgress({ source, mode, importRecordId: null })
  }, [])

  const setRecordId = useCallback((id: string) => {
    setProgress((prev) => (prev ? { ...prev, importRecordId: id } : prev))
  }, [])

  const closeProgress = useCallback(() => setProgress(null), [])

  const openAssign = useCallback((importRecordId: string) => {
    setAssignFor(importRecordId)
  }, [])
  const closeAssign = useCallback(() => setAssignFor(null), [])

  const openClone = useCallback((importRecordId: string) => {
    setCloneFor(importRecordId)
  }, [])
  const closeClone = useCallback(() => setCloneFor(null), [])

  return {
    progress,
    assignFor,
    cloneFor,
    start,
    setRecordId,
    closeProgress,
    openAssign,
    closeAssign,
    openClone,
    closeClone,
  }
}

// ── Main Page ─────────────────────────────────────────────────────────────

export default function ImportsPage(): JSX.Element {
  const { t } = useTranslation()
  const flow = useImportFlow()
  const canViewImports = useHasPermission('imports', 'view')
  const canImport = useHasPermission('imports', 'import')
  const canRunImports = useHasPermission('imports', 'run')

  if (!canViewImports) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('importsPage.accessDeniedTitle')}</CardTitle>
          <CardDescription>{t('importsPage.accessDeniedDescription')}</CardDescription>
        </CardHeader>
      </Card>
    )
  }

  return (
    <div className="space-y-6">
      <FadeIn>
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <Database className="h-6 w-6" /> {t('importsPage.title')}
          </h1>
          <p className="text-muted-foreground">{t('importsPage.subtitle')}</p>
        </div>
      </FadeIn>

      {canImport || canRunImports ? (
        <Tabs defaultValue="remnawave" className="space-y-4">
          <TabsList className="flex flex-wrap">
            <TabsTrigger value="remnawave" className="gap-1.5">
              <RemnawaveIcon className="h-3.5 w-3.5" />
              Remnawave
            </TabsTrigger>
            {canImport ? (
              <>
                <TabsTrigger value="3xui">3x-ui</TabsTrigger>
                <TabsTrigger value="remnashop" className="gap-1.5">
                  <RemnashopIcon className="h-3.5 w-3.5" />
                  Remnashop
                </TabsTrigger>
                <TabsTrigger value="altshop">Altshop</TabsTrigger>
                <TabsTrigger value="stealthnet">STEALTHNET</TabsTrigger>
              </>
            ) : null}
          </TabsList>

          <TabsContent value="remnawave">
            <RemnawaveTab
              onStart={flow.start}
              onRecordId={flow.setRecordId}
              canImport={canImport}
              canRun={canRunImports}
            />
          </TabsContent>
          {canImport ? (
            <>
              <TabsContent value="3xui">
                <FileUploadTab source="3xui" onStart={flow.start} onRecordId={flow.setRecordId} />
              </TabsContent>
              <TabsContent value="remnashop">
                <FileUploadTab source="remnashop" onStart={flow.start} onRecordId={flow.setRecordId} />
              </TabsContent>
              <TabsContent value="altshop">
                <FileUploadTab source="altshop" onStart={flow.start} onRecordId={flow.setRecordId} />
              </TabsContent>
              <TabsContent value="stealthnet">
                <FileUploadTab source="stealthnet" onStart={flow.start} onRecordId={flow.setRecordId} />
              </TabsContent>
            </>
          ) : null}
        </Tabs>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>{t('importsPage.readOnlyTitle')}</CardTitle>
            <CardDescription>{t('importsPage.readOnlyDescription')}</CardDescription>
          </CardHeader>
        </Card>
      )}

      <ImportHistory />

      {flow.progress ? (
        <ImportProgressDialog
          open
          onClose={flow.closeProgress}
          importRecordId={flow.progress.importRecordId}
          source={flow.progress.source}
          mode={flow.progress.mode}
          onAssignPlan={canRunImports ? flow.openAssign : undefined}
          onClonePlans={canRunImports ? flow.openClone : undefined}
        />
      ) : null}

      {canRunImports && flow.assignFor !== null ? (
        <BulkAssignPlanDialog
          open
          onClose={flow.closeAssign}
          importRecordId={flow.assignFor}
        />
      ) : null}

      {canRunImports && flow.cloneFor !== null ? (
        <ClonePlansDialog
          open
          onClose={flow.closeClone}
          importRecordId={flow.cloneFor}
        />
      ) : null}
    </div>
  )
}

// ── Remnawave Tab ─────────────────────────────────────────────────────────

interface TabProps {
  readonly onStart: (source: ImportSource, mode: ImportMode) => void
  readonly onRecordId: (id: string) => void
}

interface RemnawaveTabProps extends TabProps {
  readonly canImport: boolean
  readonly canRun: boolean
}

function RemnawaveTab({ onStart, onRecordId, canImport, canRun }: RemnawaveTabProps): JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const importMutation = useMutation({
    mutationFn: async (mode: 'import' | 'sync'): Promise<ImportEnqueuedResponse> => {
      const path =
        mode === 'sync' ? '/admin/imports/remnawave/sync' : '/admin/imports/remnawave'
      const response = await api.post<ImportEnqueuedResponse>(path)
      return response.data
    },
    onMutate: (mode) => {
      onStart('remnawave', mode)
    },
    onSuccess: (result) => {
      onRecordId(result.importRecordId)
      queryClient.invalidateQueries({ queryKey: adminQueryKeys.imports.all })
    },
    onError: (err: unknown) => {
      const message = (err as { response?: { data?: { message?: string } } })
        ?.response?.data?.message
      toast.error(
        message === 'REMNAWAVE_INTEGRATION_UNAVAILABLE'
          ? t('importsPage.errorUnavailable')
          : message ?? t('importsPage.errorGeneric'),
      )
    },
  })

  const isImporting =
    importMutation.isPending && importMutation.variables === 'import'
  const isSyncing =
    importMutation.isPending && importMutation.variables === 'sync'

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {canImport ? (
      <HoverLift>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Download className="h-5 w-5 text-primary" />
              {t('importsPage.remnawave.import.title')}
            </CardTitle>
            <CardDescription>
              {t('importsPage.remnawave.import.description')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              onClick={() => importMutation.mutate('import')}
              disabled={importMutation.isPending}
              className="w-full"
              aria-label={t('importsPage.remnawave.import.action')}
            >
              {isImporting ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Download className="mr-2 h-4 w-4" />
              )}
              {t('importsPage.remnawave.import.action')}
            </Button>
          </CardContent>
        </Card>
      </HoverLift>
      ) : null}

      {canRun ? (
      <HoverLift>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <RefreshCw className="h-5 w-5 text-primary" />
              {t('importsPage.remnawave.sync.title')}
            </CardTitle>
            <CardDescription>
              {t('importsPage.remnawave.sync.description')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              variant="outline"
              onClick={() => importMutation.mutate('sync')}
              disabled={importMutation.isPending}
              className="w-full"
              aria-label={t('importsPage.remnawave.sync.action')}
            >
              {isSyncing ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-4 w-4" />
              )}
              {t('importsPage.remnawave.sync.action')}
            </Button>
          </CardContent>
        </Card>
      </HoverLift>
      ) : null}
    </div>
  )
}

// ── File-upload tabs (3x-ui, Remnashop, Altshop) ──────────────────────────

interface FileUploadTabProps extends TabProps {
  readonly source: 'remnashop' | 'altshop' | '3xui' | 'stealthnet'
}

function FileUploadTab({ source, onStart, onRecordId }: FileUploadTabProps): JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [fileName, setFileName] = useState<string | null>(null)

  const path = `/admin/imports/${source}`
  const i18nKey = source === '3xui' ? 'threexui' : source

  const importMutation = useMutation({
    mutationFn: async (file: File): Promise<ImportEnqueuedResponse> => {
      const formData = new FormData()
      formData.append('file', file)
      const response = await api.post<ImportEnqueuedResponse>(path, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      return response.data
    },
    onMutate: () => {
      onStart(source, 'import')
    },
    onSuccess: (result) => {
      onRecordId(result.importRecordId)
      queryClient.invalidateQueries({ queryKey: adminQueryKeys.imports.all })
      setFileName(null)
    },
    onError: (err: unknown) => {
      const message = (err as { response?: { data?: { message?: string } } })
        ?.response?.data?.message
      toast.error(message ?? t('importsPage.errorGeneric'))
    },
  })

  const handleFileSelect = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0]
      if (!file) return
      setFileName(file.name)
      importMutation.mutate(file)
      event.target.value = ''
    },
    [importMutation],
  )

  const accept =
    source === '3xui'
      ? '.json,.db'
      : source === 'stealthnet'
        ? '.sql,.sql.gz,.gz'
        : '.json,.tar.gz,.gz'

  return (
    <HoverLift>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <FileUp className="h-5 w-5 text-primary" />
            {t(`importsPage.${i18nKey}.title`)}
          </CardTitle>
          <CardDescription>
            {t(`importsPage.${i18nKey}.description`)}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <input
            ref={fileInputRef}
            type="file"
            accept={accept}
            onChange={handleFileSelect}
            className="hidden"
            aria-label={t(`importsPage.${i18nKey}.selectFile`)}
          />
          <Button
            onClick={() => fileInputRef.current?.click()}
            disabled={importMutation.isPending}
            className="w-full"
            aria-label={t(`importsPage.${i18nKey}.action`)}
          >
            {importMutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <FileUp className="mr-2 h-4 w-4" />
            )}
            {fileName
              ? t(`importsPage.${i18nKey}.importing`, { filename: fileName })
              : t(`importsPage.${i18nKey}.action`)}
          </Button>
          <p className="text-xs text-muted-foreground">
            {t(`importsPage.${i18nKey}.hint`)}
          </p>
        </CardContent>
      </Card>
    </HoverLift>
  )
}

// ── History ───────────────────────────────────────────────────────────────

function ImportHistory(): JSX.Element {
  const { t } = useTranslation()

  const { data, isLoading } = useQuery({
    queryKey: adminQueryKeys.imports.all,
    queryFn: async (): Promise<ImportRecord[]> => {
      const raw = (await api.get('/admin/imports')).data as
        | ImportRecord[]
        | { items?: ImportRecord[] }
      return Array.isArray(raw) ? raw : (raw?.items ?? [])
    },
    // Auto-refresh every 5 s while on the page so finished imports
    // appear in the table without needing a manual refresh.
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Upload className="h-4 w-4 text-muted-foreground" />
          {t('importsPage.history.title')}
        </CardTitle>
        <CardDescription>
          {data ? t('importsPage.history.count', { count: data.length }) : ''}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : !data || data.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-12 text-muted-foreground">
            <Upload className="h-10 w-10 opacity-30" />
            <p>{t('importsPage.history.empty')}</p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('importsPage.columns.source')}</TableHead>
                <TableHead>{t('importsPage.columns.status')}</TableHead>
                <TableHead>{t('importsPage.columns.processed')}</TableHead>
                <TableHead>{t('importsPage.columns.errors')}</TableHead>
                <TableHead>{t('importsPage.columns.created')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((record) => (
                <TableRow key={record.id}>
                  <TableCell>
                    <Badge variant="outline" className="capitalize">
                      {record.sourceType}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(record.status)}>{record.status}</Badge>
                  </TableCell>
                  <TableCell className="text-sm">
                    {record.recordsOk}
                    <span className="text-muted-foreground"> / {record.recordsTotal}</span>
                  </TableCell>
                  <TableCell className="text-sm text-destructive">
                    {record.recordsFailed > 0 ? record.recordsFailed : '—'}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatDateTime(record.createdAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}
