import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Loader2, Lock } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { getErrorMessage } from '@/lib/http-errors'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useHasPermission } from '@/features/rbac'

/** The page's three switches, in the order the server sends and draws them. */
export type AddOnSwitchName = 'durableAccounting' | 'deviceCleanupAuto' | 'trafficResetExpiry'

/** One switch as `GET /admin/add-on-settings` describes it. */
export interface AddOnSwitchState {
  readonly name: AddOnSwitchName
  /** ON for every stage it carries: what the panel runs with right now. */
  readonly enabled: boolean
  readonly defaultEnabled: boolean
  /** The operator's own value, or `null` while never set. */
  readonly stored: boolean | null
  /** Explicit `.env` values deciding it instead; any one of them locks the switch. */
  readonly env: ReadonlyArray<{ readonly variable: string; readonly enabled: boolean }>
}

interface AddOnSwitchesView {
  readonly switches: readonly AddOnSwitchState[]
}

const SWITCH_NAMES: readonly AddOnSwitchName[] = ['durableAccounting', 'deviceCleanupAuto', 'trafficResetExpiry']

/**
 * What the confirmation says switching each one off does NOT undo, by key —
 * the owner's rule: turning a switch off is never a silent rollback.
 */
const KEEPS: Readonly<Record<AddOnSwitchName, readonly string[]>> = {
  durableAccounting: ['keep1', 'keep2', 'keep3'],
  deviceCleanupAuto: ['keep1', 'keep2'],
  trafficResetExpiry: ['keep1'],
}

/** A view the server sent, or `null` for anything that is not one. */
function readView(data: unknown): AddOnSwitchesView | null {
  if (typeof data !== 'object' || data === null) return null
  const switches = (data as { switches?: unknown }).switches
  if (!Array.isArray(switches)) return null
  const known = switches.filter(
    (entry): entry is AddOnSwitchState =>
      typeof entry === 'object' &&
      entry !== null &&
      SWITCH_NAMES.includes((entry as { name?: unknown }).name as AddOnSwitchName) &&
      typeof (entry as { enabled?: unknown }).enabled === 'boolean' &&
      Array.isArray((entry as { env?: unknown }).env),
  )
  return { switches: known }
}

function errorCode(error: unknown): string | null {
  const code = (error as { response?: { data?: { code?: unknown } } } | null)?.response?.data?.code
  return typeof code === 'string' ? code : null
}

/**
 * «Доп. услуги» → «Настройки»: the switches of the durable add-on model.
 *
 * A switch `.env` decides is shown as it runs and locked, naming the variable
 * and the way out. Turning one OFF asks first, saying what it changes and what
 * it does NOT undo; the server refuses an unconfirmed switch-off as well
 * (`confirmOff`), so the dialog is not the only guard.
 */
export function AddOnSwitchesCard() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const canEdit = useHasPermission('add_ons', 'edit')
  const [confirming, setConfirming] = useState<AddOnSwitchName | null>(null)

  const query = useQuery({
    queryKey: ['admin', 'add-on-settings'],
    queryFn: async () => readView((await api.get<unknown>('/admin/add-on-settings')).data),
  })

  const mutation = useMutation({
    mutationFn: async (input: { readonly name: AddOnSwitchName; readonly enabled: boolean }) =>
      readView(
        (
          await api.patch<unknown>('/admin/add-on-settings', {
            [input.name]: input.enabled,
            ...(input.enabled ? {} : { confirmOff: true }),
          })
        ).data,
      ),
    onSuccess: (view) => {
      if (view !== null) queryClient.setQueryData(['admin', 'add-on-settings'], view)
      else void queryClient.invalidateQueries({ queryKey: ['admin', 'add-on-settings'] })
      toast.success(t('addOnSwitches.saved'))
    },
    onError: (error) => {
      const code = errorCode(error)
      toast.error(
        code === 'ADD_ON_SWITCH_SET_IN_ENV'
          ? t('addOnSwitches.errors.setInEnv')
          : code === 'ADD_ON_SWITCH_OFF_NOT_CONFIRMED'
            ? t('addOnSwitches.errors.offNotConfirmed')
            : getErrorMessage(error, t('addOnSwitches.saveFailed')),
      )
      void queryClient.invalidateQueries({ queryKey: ['admin', 'add-on-settings'] })
    },
  })

  function onToggle(name: AddOnSwitchName, next: boolean): void {
    if (next) mutation.mutate({ name, enabled: true })
    else setConfirming(name)
  }

  const view = query.data ?? null
  const confirmingLabel = confirming === null ? '' : t(`addOnSwitches.switches.${confirming}.label`)

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <div className="space-y-1">
          <h2 className="text-base font-semibold">{t('addOnSwitches.title')}</h2>
          <p className="text-sm text-muted-foreground">{t('addOnSwitches.subtitle')}</p>
        </div>

        {query.isLoading ? (
          <div className="space-y-3">
            {SWITCH_NAMES.map((name) => (
              <Skeleton key={name} className="h-16 w-full rounded-lg" />
            ))}
          </div>
        ) : view === null ? (
          <div className="flex items-center justify-between gap-3 rounded-lg border p-3 text-sm">
            <span className="text-muted-foreground">{t('addOnSwitches.loadFailed')}</span>
            <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
              {t('addOnSwitches.retry')}
            </Button>
          </div>
        ) : (
          <div className="divide-y rounded-lg border">
            {view.switches.map((state) => {
              const locked = state.env.length > 0
              const id = `add-on-switch-${state.name}`
              const pending = mutation.isPending && mutation.variables?.name === state.name
              return (
                <div key={state.name} className="flex items-start justify-between gap-4 p-3">
                  <div className="min-w-0 space-y-1">
                    <Label htmlFor={id} className="text-sm font-medium">
                      {t(`addOnSwitches.switches.${state.name}.label`)}
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      {t(`addOnSwitches.switches.${state.name}.description`)}
                    </p>
                    {state.name === 'trafficResetExpiry' ? (
                      <p className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-500">
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        <span>{t('addOnSwitches.switches.trafficResetExpiry.caution')}</span>
                      </p>
                    ) : null}
                    <p className="text-[11px] text-muted-foreground">
                      {state.defaultEnabled ? t('addOnSwitches.defaultOn') : t('addOnSwitches.defaultOff')}
                    </p>
                    {locked ? (
                      <div className="space-y-0.5 text-xs">
                        <p className="flex items-center gap-1.5 font-medium">
                          <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                          <span>
                            {t('addOnSwitches.setInEnv', {
                              variables: state.env
                                .map((entry) => `${entry.variable}=${entry.enabled ? 'true' : 'false'}`)
                                .join(', '),
                            })}
                          </span>
                        </p>
                        <p className="text-muted-foreground">{t('addOnSwitches.setInEnvHint')}</p>
                      </div>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-2 pt-0.5">
                    {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                    <Switch
                      id={id}
                      checked={state.enabled}
                      disabled={locked || !canEdit || mutation.isPending}
                      onCheckedChange={(next) => onToggle(state.name, next)}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {view !== null && !canEdit ? (
          <p className="text-xs text-muted-foreground">{t('addOnSwitches.noPermission')}</p>
        ) : null}
      </CardContent>

      <AlertDialog open={confirming !== null} onOpenChange={(open) => (open ? undefined : setConfirming(null))}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('addOnSwitches.confirmOff.title', { label: confirmingLabel })}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-sm">
                {confirming === null ? null : (
                  <>
                    <div className="space-y-1">
                      <p className="font-medium text-foreground">{t('addOnSwitches.confirmOff.doesTitle')}</p>
                      <p>{t(`addOnSwitches.confirmOff.${confirming}.does`)}</p>
                    </div>
                    <div className="space-y-1">
                      <p className="font-medium text-foreground">{t('addOnSwitches.confirmOff.keepsTitle')}</p>
                      <ul className="list-disc space-y-1 pl-5">
                        {KEEPS[confirming].map((key) => (
                          <li key={key}>{t(`addOnSwitches.confirmOff.${confirming}.${key}`)}</li>
                        ))}
                      </ul>
                    </div>
                  </>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('addOnSwitches.confirmOff.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirming !== null) mutation.mutate({ name: confirming, enabled: false })
                setConfirming(null)
              }}
            >
              {t('addOnSwitches.confirmOff.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
