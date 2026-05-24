/**
 * Imports page — tabbed interface for importing users from multiple sources:
 *
 *   • Remnawave — live API pull (one-button import/sync)
 *   • 3x-ui — JSON file upload (clients export from 3x-ui panel)
 *   • Remnashop — JSON file upload (users + subscriptions from remnashop DB)
 *   • Altshop — JSON file upload (users + subscriptions + transactions from altshop DB)
 *
 * Each tab has its own import/sync buttons. The history table at the bottom
 * shows all import records across all sources.
 */

import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle,
  CheckCircle2,
  ClipboardList,
  Database,
  Download,
  FileUp,
  Loader2,
  RefreshCw,
  Upload,
} from 'lucide-react'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { formatDateTime } from '@/lib/utils'
import { usePlans } from '@/features/plans/plans-api'
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
  Alert,
  AlertDescription,
  AlertTitle,
} from '@/components/ui/alert'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { FadeIn, HoverLift } from '@/lib/motion'

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

interface ImportSummary {
  importRecordId: string
  fetched: number
  created: number
  updated: number
  skipped: number
  subscriptionsCreated: number
  subscriptionsUpdated: number
  errors: readonly string[]
}

interface RemnawaveImportSummary extends ImportSummary {
  descriptionWritebacks: number
}

interface BulkAssignResult {
  updated: number
  skippedDeleted: number
  skippedAlreadyAssigned: number
  skippedNoSubscription: number
  errors: number
  syncJobsCreated: number
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

// ── Main Page ─────────────────────────────────────────────────────────────

export default function ImportsPage() {
  const { t } = useTranslation()

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

      <Tabs defaultValue="remnawave" className="space-y-4">
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="remnawave">Remnawave</TabsTrigger>
          <TabsTrigger value="3xui">3x-ui</TabsTrigger>
          <TabsTrigger value="remnashop">Remnashop</TabsTrigger>
          <TabsTrigger value="altshop">Altshop</TabsTrigger>
        </TabsList>

        <TabsContent value="remnawave">
          <RemnawaveTab />
        </TabsContent>

        <TabsContent value="3xui">
          <ThreeXuiTab />
        </TabsContent>

        <TabsContent value="remnashop">
          <RemnashopTab />
        </TabsContent>

        <TabsContent value="altshop">
          <AltshopTab />
        </TabsContent>
      </Tabs>

      <ImportHistory />
    </div>
  )
}

// ── Remnawave Tab ─────────────────────────────────────────────────────────

function RemnawaveTab() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const importMutation = useMutation({
    mutationFn: async (mode: 'import' | 'sync'): Promise<RemnawaveImportSummary> => {
      const path =
        mode === 'sync'
          ? '/admin/imports/remnawave/sync'
          : '/admin/imports/remnawave'
      const response = await api.post<RemnawaveImportSummary>(path)
      return response.data
    },
    onSuccess: (result, mode) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'imports'] })
      const summary = t('importsPage.success', {
        fetched: result.fetched,
        created: result.created,
        updated: result.updated,
        skipped: result.skipped,
      })
      if (mode === 'sync') {
        toast.success(t('importsPage.syncDone', { summary }))
      } else {
        toast.success(t('importsPage.importDone', { summary }))
      }
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

  const isImporting = importMutation.isPending && importMutation.variables === 'import'
  const isSyncing = importMutation.isPending && importMutation.variables === 'sync'

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
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
      </div>

      {importMutation.isSuccess && importMutation.data && (
        <ImportResultAlert
          data={importMutation.data}
          isSync={importMutation.variables === 'sync'}
        />
      )}

      {importMutation.isSuccess && importMutation.data && importMutation.variables !== 'sync' && (
        <BulkPlanAssignment importRecordId={importMutation.data.importRecordId} />
      )}
    </div>
  )
}

// ── 3x-ui Tab ─────────────────────────────────────────────────────────────

function ThreeXuiTab() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [fileName, setFileName] = useState<string | null>(null)

  const importMutation = useMutation({
    mutationFn: async (file: File): Promise<ImportSummary> => {
      const formData = new FormData()
      formData.append('file', file)
      const response = await api.post<ImportSummary>('/admin/imports/3xui', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      return response.data
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'imports'] })
      toast.success(t('importsPage.importDone', {
        summary: t('importsPage.success', {
          fetched: result.fetched,
          created: result.created,
          updated: result.updated,
          skipped: result.skipped,
        }),
      }))
      setFileName(null)
    },
    onError: (err: unknown) => {
      const message = (err as { response?: { data?: { message?: string } } })
        ?.response?.data?.message
      toast.error(message ?? t('importsPage.errorGeneric'))
    },
  })

  const handleFileSelect = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    setFileName(file.name)
    importMutation.mutate(file)
    event.target.value = ''
  }, [importMutation])

  return (
    <div className="space-y-4">
      <HoverLift>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <FileUp className="h-5 w-5 text-primary" />
              {t('importsPage.threexui.title')}
            </CardTitle>
            <CardDescription>
              {t('importsPage.threexui.description')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,.db"
              onChange={handleFileSelect}
              className="hidden"
              aria-label={t('importsPage.threexui.selectFile')}
            />
            <Button
              onClick={() => fileInputRef.current?.click()}
              disabled={importMutation.isPending}
              className="w-full"
              aria-label={t('importsPage.threexui.action')}
            >
              {importMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <FileUp className="mr-2 h-4 w-4" />
              )}
              {fileName
                ? t('importsPage.threexui.importing', { filename: fileName })
                : t('importsPage.threexui.action')}
            </Button>
            <p className="text-xs text-muted-foreground">
              {t('importsPage.threexui.hint')}
            </p>
          </CardContent>
        </Card>
      </HoverLift>

      {importMutation.isSuccess && importMutation.data && (
        <ImportResultAlert data={importMutation.data} isSync={false} />
      )}

      {importMutation.isSuccess && importMutation.data && (
        <BulkPlanAssignment importRecordId={importMutation.data.importRecordId} />
      )}
    </div>
  )
}

// ── Remnashop Tab ─────────────────────────────────────────────────────────

function RemnashopTab() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [fileName, setFileName] = useState<string | null>(null)

  const importMutation = useMutation({
    mutationFn: async (file: File): Promise<ImportSummary> => {
      const formData = new FormData()
      formData.append('file', file)
      const response = await api.post<ImportSummary>('/admin/imports/remnashop', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      return response.data
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'imports'] })
      toast.success(t('importsPage.importDone', {
        summary: t('importsPage.success', {
          fetched: result.fetched,
          created: result.created,
          updated: result.updated,
          skipped: result.skipped,
        }),
      }))
      setFileName(null)
    },
    onError: (err: unknown) => {
      const message = (err as { response?: { data?: { message?: string } } })
        ?.response?.data?.message
      toast.error(message ?? t('importsPage.errorGeneric'))
    },
  })

  const handleFileSelect = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    setFileName(file.name)
    importMutation.mutate(file)
    event.target.value = ''
  }, [importMutation])

  return (
    <div className="space-y-4">
      <HoverLift>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <FileUp className="h-5 w-5 text-primary" />
              {t('importsPage.remnashop.title')}
            </CardTitle>
            <CardDescription>
              {t('importsPage.remnashop.description')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,.tar.gz,.gz"
              onChange={handleFileSelect}
              className="hidden"
              aria-label={t('importsPage.remnashop.selectFile')}
            />
            <Button
              onClick={() => fileInputRef.current?.click()}
              disabled={importMutation.isPending}
              className="w-full"
              aria-label={t('importsPage.remnashop.action')}
            >
              {importMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <FileUp className="mr-2 h-4 w-4" />
              )}
              {fileName
                ? t('importsPage.remnashop.importing', { filename: fileName })
                : t('importsPage.remnashop.action')}
            </Button>
            <p className="text-xs text-muted-foreground">
              {t('importsPage.remnashop.hint')}
            </p>
          </CardContent>
        </Card>
      </HoverLift>

      {importMutation.isSuccess && importMutation.data && (
        <ImportResultAlert data={importMutation.data} isSync={false} />
      )}

      {importMutation.isSuccess && importMutation.data && (
        <BulkPlanAssignment importRecordId={importMutation.data.importRecordId} />
      )}
    </div>
  )
}

// ── Altshop Tab ───────────────────────────────────────────────────────────

function AltshopTab() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [fileName, setFileName] = useState<string | null>(null)

  const importMutation = useMutation({
    mutationFn: async (file: File): Promise<ImportSummary> => {
      const formData = new FormData()
      formData.append('file', file)
      const response = await api.post<ImportSummary>('/admin/imports/altshop', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      return response.data
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'imports'] })
      toast.success(t('importsPage.importDone', {
        summary: t('importsPage.success', {
          fetched: result.fetched,
          created: result.created,
          updated: result.updated,
          skipped: result.skipped,
        }),
      }))
      setFileName(null)
    },
    onError: (err: unknown) => {
      const message = (err as { response?: { data?: { message?: string } } })
        ?.response?.data?.message
      toast.error(message ?? t('importsPage.errorGeneric'))
    },
  })

  const handleFileSelect = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    setFileName(file.name)
    importMutation.mutate(file)
    event.target.value = ''
  }, [importMutation])

  return (
    <div className="space-y-4">
      <HoverLift>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <FileUp className="h-5 w-5 text-primary" />
              {t('importsPage.altshop.title')}
            </CardTitle>
            <CardDescription>
              {t('importsPage.altshop.description')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,.tar.gz,.gz"
              onChange={handleFileSelect}
              className="hidden"
              aria-label={t('importsPage.altshop.selectFile')}
            />
            <Button
              onClick={() => fileInputRef.current?.click()}
              disabled={importMutation.isPending}
              className="w-full"
              aria-label={t('importsPage.altshop.action')}
            >
              {importMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <FileUp className="mr-2 h-4 w-4" />
              )}
              {fileName
                ? t('importsPage.altshop.importing', { filename: fileName })
                : t('importsPage.altshop.action')}
            </Button>
            <p className="text-xs text-muted-foreground">
              {t('importsPage.altshop.hint')}
            </p>
          </CardContent>
        </Card>
      </HoverLift>

      {importMutation.isSuccess && importMutation.data && (
        <ImportResultAlert data={importMutation.data} isSync={false} />
      )}

      {importMutation.isSuccess && importMutation.data && (
        <BulkPlanAssignment importRecordId={importMutation.data.importRecordId} />
      )}
    </div>
  )
}

// ── Shared Components ─────────────────────────────────────────────────────

function ImportResultAlert({ data, isSync }: { data: ImportSummary; isSync: boolean }) {
  const { t } = useTranslation()
  const errors = data.errors ?? []

  return (
    <Alert>
      {errors.length === 0 ? (
        <CheckCircle2 className="h-4 w-4" />
      ) : (
        <AlertCircle className="h-4 w-4" />
      )}
      <AlertTitle>
        {isSync ? t('importsPage.lastRunSync') : t('importsPage.lastRunImport')}
      </AlertTitle>
      <AlertDescription>
        {t('importsPage.summary', {
          fetched: data.fetched,
          created: data.created,
          updated: data.updated,
          skipped: data.skipped,
        })}
        {errors.length > 0 && (
          <span className="ml-2 text-destructive">
            ({t('importsPage.errorsCount', { count: errors.length })})
          </span>
        )}
      </AlertDescription>
    </Alert>
  )
}

function BulkPlanAssignment({ importRecordId }: { importRecordId?: string }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [selectedPlanId, setSelectedPlanId] = useState<string>('')

  const { data: plans } = usePlans({ active: true })

  const assignMutation = useMutation({
    mutationFn: async (planId: string): Promise<BulkAssignResult> => {
      const response = await api.post<BulkAssignResult>('/admin/imports/assign-plan', {
        planId,
        importRecordId,
      })
      return response.data
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'imports'] })
      toast.success(t('importsPage.assignPlan.success', {
        updated: result.updated,
        skipped: result.skippedAlreadyAssigned,
        synced: result.syncJobsCreated,
      }))
    },
    onError: (err: unknown) => {
      const message = (err as { response?: { data?: { message?: string } } })
        ?.response?.data?.message
      toast.error(message ?? t('importsPage.errorGeneric'))
    },
  })

  if (!plans || plans.length === 0) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <ClipboardList className="h-5 w-5 text-primary" />
          {t('importsPage.assignPlan.title')}
        </CardTitle>
        <CardDescription>
          {t('importsPage.assignPlan.description')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Select value={selectedPlanId} onValueChange={setSelectedPlanId}>
          <SelectTrigger aria-label={t('importsPage.assignPlan.selectPlan')}>
            <SelectValue placeholder={t('importsPage.assignPlan.selectPlan')} />
          </SelectTrigger>
          <SelectContent>
            {plans.map((plan) => (
              <SelectItem key={plan.id} value={plan.id}>
                {plan.name}
                {plan.trafficLimit !== null && ` (${plan.trafficLimit} GB)`}
                {plan.deviceLimit > 0 && ` · ${plan.deviceLimit} dev`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          onClick={() => assignMutation.mutate(selectedPlanId)}
          disabled={!selectedPlanId || assignMutation.isPending}
          className="w-full"
          aria-label={t('importsPage.assignPlan.action')}
        >
          {assignMutation.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <ClipboardList className="mr-2 h-4 w-4" />
          )}
          {t('importsPage.assignPlan.action')}
        </Button>
      </CardContent>
    </Card>
  )
}

function ImportHistory() {
  const { t } = useTranslation()

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'imports'],
    queryFn: async (): Promise<ImportRecord[]> => {
      const raw = (await api.get('/admin/imports')).data as
        | ImportRecord[]
        | { items?: ImportRecord[] }
      return Array.isArray(raw) ? raw : (raw?.items ?? [])
    },
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
