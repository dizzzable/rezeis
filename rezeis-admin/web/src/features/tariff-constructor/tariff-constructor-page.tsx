import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Calculator, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { PermissionGate, useHasPermission } from '@/features/rbac/permission-gate'
import { usePlans } from '@/features/plans/plans-api'
import { getErrorMessage } from '@/lib/http-errors'
import { publishTariffConstructor, saveTariffConstructorDraft, tariffConstructorOptions, tariffConstructorQueryKeys, toggleTariffConstructor } from './tariff-constructor-api'
import { TariffConstructorForm } from './tariff-constructor-form'
import { firstTariffConstructorError, tariffConstructorDraftSchema, type TariffConstructorDraft } from './tariff-constructor-schema'

const EMPTY_DRAFT: TariffConstructorDraft = {
  basePlanId: '',
  durations: [],
  modules: [
    { type: 'TRAFFIC', minValue: 0, maxValue: 0, defaultValue: 0, step: 1, prices: [] },
    { type: 'DEVICES', minValue: 0, maxValue: 0, defaultValue: 0, step: 1, prices: [] },
  ],
}

export default function TariffConstructorPage() {
  const queryClient = useQueryClient()
  const canSave = useHasPermission('plans', 'create')
  const canEdit = useHasPermission('plans', 'edit')
  const constructorQuery = useQuery({ ...tariffConstructorOptions(), retry: false })
  const plansQuery = usePlans({ active: true })
  const [draft, setDraft] = useState<TariffConstructorDraft>(EMPTY_DRAFT)
  const [formError, setFormError] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<'publish' | 'toggle' | null>(null)

  const refresh = () => queryClient.invalidateQueries({ queryKey: tariffConstructorQueryKeys.all })
  const saveMutation = useMutation({
    mutationFn: saveTariffConstructorDraft,
    onSuccess: async () => { setFormError(null); await refresh(); toast.success('Draft saved') },
    onError: (error) => setFormError(getErrorMessage(error, 'Failed to save draft.')),
  })
  const publishMutation = useMutation({
    mutationFn: publishTariffConstructor,
    onSuccess: async ({ version }) => { setConfirmation(null); await refresh(); toast.success(`Revision ${version} published`) },
    onError: (error) => { setConfirmation(null); toast.error(getErrorMessage(error, 'Failed to publish.')) },
  })
  const toggleMutation = useMutation({
    mutationFn: toggleTariffConstructor,
    onSuccess: async ({ enabled }) => { setConfirmation(null); await refresh(); toast.success(enabled ? 'Constructor enabled' : 'Constructor disabled') },
    onError: (error) => { setConfirmation(null); toast.error(getErrorMessage(error, 'Failed to change enabled state.')) },
  })

  if (constructorQuery.isLoading || plansQuery.isLoading) return <div className="space-y-4"><Skeleton className="h-10 w-72" /><Skeleton className="h-72 w-full" /></div>
  const isMissing = constructorQuery.isError && getHttpStatus(constructorQuery.error) === 404
  if (constructorQuery.isError && !isMissing) return <Alert variant="destructive"><AlertTitle>Could not load tariff constructor</AlertTitle><AlertDescription className="flex items-center justify-between gap-4">{getErrorMessage(constructorQuery.error, 'Request failed.')}<Button variant="outline" size="sm" onClick={() => constructorQuery.refetch()}><RefreshCw className="h-4 w-4" /> Retry</Button></AlertDescription></Alert>
  if (plansQuery.isError) return <Alert variant="destructive"><AlertTitle>Could not load plans</AlertTitle><AlertDescription>{getErrorMessage(plansQuery.error, 'Request failed.')}</AlertDescription></Alert>

  const currentRevision = constructorQuery.data?.revisions.find((revision) => revision.id === constructorQuery.data?.publishedRevisionId)
  const effectiveDraft = draft === EMPTY_DRAFT && constructorQuery.data
    ? { basePlanId: constructorQuery.data.basePlanId, durations: [...constructorQuery.data.durations], modules: constructorQuery.data.modules.map((module) => ({ ...module, prices: [...module.prices] })) }
    : draft
  const preview = tariffConstructorDraftSchema.safeParse(effectiveDraft)
  const busy = saveMutation.isPending || publishMutation.isPending || toggleMutation.isPending

  return (
    <PermissionGate resource="plans" action="view" hideWhileLoading fallback={<Alert variant="destructive"><AlertTitle>Access denied</AlertTitle><AlertDescription>Plans view permission is required.</AlertDescription></Alert>}>
      <div className="space-y-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div><h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight"><Calculator className="h-6 w-6" /> Tariff constructor</h1><p className="text-muted-foreground">Configure and publish the customer-facing modular tariff.</p></div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={constructorQuery.data?.enabled ? 'default' : 'secondary'}>{constructorQuery.data?.enabled ? 'Enabled' : 'Disabled'}</Badge>
            <span className="text-sm text-muted-foreground">Published revision: {currentRevision ? `v${currentRevision.version}` : 'None'}</span>
            {canEdit && <Button variant="outline" onClick={() => setConfirmation('toggle')} disabled={!constructorQuery.data || busy}>{constructorQuery.data?.enabled ? 'Disable' : 'Enable'}</Button>}
            {canEdit && <Button onClick={() => setConfirmation('publish')} disabled={!constructorQuery.data || busy}>Publish draft</Button>}
          </div>
        </div>

        <Preview draft={preview.success ? preview.data : null} />
        {!canSave && <Alert><AlertTitle>Read-only access</AlertTitle><AlertDescription>Plans create permission is required to save drafts.</AlertDescription></Alert>}
        <TariffConstructorForm draft={effectiveDraft} plans={(plansQuery.data ?? []).filter((plan) => !plan.isArchived)} disabled={!canSave || busy} error={formError} onChange={(next) => { setDraft(next); setFormError(null) }} onSubmit={() => { const parsed = tariffConstructorDraftSchema.safeParse(effectiveDraft); if (!parsed.success) { setFormError(firstTariffConstructorError(parsed.error)); return } saveMutation.mutate(parsed.data) }} />

        <AlertDialog open={confirmation !== null} onOpenChange={(open) => !open && setConfirmation(null)}>
          <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{confirmation === 'publish' ? 'Publish this draft?' : `${constructorQuery.data?.enabled ? 'Disable' : 'Enable'} tariff constructor?`}</AlertDialogTitle><AlertDialogDescription>{confirmation === 'publish' ? 'Publishing creates an immutable revision used by new quotes.' : 'This changes whether the published constructor is available to customers.'}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel><AlertDialogAction disabled={busy} onClick={() => confirmation === 'publish' ? publishMutation.mutate() : toggleMutation.mutate(!constructorQuery.data?.enabled)}>Confirm</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
        </AlertDialog>
      </div>
    </PermissionGate>
  )
}

function getHttpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !('response' in error)) return undefined
  const response = error.response
  if (!response || typeof response !== 'object' || !('status' in response)) return undefined
  return typeof response.status === 'number' ? response.status : undefined
}

function Preview({ draft }: { readonly draft: TariffConstructorDraft | null }) {
  return <Card className="border-dashed"><CardHeader><CardTitle className="text-lg">Price preview</CardTitle><CardDescription>Client-side preview only. The server remains authoritative for customer quotes.</CardDescription></CardHeader><CardContent>{!draft ? <p className="text-sm text-muted-foreground">Complete a valid draft to see minimum, default, and maximum totals.</p> : <div className="grid gap-3 sm:grid-cols-3">{(['Minimum', 'Default', 'Maximum'] as const).map((label) => <div key={label} className="rounded-lg border bg-muted/30 p-3"><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Preview: {label}</p><div className="mt-2 space-y-1">{draft.durations.map((duration) => <p key={`${duration.days}:${duration.currency}`} className="font-semibold">{duration.days} days: {previewTotal(draft, duration.days, duration.currency, label)} {duration.currency}</p>)}</div></div>)}</div>}</CardContent></Card>
}

function previewTotal(draft: TariffConstructorDraft, days: number, currency: string, label: 'Minimum' | 'Default' | 'Maximum'): string {
  const duration = draft.durations.find((item) => item.days === days && item.currency === currency)
  let total = Number(duration?.baseAmount ?? 0)
  for (const module of draft.modules) {
    const value = label === 'Minimum' ? module.minValue : label === 'Maximum' ? module.maxValue : module.defaultValue
    const price = module.prices.find((item) => item.days === days && item.currency === currency)
    total += ((value - module.minValue) / module.step) * Number(price?.perStepAmount ?? 0)
  }
  return total.toFixed(8).replace(/\.?0+$/, '') || '0'
}
