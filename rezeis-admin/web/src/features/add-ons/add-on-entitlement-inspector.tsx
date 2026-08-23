/**
 * Per-subscription entitlement inspector + the five remediation commands.
 *
 * The Delivery tab above this one is an AGGREGATE: "3 open incidents", "5
 * stranded paid lines", "oldest pending sync 20 min". Every remediation route
 * the backend exposes is per-subscription, per-incident, per-entitlement or
 * per-plan, so an aggregate on its own is a dead end — it tells the operator
 * something is wrong and hands them nothing to do about it.
 *
 * `GET /admin/add-on-entitlements/subscriptions/:id` is the only route that
 * turns a subscription id into the ids the mutating routes need (entitlement,
 * incident, device-plan). It is therefore the hinge: the operator names a
 * subscription once, and every command below acts on a row returned by that
 * one read. The id also round-trips through `?subscription=` so an alert, a
 * runbook or a colleague can link straight to a loaded inspector.
 *
 * Permissions come from the route metadata, not from a guess — see
 * `admin-add-on-entitlements.controller.ts`:
 *   inspect          `add_on_entitlements:view`      (:51)
 *   retry-sync       `add_on_entitlements:run`       (:58)
 *   reconcile        `add_on_entitlements:resolve`   (:79)
 *   acknowledge      `add_on_entitlements:resolve`   (:102)
 *   reverse          `add_on_entitlements:enforce`   (:125)
 *   approve          `add_on_entitlements:moderate`  (:149)
 */
import { useRef, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router'
import { Loader2, RefreshCw, Search, ShieldCheck, Undo2, Wrench } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { getErrorMessage } from '@/lib/http-errors'
import { PermissionGate, type RbacAction } from '@/features/rbac'
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
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'

export const ENTITLEMENT_RESOURCE = 'add_on_entitlements'

interface EntitlementRow {
  id: string
  type: string
  state: string
  lifetime: string
  valuePerUnit: number
  totalValue: string
  currency: string
  totalAmount: string
  purchasedAt: string
  activatedAt: string | null
  expiresAt: string | null
  terminalReason: string | null
  sourceTransactionId: string
  sourceLineKey: string
  catalogRevision: number
}

interface ProjectionInspection {
  desiredRevision: string
  state: string
  desiredTrafficLimitBytes: string | null
  desiredDeviceLimit: number | null
  lastAppliedRevision: string | null
}

interface IncidentInspection {
  id: string
  kind: string
  severity: string
  state: string
  summaryCode: string
  createdAt: string
}

interface DevicePlanInspection {
  id: string
  state: string
  desiredLimit: number
  projectionRevision: string
  targetCount: number
  attempts: number
  /**
   * The machine-readable reason the executor stopped, stamped on the last
   * terminal transition; `null` on a plan that has never failed.
   *
   * Selected and mapped by `AddOnEntitlementInspectionService` — see that
   * service (`lastErrorCode: true` in the `deviceReductionPlan` select,
   * `lastErrorCode: row.lastErrorCode` in the mapping). Declared here only
   * because the wire really carries it.
   */
  lastErrorCode: string | null
}

interface SubscriptionInspection {
  subscriptionId: string
  entitlements: EntitlementRow[]
  projection: ProjectionInspection | null
  incidents: IncidentInspection[]
  deviceReductionPlans: DevicePlanInspection[]
}

type RemediationAction = 'retrySync' | 'reconcile' | 'acknowledge' | 'reverse' | 'approve'

/** The permission each route actually declares. */
const ACTION_PERMISSION: Readonly<Record<RemediationAction, RbacAction>> = {
  retrySync: 'run',
  reconcile: 'resolve',
  acknowledge: 'resolve',
  reverse: 'enforce',
  approve: 'moderate',
}

/**
 * Reversal and approval are consequential and hard to undo — a reversal walks a
 * paid entitlement through the state machine to REVERSED and re-pushes the
 * subscription's limits; an approval force-executes a device-reduction plan,
 * which is the only path in the system that deletes a customer's devices off
 * the panel. Both get a confirmation naming the target.
 *
 * Retry-sync, force-reconcile and acknowledge are converging or clerical:
 * retry re-claims jobs that are already FAILED, reconcile recomputes the
 * projection and is a no-op when nothing changed, acknowledge only moves an
 * incident OPEN → ACKNOWLEDGED. They fire directly.
 */
const NEEDS_CONFIRMATION: ReadonlySet<RemediationAction> = new Set(['reverse', 'approve'])

interface CommandVariables {
  readonly action: RemediationAction
  readonly targetId: string
}

interface PendingConfirmation extends CommandVariables {
  readonly title: string
  readonly body: string
  readonly confirmLabel: string
}

interface CommandResponse {
  retried?: number
  changed?: boolean
  status?: string
  state?: string
  syncJobId?: string | null
}

/**
 * The ONE `DeviceReductionPlanState` an approval is allowed to call a success.
 * It is the only outcome whose post-condition was proved by a strict read-back
 * of the panel; every other 200 the route can return means the override ran and
 * the plan is not applied. Named rather than inlined so the comparison below
 * reads as the claim it is.
 */
const PLAN_APPLIED = 'APPLIED'

type OutcomeTone = 'success' | 'warning' | 'info'

interface CommandOutcome {
  readonly tone: OutcomeTone
  readonly message: string
}

function commandPath(action: RemediationAction, targetId: string): string {
  const base = '/admin/add-on-entitlements'
  switch (action) {
    case 'retrySync':
      return `${base}/subscriptions/${targetId}/retry-sync`
    case 'reconcile':
      return `${base}/subscriptions/${targetId}/reconcile`
    case 'acknowledge':
      return `${base}/incidents/${targetId}/acknowledge`
    case 'reverse':
      return `${base}/entitlements/${targetId}/reverse`
    case 'approve':
      return `${base}/device-plans/${targetId}/approve`
  }
}

/**
 * A command key that survives a retry.
 *
 * `commandKey` is the backend's idempotency key. Minting a fresh one per click
 * would defeat it precisely when it matters: the operator who clicks again
 * because the first attempt timed out means "finish that command", not "run a
 * second one". So the key is minted once per (action, target) and only released
 * once the command is known to have landed.
 */
function newCommandKey(): string {
  const source = globalThis.crypto
  if (source !== undefined && typeof source.randomUUID === 'function') return source.randomUUID()
  return `cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * The reason to put on a plan row, or `null` for "say nothing".
 *
 * Normalised rather than compared against `null` directly. This panel is
 * built from `web/` alone and ships on its own version line, so it can be
 * newer than the API answering it, and a payload from before the field
 * existed carries no key at all — which a strict `!== null` renders as the
 * literal word "undefined" in the operator's reason line. An empty string is
 * refused for the same reason: a label standing over nothing is worse than
 * the blank it replaced.
 *
 * The code itself is passed through UNTRANSLATED, and there is deliberately
 * no per-code dictionary. The executor composes these at runtime —
 * `STRICT_LIST_${listing.kind.toUpperCase()}`,
 * `STRICT_DELETE_${del.kind.toUpperCase()}` — so the set is open and any map
 * would be incomplete on the day it landed. Only the label around the code is
 * localised; the token stays the token the logs, the audit rows and the
 * backend all use.
 */
function blockedReason(plan: DevicePlanInspection): string | null {
  const code = plan.lastErrorCode ?? ''
  return code.length > 0 ? code : null
}

export function AddOnEntitlementInspector({
  inputRef,
}: {
  /** Lets the aggregate counters above focus this field — see the tab. */
  inputRef?: RefObject<HTMLInputElement | null>
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const initialSubscription = searchParams.get('subscription') ?? ''

  const [subscriptionInput, setSubscriptionInput] = useState(initialSubscription)
  const [inspected, setInspected] = useState(initialSubscription)
  const [reason, setReason] = useState('')
  const [confirming, setConfirming] = useState<PendingConfirmation | null>(null)
  const commandKeys = useRef<Map<string, string>>(new Map())

  const inspectQuery = useQuery({
    queryKey: ['admin', 'add-on-entitlements', 'inspect', inspected],
    enabled: inspected.length > 0,
    queryFn: async () =>
      (await api.get<SubscriptionInspection>(`/admin/add-on-entitlements/subscriptions/${inspected}`))
        .data,
  })

  const mutation = useMutation({
    mutationFn: async ({ action, targetId }: CommandVariables) => {
      const slot = `${action}:${targetId}`
      let commandKey = commandKeys.current.get(slot)
      if (commandKey === undefined) {
        commandKey = newCommandKey()
        commandKeys.current.set(slot, commandKey)
      }
      const { data } = await api.post<CommandResponse>(commandPath(action, targetId), {
        reason: reason.trim(),
        commandKey,
      })
      return { action, targetId, data }
    },
    onSuccess: ({ action, targetId, data }) => {
      // Released on ANY recorded answer, not only a happy one. The outcome is
      // stamped on the target row under this key, so re-sending it would replay
      // the frozen answer — a retry after `DEFERRED` has to be a new command.
      commandKeys.current.delete(`${action}:${targetId}`)
      const outcome = describeOutcome(action, data)
      if (outcome.tone === 'success') toast.success(outcome.message)
      else if (outcome.tone === 'warning') toast.warning(outcome.message)
      else toast.info(outcome.message)
      void queryClient.invalidateQueries({ queryKey: ['admin', 'add-on-entitlements'] })
    },
    onError: (error: unknown) => {
      // A decline arrives here, not above: the approve route answers `REFUSED`
      // with 404/409 carrying its own sentence ("...cannot be re-run:
      // PLAN_STATE_APPLIED"), which `getErrorMessage` reads off the body.
      toast.error(getErrorMessage(error, t('addOnsPage.entitlements.inspect.commandFailed')))
    },
  })

  /**
   * What the operator is told, and in what colour.
   *
   * A 2xx from these routes is an ANSWER, not an achievement, and every one of
   * them can answer "nothing happened". `approve` is the dangerous one: the
   * override RAN and reached `DEFERRED` (panel unavailable), `BLOCKED` (the
   * strict adapter refused again and a CRITICAL incident was raised),
   * `SUPERSEDED` (the plan is void and will never run) or
   * `REMEDIATION_REQUIRED` (targets exhausted, still over the limit) just as
   * readily as `APPLIED` — and all five arrive as 200. Painting them green told
   * the operator their override had deleted the devices when it had not, which
   * is worse than offering no button: they close the incident and move on.
   *
   * So only the answer that changed something is a success. The rest are
   * warnings (approve: it ran and did not apply) or information (the clerical
   * and converging commands, whose no-op is expected and harmless). The status
   * itself rides in the message, and the plan/incident rows below re-read on
   * invalidation, so the operator gets the outcome twice over.
   */
  function describeOutcome(action: RemediationAction, data: CommandResponse): CommandOutcome {
    const prefix = 'addOnsPage.entitlements.inspect.outcome'
    switch (action) {
      case 'retrySync': {
        const retried = data.retried ?? 0
        return {
          tone: retried > 0 ? 'success' : 'info',
          message: t(`${prefix}.retried`, { count: retried }),
        }
      }
      case 'reconcile':
        return data.changed === true
          ? { tone: 'success', message: t(`${prefix}.reconciled`) }
          : { tone: 'info', message: t(`${prefix}.reconcileNoop`) }
      case 'acknowledge':
        return data.changed === true
          ? { tone: 'success', message: t(`${prefix}.acknowledged`) }
          : { tone: 'info', message: t(`${prefix}.acknowledgeNoop`) }
      case 'reverse':
        return data.changed === true
          ? { tone: 'success', message: t(`${prefix}.reversed`, { state: data.state ?? '' }) }
          : { tone: 'info', message: t(`${prefix}.reverseNoop`, { state: data.state ?? '' }) }
      case 'approve': {
        const status = data.status ?? ''
        return {
          tone: status === PLAN_APPLIED ? 'success' : 'warning',
          message: t(`${prefix}.approved`, { status }),
        }
      }
    }
  }

  const reasonReady = reason.trim().length >= 3

  function run(variables: CommandVariables, confirmation?: Omit<PendingConfirmation, keyof CommandVariables>) {
    if (!reasonReady) return
    if (confirmation !== undefined && NEEDS_CONFIRMATION.has(variables.action)) {
      setConfirming({ ...variables, ...confirmation })
      return
    }
    mutation.mutate(variables)
  }

  function isRunning(action: RemediationAction, targetId: string): boolean {
    return (
      mutation.isPending &&
      mutation.variables?.action === action &&
      mutation.variables.targetId === targetId
    )
  }

  const data = inspectQuery.data

  return (
    <PermissionGate resource={ENTITLEMENT_RESOURCE} action="view">
      <Card>
        <CardContent className="space-y-4 p-4">
          <div>
            <h3 className="text-sm font-semibold">{t('addOnsPage.entitlements.inspect.title')}</h3>
            <p className="text-xs text-muted-foreground">
              {t('addOnsPage.entitlements.inspect.subtitle')}
            </p>
          </div>

          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              const next = subscriptionInput.trim()
              setInspected(next)
              const params = new URLSearchParams(searchParams)
              if (next.length > 0) params.set('subscription', next)
              else params.delete('subscription')
              setSearchParams(params, { replace: true })
            }}
          >
            <div className="min-w-[16rem] flex-1 space-y-1">
              <Label htmlFor="entitlement-subscription-id">
                {t('addOnsPage.entitlements.inspect.subscriptionLabel')}
              </Label>
              <Input
                id="entitlement-subscription-id"
                ref={inputRef}
                value={subscriptionInput}
                onChange={(event) => setSubscriptionInput(event.target.value)}
                placeholder={t('addOnsPage.entitlements.inspect.subscriptionPlaceholder')}
              />
            </div>
            <Button type="submit" variant="outline">
              <Search className="mr-2 h-4 w-4" />
              {t('addOnsPage.entitlements.inspect.load')}
            </Button>
          </form>

          <div className="space-y-1">
            <Label htmlFor="entitlement-command-reason">
              {t('addOnsPage.entitlements.inspect.reasonLabel')}
            </Label>
            <Input
              id="entitlement-command-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder={t('addOnsPage.entitlements.inspect.reasonPlaceholder')}
            />
            <p className="text-xs text-muted-foreground">
              {t('addOnsPage.entitlements.inspect.reasonHint')}
            </p>
          </div>

          {inspected.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t('addOnsPage.entitlements.inspect.emptyHint')}
            </p>
          ) : inspectQuery.isLoading ? (
            <Skeleton className="h-32 w-full rounded-lg" />
          ) : inspectQuery.isError || data === undefined ? (
            <p className="text-sm text-destructive">
              {t('addOnsPage.entitlements.inspect.loadError')}
            </p>
          ) : (
            <div className="space-y-4">
              {/* ── Projection + the two subscription-scoped commands ───────── */}
              <section className="rounded-lg border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold">
                      {t('addOnsPage.entitlements.inspect.projection.title')}
                    </p>
                    <p className="font-mono text-xs text-muted-foreground">{data.subscriptionId}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <PermissionGate
                      resource={ENTITLEMENT_RESOURCE}
                      action={ACTION_PERMISSION.retrySync}
                    >
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!reasonReady || mutation.isPending}
                        onClick={() => run({ action: 'retrySync', targetId: data.subscriptionId })}
                      >
                        {isRunning('retrySync', data.subscriptionId) ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                          <RefreshCw className="mr-2 h-4 w-4" />
                        )}
                        {t('addOnsPage.entitlements.inspect.actions.retrySync')}
                      </Button>
                    </PermissionGate>
                    <PermissionGate
                      resource={ENTITLEMENT_RESOURCE}
                      action={ACTION_PERMISSION.reconcile}
                    >
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!reasonReady || mutation.isPending}
                        onClick={() => run({ action: 'reconcile', targetId: data.subscriptionId })}
                      >
                        {isRunning('reconcile', data.subscriptionId) ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                          <Wrench className="mr-2 h-4 w-4" />
                        )}
                        {t('addOnsPage.entitlements.inspect.actions.reconcile')}
                      </Button>
                    </PermissionGate>
                  </div>
                </div>
                {data.projection === null ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {t('addOnsPage.entitlements.inspect.projection.none')}
                  </p>
                ) : (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Badge variant="secondary" className="font-mono text-xs">
                      {t('addOnsPage.entitlements.inspect.projection.state')}: {data.projection.state}
                    </Badge>
                    <Badge variant="secondary" className="font-mono text-xs">
                      {t('addOnsPage.entitlements.inspect.projection.desiredRevision')}:{' '}
                      {data.projection.desiredRevision}
                    </Badge>
                    <Badge variant="secondary" className="font-mono text-xs">
                      {t('addOnsPage.entitlements.inspect.projection.appliedRevision')}:{' '}
                      {data.projection.lastAppliedRevision ??
                        t('addOnsPage.entitlements.inspect.projection.never')}
                    </Badge>
                  </div>
                )}
              </section>

              {/* ── Incidents → acknowledge ─────────────────────────────────── */}
              <section className="rounded-lg border p-3">
                <p className="mb-2 text-sm font-semibold">
                  {t('addOnsPage.entitlements.inspect.incidents.title')}
                </p>
                {data.incidents.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {t('addOnsPage.entitlements.inspect.incidents.empty')}
                  </p>
                ) : (
                  <ul className="divide-y">
                    {data.incidents.map((incident) => (
                      <li
                        key={incident.id}
                        className="flex flex-wrap items-center justify-between gap-2 py-2"
                      >
                        <div className="min-w-0">
                          <p className="font-mono text-xs">
                            {incident.kind} · {incident.severity} · {incident.state}
                          </p>
                          <p className="font-mono text-xs text-muted-foreground">
                            {incident.summaryCode} · {incident.id}
                          </p>
                        </div>
                        {incident.state === 'OPEN' ? (
                          <PermissionGate
                            resource={ENTITLEMENT_RESOURCE}
                            action={ACTION_PERMISSION.acknowledge}
                          >
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={!reasonReady || mutation.isPending}
                              aria-label={t(
                                'addOnsPage.entitlements.inspect.incidents.acknowledgeAria',
                                { id: incident.id },
                              )}
                              onClick={() => run({ action: 'acknowledge', targetId: incident.id })}
                            >
                              {isRunning('acknowledge', incident.id) ? (
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                              ) : (
                                <ShieldCheck className="mr-2 h-4 w-4" />
                              )}
                              {t('addOnsPage.entitlements.inspect.incidents.acknowledge')}
                            </Button>
                          </PermissionGate>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {/* ── Entitlement ledger → compensating reversal ──────────────── */}
              <section className="rounded-lg border p-3">
                <p className="mb-2 text-sm font-semibold">
                  {t('addOnsPage.entitlements.inspect.ledger.title')}
                </p>
                {data.entitlements.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {t('addOnsPage.entitlements.inspect.ledger.empty')}
                  </p>
                ) : (
                  <ul className="divide-y">
                    {data.entitlements.map((row) => (
                      <li
                        key={row.id}
                        className="flex flex-wrap items-center justify-between gap-2 py-2"
                      >
                        <div className="min-w-0">
                          <p className="font-mono text-xs">
                            {row.type} · {row.state} · {row.totalAmount} {row.currency}
                          </p>
                          <p className="font-mono text-xs text-muted-foreground">{row.id}</p>
                        </div>
                        {row.state === 'REVERSED' ? null : (
                          <PermissionGate
                            resource={ENTITLEMENT_RESOURCE}
                            action={ACTION_PERMISSION.reverse}
                          >
                            <Button
                              size="sm"
                              variant="outline"
                              className="text-destructive"
                              disabled={!reasonReady || mutation.isPending}
                              aria-label={t('addOnsPage.entitlements.inspect.ledger.reverseAria', {
                                id: row.id,
                              })}
                              onClick={() =>
                                run(
                                  { action: 'reverse', targetId: row.id },
                                  {
                                    title: t('addOnsPage.entitlements.inspect.confirm.reverseTitle'),
                                    body: t('addOnsPage.entitlements.inspect.confirm.reverseBody', {
                                      type: row.type,
                                      amount: `${row.totalAmount} ${row.currency}`,
                                      id: row.id,
                                    }),
                                    confirmLabel: t(
                                      'addOnsPage.entitlements.inspect.confirm.reverseConfirm',
                                    ),
                                  },
                                )
                              }
                            >
                              {isRunning('reverse', row.id) ? (
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                              ) : (
                                <Undo2 className="mr-2 h-4 w-4" />
                              )}
                              {t('addOnsPage.entitlements.inspect.ledger.reverse')}
                            </Button>
                          </PermissionGate>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {/* ── Device-reduction plans → approve ────────────────────────── */}
              <section className="rounded-lg border p-3">
                <p className="mb-2 text-sm font-semibold">
                  {t('addOnsPage.entitlements.inspect.plans.title')}
                </p>
                {data.deviceReductionPlans.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {t('addOnsPage.entitlements.inspect.plans.empty')}
                  </p>
                ) : (
                  <ul className="divide-y">
                    {data.deviceReductionPlans.map((plan) => (
                      <li
                        key={plan.id}
                        className="flex flex-wrap items-center justify-between gap-2 py-2"
                      >
                        <div className="min-w-0">
                          <p className="font-mono text-xs">
                            {plan.state} ·{' '}
                            {t('addOnsPage.entitlements.inspect.plans.targets', {
                              count: plan.targetCount,
                            })}{' '}
                            ·{' '}
                            {t('addOnsPage.entitlements.inspect.plans.desiredLimit', {
                              count: plan.desiredLimit,
                            })}
                          </p>
                          {blockedReason(plan) === null ? null : (
                            <p className="font-mono text-xs font-semibold text-destructive">
                              {t('addOnsPage.entitlements.inspect.plans.lastError', {
                                code: blockedReason(plan),
                              })}
                            </p>
                          )}
                          <p className="font-mono text-xs text-muted-foreground">{plan.id}</p>
                        </div>
                        <PermissionGate
                          resource={ENTITLEMENT_RESOURCE}
                          action={ACTION_PERMISSION.approve}
                        >
                          <Button
                            size="sm"
                            variant="outline"
                            className="text-destructive"
                            disabled={!reasonReady || mutation.isPending}
                            aria-label={t('addOnsPage.entitlements.inspect.plans.approveAria', {
                              id: plan.id,
                            })}
                            onClick={() =>
                              run(
                                { action: 'approve', targetId: plan.id },
                                {
                                  title: t('addOnsPage.entitlements.inspect.confirm.approveTitle'),
                                  body: t('addOnsPage.entitlements.inspect.confirm.approveBody', {
                                    id: plan.id,
                                    count: plan.targetCount,
                                    limit: plan.desiredLimit,
                                  }),
                                  confirmLabel: t(
                                    'addOnsPage.entitlements.inspect.confirm.approveConfirm',
                                  ),
                                },
                              )
                            }
                          >
                            {isRunning('approve', plan.id) ? (
                              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            ) : (
                              <ShieldCheck className="mr-2 h-4 w-4" />
                            )}
                            {t('addOnsPage.entitlements.inspect.plans.approve')}
                          </Button>
                        </PermissionGate>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          )}
        </CardContent>
      </Card>

      <AlertDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirming?.title ?? ''}</AlertDialogTitle>
            <AlertDialogDescription>{confirming?.body ?? ''}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t('addOnsPage.entitlements.inspect.confirm.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (confirming === null) return
                mutation.mutate({ action: confirming.action, targetId: confirming.targetId })
                setConfirming(null)
              }}
            >
              {confirming?.confirmLabel ?? ''}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PermissionGate>
  )
}
