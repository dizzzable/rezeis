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
import { PermissionGate, useHasPermission } from '@/features/rbac'
import { getErrorMessage } from '@/lib/http-errors'

import {
  type ConfigExportPayload,
  type ConfigImportResult,
  type ConfigSection,
  type ImportStrategy,
  type SectionImportStatus,
  countWebhookRowsMissingSecret,
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
  const canViewConfig = useHasPermission('config_portability', 'view')
  const canExportConfig = useHasPermission('config_portability', 'export')
  const canImportConfig = useHasPermission('config_portability', 'import')
  /**
   * Exporting live signing secrets is gated ABOVE `config_portability:export`,
   * on the permission that already governs the same power through the webhooks
   * screen — the rule `config-import.service.ts` applies in the other
   * direction ("each one additionally demands the permission that governs the
   * same power through its own screen", `SECTION_REQUIRED_PERMISSIONS`).
   *
   * `webhooks:edit` and not `webhooks:view`: the list endpoint returns
   * `secret: null` on purpose (`webhook-subscriptions.service.ts:17-18,222`),
   * so a view-only admin has never been shown a secret value. `webhooks:edit`
   * owns `regenerate-secret` (`admin-webhooks.controller.ts:113-116`), which
   * already hands that admin a live secret for the same row — reading the
   * current one adds no class of power they lack. Not `webhooks:create` as
   * well, unlike the import map: import demands both because it writes new AND
   * existing rows; export only reads existing ones.
   */
  const canRevealWebhookSecrets = useHasPermission('webhooks', 'edit')
  const sectionsQuery = useQuery({
    queryKey: ['config-portability', 'sections'],
    queryFn: listConfigSections,
    enabled: canViewConfig,
    staleTime: 5 * 60 * 1_000,
  })

  const [selected, setSelected] = useState<Set<ConfigSection>>(new Set())
  const [strategy, setStrategy] = useState<ImportStrategy>('overwrite')
  const [dryRun, setDryRun] = useState(true)
  const [includeWebhookSecrets, setIncludeWebhookSecrets] = useState(false)
  const [pickedFile, setPickedFile] = useState<{ name: string; payload: ConfigExportPayload } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [importResult, setImportResult] = useState<ConfigImportResult | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const webhookRowsMissingSecret = useMemo(
    () => (pickedFile === null ? 0 : countWebhookRowsMissingSecret(pickedFile.payload)),
    [pickedFile],
  )

  const allSelected = useMemo(
    () =>
      sectionsQuery.data !== undefined &&
      sectionsQuery.data.length === selected.size &&
      sectionsQuery.data.every((s) => selected.has(s)),
    [sectionsQuery.data, selected],
  )

  const exportMutation = useMutation({
    mutationFn: () =>
      exportConfig(allSelected || selected.size === 0 ? null : Array.from(selected), {
        // Re-checked against the grant at send time, not only at render time:
        // the toggle is a piece of state that outlives the control, so a grant
        // withdrawn mid-session must not still be able to ask for secrets.
        includeWebhookSecrets: canRevealWebhookSecrets && includeWebhookSecrets,
      }),
    onSuccess: (data) => {
      downloadJson(`rezeis-admin-config-${new Date().toISOString().slice(0, 10)}.json`, data)
      setError(null)
    },
    onError: (err) => setError(getErrorMessage(err, t('configPortabilityPage.export.failed'))),
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
    onError: (err) => setError(getErrorMessage(err, t('configPortabilityPage.import.failed'))),
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

  if (!canViewConfig) {
    return (
      <div className="space-y-6">
        {!embedded && (
          <div>
            <h1 className="text-2xl font-bold">{t('configPortabilityPage.title')}</h1>
            <p className="text-sm text-muted-foreground">{t('configPortabilityPage.subtitle')}</p>
          </div>
        )}
        <Card>
          <CardHeader>
            <CardTitle>{t('configPortabilityPage.accessDeniedTitle')}</CardTitle>
            <CardDescription>{t('configPortabilityPage.accessDeniedDescription')}</CardDescription>
          </CardHeader>
        </Card>
      </div>
    )
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
          {canExportConfig ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('configPortabilityPage.export.title')}</CardTitle>
              <CardDescription>{t('configPortabilityPage.export.description')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/*
                The opt-in the API kept for migrations and the panel never
                offered. Defaulted OFF and spelled out rather than labelled:
                turning it on writes live signing secrets in clear text into a
                file that lands in the operator's downloads folder, and the
                reason to accept that is specific — moving to another
                deployment whose receivers must keep validating signatures.
              */}
              <PermissionGate
                resource="webhooks"
                action="edit"
                fallback={
                  <p className="text-xs text-muted-foreground">
                    {t('configPortabilityPage.export.webhookSecrets.locked')}
                  </p>
                }
              >
                <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
                  <div className="flex items-center gap-2">
                    <Switch
                      id="include-webhook-secrets"
                      checked={includeWebhookSecrets}
                      onCheckedChange={setIncludeWebhookSecrets}
                    />
                    <Label htmlFor="include-webhook-secrets">
                      {t('configPortabilityPage.export.webhookSecrets.label')}
                    </Label>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t('configPortabilityPage.export.webhookSecrets.why')}
                  </p>
                  {includeWebhookSecrets && (
                    <p className="flex items-start gap-2 text-xs text-amber-600 dark:text-amber-400">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span>{t('configPortabilityPage.export.webhookSecrets.armed')}</span>
                    </p>
                  )}
                </div>
              </PermissionGate>

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
          ) : null}

          {canImportConfig ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('configPortabilityPage.import.title')}</CardTitle>
              <CardDescription>{t('configPortabilityPage.import.description')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="config-import-file">{t('configPortabilityPage.import.file')}</Label>
                <input
                  id="config-import-file"
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
                {/*
                  Said before the run, not discovered from a `failed` row
                  afterwards. The result card already reports the section
                  honestly — this adds nothing to that mechanism, it just reads
                  the file that is already parsed and in state. Deliberately a
                  warning and not a block: a row that ALREADY exists on this
                  deployment imports fine without its secret (the update arm
                  keeps the destination's own), so refusing the file outright
                  would break the ordinary re-import of a redacted export.
                */}
                {webhookRowsMissingSecret > 0 && (
                  <p className="flex items-start gap-2 text-xs text-amber-600 dark:text-amber-400">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>
                      {t('configPortabilityPage.import.webhookSecretsMissing', {
                        count: webhookRowsMissingSecret,
                      })}
                    </span>
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
          ) : null}

          {!canExportConfig && !canImportConfig ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t('configPortabilityPage.readOnlyTitle')}</CardTitle>
                <CardDescription>{t('configPortabilityPage.readOnlyDescription')}</CardDescription>
              </CardHeader>
            </Card>
          ) : null}

          {canImportConfig && importResult && <ImportResultCard result={importResult} />}
        </div>
      </div>
    </div>
  )
}

const STATUS_CLASS: Record<SectionImportStatus, string> = {
  imported: 'text-emerald-600 dark:text-emerald-400',
  missing: 'text-amber-600 dark:text-amber-400',
  rejected: 'text-destructive',
  failed: 'text-destructive',
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
  // A green tick over a table of sections that were never in the file is the
  // same lie the API used to tell, moved one layer up. But keying purely on
  // `status` re-creates the opposite lie in its place: the backend
  // deliberately makes an absent section a NON-error when the operator did not
  // name it (`config-import.service.ts` → `classifySection`), because
  // promoting one section out of a partial export is a normal workflow and
  // "turning nine informational rows into nine red errors would train
  // operators to ignore the column". Warning on every ordinary subset restore
  // is exactly that outcome — and it makes a genuine `rejected` or `failed`
  // row indistinguishable from routine noise.
  //
  // So the card asks the question the backend already answered rather than
  // re-deciding it: a row is a problem when the backend said so. `rejected`
  // and `failed` always carry an error, and a `missing` section the operator
  // DID name carries one too; a `missing` section nobody asked for carries
  // none, and is information, not a failure.
  const problems = result.summaries.filter(
    (s) => s.errors.length > 0 || s.status === 'rejected' || s.status === 'failed',
  )
  const clean = problems.length === 0 && result.integrity !== 'violated'
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          {clean ? (
            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
          ) : (
            <AlertTriangle className="h-4 w-4 text-amber-500" />
          )}
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
        <CardDescription>
          {t('configPortabilityPage.result.integrity.label')}
          {': '}
          <span className={result.integrity === 'violated' ? 'text-destructive' : undefined}>
            {t(`configPortabilityPage.result.integrity.${result.integrity}`)}
          </span>
        </CardDescription>
        {problems.length > 0 && (
          <CardDescription className="text-amber-600 dark:text-amber-400">
            {t('configPortabilityPage.result.incomplete', {
              total: problems.length,
              sections: problems.map((s) => s.section).join(', '),
            })}
          </CardDescription>
        )}
      </CardHeader>
      <CardContent className="p-0 overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="border-b bg-muted/30 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2">{t('configPortabilityPage.result.columns.section')}</th>
              <th className="px-3 py-2">{t('configPortabilityPage.result.columns.status')}</th>
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
                <td className={`px-3 py-2 text-xs font-medium ${STATUS_CLASS[row.status] ?? ''}`}>
                  {t(`configPortabilityPage.result.statuses.${row.status}`)}
                </td>
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
