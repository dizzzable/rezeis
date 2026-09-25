import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Loader2, Lock } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { getErrorMessage } from '@/lib/http-errors'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
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
import { formatUtcOffset, isAcceptableTimeZone, utcTime } from './remnawave-time-zone'

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

/** «Часовой пояс Remnawave» as the server describes it. */
export interface RemnawaveTimeZoneState {
  /** The zone the panel predicts Remnawave's resets in now: the stored one, or UTC. */
  readonly value: string
  /** The operator's own value, or `null` while never set. */
  readonly stored: string | null
}

/** The strategies Remnawave resets on a schedule. */
export type ScheduledStrategy = 'DAY' | 'WEEK' | 'MONTH' | 'MONTH_ROLLING'

const SCHEDULED_STRATEGIES: readonly ScheduledStrategy[] = ['DAY', 'WEEK', 'MONTH', 'MONTH_ROLLING']

/** One scheduled run of Remnawave's at a time the zone does not predict. */
export interface ResetScheduleMismatch {
  readonly strategy: ScheduledStrategy
  readonly observedAt: string
  readonly expectedAt: string
  readonly impliedUtcOffsetMinutes: number
}

/** The daily check's verdict, judged when the page asked. */
export interface ResetScheduleVerdict {
  readonly status: 'ok' | 'mismatch' | 'no_data' | 'nothing_to_check'
  readonly timeZone: string
  readonly mismatches: readonly ResetScheduleMismatch[]
}

interface AddOnSwitchesView {
  readonly switches: readonly AddOnSwitchState[]
  /** `null` from a panel that predates the zone setting: the field is not drawn. */
  readonly remnawaveTimeZone: RemnawaveTimeZoneState | null
  readonly resetScheduleCheck: ResetScheduleVerdict | null
}

const SWITCH_NAMES: readonly AddOnSwitchName[] = ['durableAccounting', 'deviceCleanupAuto', 'trafficResetExpiry']

function readZone(data: unknown): RemnawaveTimeZoneState | null {
  if (typeof data !== 'object' || data === null) return null
  const value = (data as { value?: unknown }).value
  const stored = (data as { stored?: unknown }).stored
  if (typeof value !== 'string') return null
  return { value, stored: typeof stored === 'string' ? stored : null }
}

function readVerdict(data: unknown): ResetScheduleVerdict | null {
  if (typeof data !== 'object' || data === null) return null
  const { status, timeZone, mismatches } = data as { status?: unknown; timeZone?: unknown; mismatches?: unknown }
  if (status !== 'ok' && status !== 'mismatch' && status !== 'no_data' && status !== 'nothing_to_check') return null
  const known = Array.isArray(mismatches)
    ? mismatches.filter(
        (entry): entry is ResetScheduleMismatch =>
          typeof entry === 'object' &&
          entry !== null &&
          SCHEDULED_STRATEGIES.includes((entry as { strategy?: unknown }).strategy as ScheduledStrategy) &&
          typeof (entry as { observedAt?: unknown }).observedAt === 'string' &&
          typeof (entry as { expectedAt?: unknown }).expectedAt === 'string' &&
          typeof (entry as { impliedUtcOffsetMinutes?: unknown }).impliedUtcOffsetMinutes === 'number',
      )
    : []
  return { status, timeZone: typeof timeZone === 'string' ? timeZone : '', mismatches: known }
}

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
  return {
    switches: known,
    remnawaveTimeZone: readZone((data as { remnawaveTimeZone?: unknown }).remnawaveTimeZone),
    resetScheduleCheck: readVerdict((data as { resetScheduleCheck?: unknown }).resetScheduleCheck),
  }
}

/**
 * What a switch `.env` decides will be once that line is deleted and the panel
 * restarted — the server's own order (`resolveVariable`): the value saved in
 * the panel, or, when none was saved, the default. When that turns ON a
 * switch the line now holds OFF, the operator is told how to keep it off: the
 * move into the new accounting, for one, cannot be undone.
 */
function describeAfterEnvLine(state: AddOnSwitchState, t: TFunction): string {
  const panelValue = state.stored ?? state.defaultEnabled
  const value = t(panelValue ? 'addOnSwitches.valueOn' : 'addOnSwitches.valueOff')
  const after =
    state.stored === null
      ? t('addOnSwitches.setInEnvAfterDefault', { value })
      : t('addOnSwitches.setInEnvAfterStored', { value })
  return !state.enabled && panelValue ? `${after} ${t('addOnSwitches.setInEnvKeepOff')}` : after
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
                        <p className="text-muted-foreground">{describeAfterEnvLine(state, t)}</p>
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

        {view !== null && view.remnawaveTimeZone !== null ? (
          <RemnawaveTimeZoneField zone={view.remnawaveTimeZone} verdict={view.resetScheduleCheck} canEdit={canEdit} />
        ) : null}

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

/**
 * «Часовой пояс Remnawave»: the zone Remnawave's scheduler resets traffic in,
 * which no API of Remnawave's states — the operator names it. Checked here as
 * the server checks it (a name this browser knows, or empty for UTC), and the
 * daily check's warning is drawn beside it: what Remnawave did, what this
 * zone predicts, and the zone that would explain the difference.
 */
function RemnawaveTimeZoneField(props: {
  readonly zone: RemnawaveTimeZoneState
  readonly verdict: ResetScheduleVerdict | null
  readonly canEdit: boolean
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  // `null` while untouched: the field shows what is stored.
  const [draft, setDraft] = useState<string | null>(null)
  const value = draft ?? props.zone.stored ?? ''
  const valid = isAcceptableTimeZone(value)
  const unchanged = value.trim() === (props.zone.stored ?? '')

  const mutation = useMutation({
    mutationFn: async (next: string) =>
      readView((await api.patch<unknown>('/admin/add-on-settings', { remnawaveTimeZone: next })).data),
    onSuccess: (view) => {
      if (view !== null) queryClient.setQueryData(['admin', 'add-on-settings'], view)
      else void queryClient.invalidateQueries({ queryKey: ['admin', 'add-on-settings'] })
      setDraft(null)
      toast.success(t('addOnSwitches.remnawaveTimeZone.saved'))
    },
    onError: (error) => {
      toast.error(getErrorMessage(error, t('addOnSwitches.saveFailed')))
    },
  })

  const id = 'add-on-remnawave-time-zone'
  const mismatches = props.verdict?.status === 'mismatch' ? props.verdict.mismatches : []

  return (
    <div className="space-y-2 rounded-lg border p-3">
      <Label htmlFor={id} className="text-sm font-medium">
        {t('addOnSwitches.remnawaveTimeZone.label')}
      </Label>
      <p className="text-xs text-muted-foreground">{t('addOnSwitches.remnawaveTimeZone.hint')}</p>
      <form
        className="flex flex-wrap items-start gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (valid && !unchanged) mutation.mutate(value.trim())
        }}
      >
        <div className="min-w-0 flex-1 space-y-1">
          <Input
            id={id}
            value={value}
            placeholder={t('addOnSwitches.remnawaveTimeZone.placeholder')}
            disabled={!props.canEdit || mutation.isPending}
            aria-invalid={!valid}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setDraft(event.target.value)}
          />
          {!valid ? (
            <p role="alert" className="text-xs text-destructive">
              {t('addOnSwitches.remnawaveTimeZone.invalid')}
            </p>
          ) : props.zone.stored === null && draft === null ? (
            <p className="text-[11px] text-muted-foreground">{t('addOnSwitches.remnawaveTimeZone.defaultValue')}</p>
          ) : null}
        </div>
        <Button type="submit" size="sm" disabled={!props.canEdit || !valid || unchanged || mutation.isPending}>
          {mutation.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
          {t('addOnSwitches.remnawaveTimeZone.save')}
        </Button>
      </form>
      {mismatches.length > 0 ? (
        <div
          role="status"
          className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-400"
        >
          <p className="flex items-center gap-1.5 font-medium">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{t('addOnSwitches.remnawaveTimeZone.mismatchTitle')}</span>
          </p>
          {mismatches.map((mismatch) => (
            <p key={mismatch.strategy}>
              {t('addOnSwitches.remnawaveTimeZone.mismatchLine', {
                strategy: t(`addOnSwitches.remnawaveTimeZone.strategies.${mismatch.strategy}`),
                observed: utcTime(mismatch.observedAt),
                expected: utcTime(mismatch.expectedAt),
                offset: formatUtcOffset(mismatch.impliedUtcOffsetMinutes),
              })}
            </p>
          ))}
          <p>{t('addOnSwitches.remnawaveTimeZone.mismatchHint')}</p>
        </div>
      ) : null}
    </div>
  )
}
