/* eslint-disable @typescript-eslint/no-explicit-any -- TODO: type API responses */
import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Loader2, Upload, Download, AlertTriangle, CheckCircle2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'

import {
  type ConfigExportPayload,
  type ConfigImportResult,
  type ConfigSection,
  type ImportStrategy,
  exportConfig,
  importConfig,
  listConfigSections,
} from './config-portability-api'

/**
 * Phase 8 — Config export / import.
 *
 * Layout
 *   - Left: section picker (checkbox list).
 *   - Right: action panel — Export button (returns JSON download) and
 *     Import area (file picker + strategy + dry-run).
 *   - Bottom: result summary table after either action.
 */
export default function ConfigPortabilityPage({ embedded = false }: { readonly embedded?: boolean } = {}) {
  const { t } = useTranslation()
  const sectionsQuery = useQuery({
    queryKey: ['config-portability', 'sections'],
    queryFn: listConfigSections,
    staleTime: 5 * 60 * 1_000,
  })

  const [selected, setSelected] = useState<Set<ConfigSection>>(new Set())
  const [strategy, setStrategy] = useState<ImportStrategy>('overwrite')
  const [dryRun, setDryRun] = useState(true)
  const [pickedFile, setPickedFile] = useState<{ name: string; payload: ConfigExportPayload } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [importResult, setImportResult] = useState<ConfigImportResult | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const allSelected = useMemo(
    () =>
      sectionsQuery.data !== undefined &&
      sectionsQuery.data.length === selected.size &&
      sectionsQuery.data.every((s) => selected.has(s)),
    [sectionsQuery.data, selected],
  )

  const exportMutation = useMutation({
    mutationFn: () =>
      exportConfig(allSelected || selected.size === 0 ? null : Array.from(selected)),
    onSuccess: (data) => {
      downloadJson(`rezeis-admin-config-${new Date().toISOString().slice(0, 10)}.json`, data)
      setError(null)
    },
    onError: (err: any) => setError(err.response?.data?.message ?? t('configPortabilityPage.export.failed')),
  })

  const importMutation = useMutation({
    mutationFn: () => {
      if (!pickedFile) {
        return Promise.reject(new Error(t('configPortabilityPage.import.pickFirst')))
      }
      return importConfig({
        payload: pickedFile.payload,
        sections: allSelected || selected.size === 0 ? null : Array.from(selected),
        strategy,
        dryRun,
      })
    },
    onSuccess: (result) => {
      setImportResult(result)
      setError(null)
    },
    onError: (err: any) => setError(err.response?.data?.message ?? err.message ?? t('configPortabilityPage.import.failed')),
  })

  const onFilePicked = async (file: File) => {
    setError(null)
    try {
      const text = await file.text()
      const parsed = JSON.parse(text) as ConfigExportPayload
      if (typeof parsed.version !== 'number' || !parsed.sections) {
        throw new Error(t('configPortabilityPage.import.invalid'))
      }
      setPickedFile({ name: file.name, payload: parsed })
    } catch (err) {
      setError((err as Error).message)
      setPickedFile(null)
    }
  }

  const toggleSection = (section: ConfigSection) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(section)) next.delete(section)
      else next.add(section)
      return next
    })
  }

  const toggleAll = () => {
    if (!sectionsQuery.data) return
    if (allSelected) setSelected(new Set())
    else setSelected(new Set(sectionsQuery.data))
  }

  return (
    <div className="space-y-6">
      {!embedded && (
        <div>
          <h1 className="text-2xl font-bold">{t('configPortabilityPage.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('configPortabilityPage.subtitle')}</p>
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-2 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('configPortabilityPage.sections.title')}</CardTitle>
            <CardDescription>{t('configPortabilityPage.sections.description')}</CardDescription>
          </CardHeader>
          <CardContent>
            {sectionsQuery.isLoading || !sectionsQuery.data ? (
              <Skeleton className="h-40 w-full" />
            ) : (
              <div className="space-y-2">
                <label className="flex items-center gap-2 border-b pb-2 text-sm font-medium">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                    className="h-4 w-4"
                  />
                  {t('configPortabilityPage.sections.selectAll', { count: sectionsQuery.data.length })}
                </label>
                {sectionsQuery.data.map((section) => (
                  <label
                    key={section}
                    className="flex items-center gap-2 text-sm"
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(section)}
                      onChange={() => toggleSection(section)}
                      className="h-4 w-4"
                    />
                    <code className="rounded bg-muted px-1 text-xs">{section}</code>
                  </label>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('configPortabilityPage.export.title')}</CardTitle>
              <CardDescription>{t('configPortabilityPage.export.description')}</CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                onClick={() => exportMutation.mutate()}
                disabled={exportMutation.isPending}
              >
                {exportMutation.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Download className="mr-2 h-4 w-4" />
                )}
                {t('configPortabilityPage.export.download')}
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('configPortabilityPage.import.title')}</CardTitle>
              <CardDescription>{t('configPortabilityPage.import.description')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>{t('configPortabilityPage.import.file')}</Label>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/json,.json"
                  className="block w-full text-sm text-muted-foreground file:mr-4 file:rounded-md file:border-0 file:bg-muted file:px-3 file:py-1.5 file:text-sm file:font-medium hover:file:bg-muted/80"
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (file) onFilePicked(file)
                  }}
                />
                {pickedFile && (
                  <p className="text-xs text-muted-foreground">
                    {t('configPortabilityPage.import.loadedFile', {
                      name: pickedFile.name,
                      version: pickedFile.payload.version,
                      count: Object.keys(pickedFile.payload.sections).length,
                    })}
                  </p>
                )}
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>{t('configPortabilityPage.import.strategy')}</Label>
                  <div className="flex gap-2">
                    {(['skip', 'overwrite'] as const).map((option) => (
                      <Button
                        key={option}
                        size="sm"
                        variant={strategy === option ? 'default' : 'outline'}
                        onClick={() => setStrategy(option)}
                      >
                        {t(`configPortabilityPage.import.strategies.${option}`)}
                      </Button>
                    ))}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Switch checked={dryRun} onCheckedChange={setDryRun} id="dry-run" />
                  <Label htmlFor="dry-run">{t('configPortabilityPage.import.dryRun')}</Label>
                </div>
              </div>

              <Button
                onClick={() => importMutation.mutate()}
                disabled={importMutation.isPending || !pickedFile}
              >
                {importMutation.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Upload className="mr-2 h-4 w-4" />
                )}
                {dryRun ? t('configPortabilityPage.import.runPreview') : t('configPortabilityPage.import.apply')}
              </Button>
            </CardContent>
          </Card>

          {importResult && <ImportResultCard result={importResult} />}
        </div>
      </div>
    </div>
  )
}

function ImportResultCard({ result }: { result: ConfigImportResult }) {
  const { t } = useTranslation()
  const totals = result.summaries.reduce(
    (acc, s) => ({
      created: acc.created + s.created,
      updated: acc.updated + s.updated,
      skipped: acc.skipped + s.skipped,
      errors: acc.errors + s.errors.length,
    }),
    { created: 0, updated: 0, skipped: 0, errors: 0 },
  )
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 text-emerald-500" />
          <CardTitle className="text-base">
            {result.dryRun ? t('configPortabilityPage.result.titlePreview') : t('configPortabilityPage.result.titleApplied')}
          </CardTitle>
        </div>
        <CardDescription>
          {t('configPortabilityPage.result.summary', {
            strategy: result.strategy,
            created: totals.created,
            updated: totals.updated,
            skipped: totals.skipped,
            errors: totals.errors,
          })}
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/30 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2">{t('configPortabilityPage.result.columns.section')}</th>
              <th className="px-3 py-2 text-right">{t('configPortabilityPage.result.columns.created')}</th>
              <th className="px-3 py-2 text-right">{t('configPortabilityPage.result.columns.updated')}</th>
              <th className="px-3 py-2 text-right">{t('configPortabilityPage.result.columns.skipped')}</th>
              <th className="px-3 py-2">{t('configPortabilityPage.result.columns.errors')}</th>
            </tr>
          </thead>
          <tbody>
            {result.summaries.map((row) => (
              <tr key={row.section} className="border-b last:border-0">
                <td className="px-3 py-2 font-mono text-xs">{row.section}</td>
                <td className="px-3 py-2 text-right tabular-nums">{row.created}</td>
                <td className="px-3 py-2 text-right tabular-nums">{row.updated}</td>
                <td className="px-3 py-2 text-right tabular-nums">{row.skipped}</td>
                <td className="px-3 py-2 text-xs text-destructive">
                  {row.errors.length === 0
                    ? '—'
                    : row.errors.join(', ')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  )
}

function downloadJson(filename: string, data: unknown): void {
  const json = JSON.stringify(data, null, 2)
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1_000)
}
