/**
 * Imports page — altshop-style two-button flow:
 *
 *   • "Import from Remnawave"  — pulls every panel user and creates
 *     missing local rows (matched by Telegram ID).
 *   • "Sync with Remnawave"    — refreshes existing local users only;
 *     never creates new ones.
 *
 * Both buttons hit the new admin endpoints in
 * `src/modules/imports/controllers/admin-imports.controller.ts`. The
 * panel below shows the run history (newest first), reading from the
 * persisted `import_records` table.
 */

import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle,
  CheckCircle2,
  Database,
  Download,
  Loader2,
  RefreshCw,
  Upload,
} from 'lucide-react'
import { toast } from 'sonner'

import { api } from '@/lib/api'
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
import { FadeIn, HoverLift } from '@/lib/motion'

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

interface RemnawaveImportSummary {
  importRecordId: string
  fetched: number
  created: number
  updated: number
  skipped: number
  errors: readonly string[]
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

export default function ImportsPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'imports'],
    queryFn: async (): Promise<ImportRecord[]> => {
      const raw = (await api.get('/admin/imports')).data as
        | ImportRecord[]
        | { items?: ImportRecord[] }
      return Array.isArray(raw) ? raw : (raw?.items ?? [])
    },
  })

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
      const summary =
        result.errors.length === 0
          ? t('importsPage.success', {
              fetched: result.fetched,
              created: result.created,
              updated: result.updated,
              skipped: result.skipped,
            })
          : t('importsPage.successWithErrors', {
              fetched: result.fetched,
              created: result.created,
              updated: result.updated,
              skipped: result.skipped,
              errors: result.errors.length,
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
    <div className="space-y-6">
      <FadeIn>
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <Database className="h-6 w-6" /> {t('importsPage.title')}
          </h1>
          <p className="text-muted-foreground">{t('importsPage.subtitle')}</p>
        </div>
      </FadeIn>

      <div className="grid gap-4 md:grid-cols-2">
        <HoverLift>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Download className="h-5 w-5 text-primary" />
                {t('importsPage.import.title')}
              </CardTitle>
              <CardDescription>
                {t('importsPage.import.description')}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                onClick={() => importMutation.mutate('import')}
                disabled={importMutation.isPending}
                className="w-full"
              >
                {isImporting ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Download className="mr-2 h-4 w-4" />
                )}
                {t('importsPage.import.action')}
              </Button>
            </CardContent>
          </Card>
        </HoverLift>

        <HoverLift>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <RefreshCw className="h-5 w-5 text-primary" />
                {t('importsPage.sync.title')}
              </CardTitle>
              <CardDescription>{t('importsPage.sync.description')}</CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                variant="outline"
                onClick={() => importMutation.mutate('sync')}
                disabled={importMutation.isPending}
                className="w-full"
              >
                {isSyncing ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="mr-2 h-4 w-4" />
                )}
                {t('importsPage.sync.action')}
              </Button>
            </CardContent>
          </Card>
        </HoverLift>
      </div>

      {importMutation.isSuccess && importMutation.data && (
        <Alert>
          {importMutation.data.errors.length === 0 ? (
            <CheckCircle2 className="h-4 w-4" />
          ) : (
            <AlertCircle className="h-4 w-4" />
          )}
          <AlertTitle>
            {importMutation.variables === 'sync'
              ? t('importsPage.lastRunSync')
              : t('importsPage.lastRunImport')}
          </AlertTitle>
          <AlertDescription>
            {t('importsPage.summary', {
              fetched: importMutation.data.fetched,
              created: importMutation.data.created,
              updated: importMutation.data.updated,
              skipped: importMutation.data.skipped,
            })}
            {importMutation.data.errors.length > 0 && (
              <span className="ml-2 text-destructive">
                ({t('importsPage.errorsCount', { count: importMutation.data.errors.length })})
              </span>
            )}
          </AlertDescription>
        </Alert>
      )}

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
    </div>
  )
}
