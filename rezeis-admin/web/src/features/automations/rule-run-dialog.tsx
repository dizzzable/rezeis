import * as React from 'react'
import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { AlertTriangle, CheckCircle2, Clock, Loader2, Search, X, XCircle } from 'lucide-react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from '@/components/ui/dialog'
import { InfoTip } from '@/components/ui/info-tip'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useHasPermission } from '@/features/rbac/permission-gate'
import { listUserHints, type UserHint } from '@/features/user-hints/user-hints-api'
import { translateApiError } from '@/lib/translate-error'

import { runRuleManually, type AutomationRule } from './automations-api'
import { actionLabel } from './rule-action-labels'
import { ButtonTip } from './rule-button-tip'
import {
  customerDetail,
  customerName,
  customerSearchTerm,
  searchCustomers,
  type RunCustomer,
} from './run-customer-search'
import { actionResultText, executionNoteText, runHadNoAnswer } from './run-result-copy'
import { ExecutionStatusBadge } from './run-status-badge'

/**
 * «Запустить сейчас» for a rule that shows a hint: a test run for ONE customer.
 *
 * ── Why a dialog, and not the old immediate run ──────────────────────────────
 *
 * The button posted a run with nobody in it. `show_hint` shows its hint to the
 * customer the trigger names, a manual run named none, and so every press
 * marked the rule «ОШИБКА» — the one button an operator reaches for to see a
 * pop-up could only ever fail. The owner pressed it on a freshly built welcome
 * and read that his rule was broken.
 *
 * So the operator picks the customer, and the dialog says, before anything
 * runs, everything the press will do: the hint it queues and where that hint
 * may appear, every other action that runs with it (a block included), and the
 * two things that make a test run differ from a real one — the switch, which a
 * manual run ignores, and conditions, which a run carrying only a customer will
 * rarely match.
 *
 * ── «Показать, даже если уже показывалась» ───────────────────────────────────
 *
 * On by default. Most pop-ups are once-only, and the operator testing one is
 * almost always testing it on an account that has already had it — without the
 * box the test answers "already delivered" and shows nothing. It travels as
 * `showAgain` beside the trigger, for this run only (contract §1).
 *
 * ── A run in flight cannot be walked away from ───────────────────────────────
 *
 * Closing the dialog starts it over, and it used to close on Escape, a click
 * outside or its X while the run was still out: the answer was thrown away, and
 * the dialog opened again offered «Запустить» for a second run beside the first.
 * So while a run is out, nothing closes it.
 *
 * ── And a run that went unanswered is not offered again ──────────────────────
 *
 * A run executes inside its request. A request that timed out, or got no
 * answer at all, may belong to a run that is still going — its execution row
 * will say how it ended — so the dialog says that and offers only «Готово».
 */
export function RuleRunDialog({
  open,
  onOpenChange,
  rule,
  returnFocusTo,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  /** The rule as SAVED — a run executes what is on the server, not the draft. */
  readonly rule: AutomationRule
  /**
   * The button this dialog was opened from, to give keyboard focus back to.
   *
   * Radix restores focus to its own `DialogTrigger`, and this dialog is opened
   * by a plain button instead — so its restore had nothing to focus and the
   * operator was dropped on the page body, at the top of the tab order.
   */
  readonly returnFocusTo?: React.RefObject<HTMLButtonElement | null>
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const mayListCustomers = useHasPermission('users', 'view')
  const searchId = useId()
  const showAgainId = useId()

  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [customer, setCustomer] = useState<RunCustomer | null>(null)
  const [showAgain, setShowAgain] = useState(true)

  // One request per pause in typing, not per keystroke, against the users table.
  // The term drops a leading "@": handles are shown with one and stored without.
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(customerSearchTerm(search)), 250)
    return () => clearTimeout(timer)
  }, [search])

  const customersQuery = useQuery({
    queryKey: ['admin', 'users', 'rule-run-picker', debounced],
    queryFn: ({ signal }) => searchCustomers(debounced, signal),
    enabled: open && mayListCustomers && customer === null && debounced.length > 0,
    staleTime: 15_000,
  })

  const hintsQuery = useQuery({
    queryKey: ['admin', 'user-hints'],
    queryFn: listUserHints,
    staleTime: 5 * 60 * 1000,
    enabled: open,
  })

  const run = useMutation({
    mutationFn: (chosen: RunCustomer) =>
      runRuleManually(rule.id, { userId: chosen.id }, { showAgain }),
    // The run writes an execution row and the rule's run columns, whatever it
    // answered — the log and the header should show it either way.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'automations'] })
    },
  })

  function close(next: boolean): void {
    // Nothing closes a dialog whose run is still out — see the header. Escape,
    // a click outside and the X all come through here, and the dialog is
    // controlled, so declining is enough to keep it open.
    if (!next && run.isPending) return
    onOpenChange(next)
    if (next) return
    // A dialog opened again starts over: nobody chosen, nothing answered.
    setSearch('')
    setDebounced('')
    setCustomer(null)
    setShowAgain(true)
    run.reset()
  }

  /**
   * A refusal belongs to the choice it answered. Changing whom to run for, or
   * whether a shown hint may show again, is a new question — and the old
   * refusal left above it reads as the answer to that one. Picking a customer
   * always follows «Сменить», which has already forgotten it.
   */
  function forgetAnswer(): void {
    if (!run.isPending) run.reset()
  }

  const hintKeys = [
    ...new Set(
      rule.actions
        .filter((action) => action.type === 'show_hint')
        .map((action) =>
          typeof action.params?.hintKey === 'string' ? action.params.hintKey.trim() : '',
        )
        .filter((key) => key.length > 0),
    ),
  ]
  const others = rule.actions.filter((action) => action.type !== 'show_hint')
  const otherLabels = [...new Set(others.map((action) => actionLabel(t, action.type)))]
  const hasConditions =
    rule.conditions !== null &&
    typeof rule.conditions === 'object' &&
    Object.keys(rule.conditions as Record<string, unknown>).length > 0

  const result = run.data
  const unanswered = run.isError && runHadNoAnswer(run.error)
  const canRun = mayListCustomers && customer !== null && !run.isPending
  /** Why «Запустить» cannot be pressed, or what pressing it does. */
  const runTip = !mayListCustomers
    ? t('automationsPage.runDialog.runTipForbidden')
    : run.isPending
      ? t('automationsPage.runDialog.runTipRunning')
      : customer === null
        ? t('automationsPage.runDialog.runTipNoCustomer')
        : t('automationsPage.runDialog.runTip')

  return (
    <Dialog open={open} onOpenChange={close}>
      {/* The content of `components/ui/dialog.tsx`, with a close button that a
          run in flight can disable — that one's X cannot be. */}
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Content
          onCloseAutoFocus={(event) => {
            const opener = returnFocusTo?.current
            if (opener === null || opener === undefined) return
            event.preventDefault()
            opener.focus()
          }}
          className="fixed left-[50%] top-[50%] z-50 grid max-h-[90vh] w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 overflow-y-auto border bg-background p-6 shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] sm:max-w-xl sm:rounded-lg"
        >
        <DialogHeader>
          <DialogTitle>{t('automationsPage.runDialog.title', { name: rule.name })}</DialogTitle>
          <DialogDescription>{t('automationsPage.runDialog.what')}</DialogDescription>
        </DialogHeader>

        {unanswered ? (
          <Alert>
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            <AlertDescription>{t('automationsPage.runDialog.noAnswer')}</AlertDescription>
          </Alert>
        ) : result === undefined ? (
          <div className="space-y-4">
            {(!rule.isEnabled || hasConditions) && (
              <div className="space-y-1.5">
                {!rule.isEnabled && (
                  <Note>{t('automationsPage.runDialog.disabledNote')}</Note>
                )}
                {hasConditions && <Note>{t('automationsPage.runDialog.conditionsNote')}</Note>}
              </div>
            )}

            <HintSummary keys={hintKeys} hints={hintsQuery.data} />

            {others.length > 0 && (
              <div className="space-y-1.5 text-sm">
                <p>{t('automationsPage.runDialog.alsoRuns', { actions: otherLabels.join(', ') })}</p>
                {others.some((action) => action.type === 'block_user') && (
                  <p className="flex items-start gap-1.5 text-destructive">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    <span>
                      {others
                        .filter((action) => action.type === 'block_user')
                        .map((action) => {
                          const pinned =
                            typeof action.params?.userId === 'string' ? action.params.userId.trim() : ''
                          return pinned.length > 0
                            ? t('automationsPage.runDialog.blocksNamedUser', { userId: pinned })
                            : t('automationsPage.runDialog.blocksCustomer')
                        })
                        .filter((line, index, lines) => lines.indexOf(line) === index)
                        .join(' ')}
                    </span>
                  </p>
                )}
                {others.some((action) => action.type === 'show_hint_to_audience') && (
                  <Note>{t('automationsPage.runDialog.audienceAll')}</Note>
                )}
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor={searchId}>{t('automationsPage.runDialog.customerLabel')}</Label>
              {!mayListCustomers ? (
                <p className="text-sm text-muted-foreground">{t('automationsPage.runDialog.forbidden')}</p>
              ) : customer !== null ? (
                <div className="flex items-center gap-2 rounded-md border px-3 py-2">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{customerName(customer)}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {customerDetail(customer)}
                    </span>
                  </span>
                  <ButtonTip
                    tip={
                      run.isPending
                        ? t('automationsPage.runDialog.runTipRunning')
                        : t('automationsPage.runDialog.changeTip')
                    }
                    disabled={run.isPending}
                  >
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        forgetAnswer()
                        setCustomer(null)
                      }}
                      disabled={run.isPending}
                    >
                      {t('automationsPage.runDialog.change')}
                    </Button>
                  </ButtonTip>
                </div>
              ) : (
                <>
                  <div className="relative">
                    <Search
                      className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <Input
                      id={searchId}
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder={t('automationsPage.runDialog.searchPlaceholder')}
                      className="pl-8"
                      autoComplete="off"
                    />
                  </div>
                  <CustomerResults
                    typed={debounced.length > 0}
                    loading={customersQuery.isFetching}
                    error={customersQuery.error}
                    customers={customersQuery.data}
                    onPick={setCustomer}
                  />
                </>
              )}
            </div>

            <div className="flex items-center gap-2">
              <Checkbox
                id={showAgainId}
                checked={showAgain}
                onCheckedChange={(value) => {
                  forgetAnswer()
                  setShowAgain(value === true)
                }}
                disabled={run.isPending}
              />
              <Label htmlFor={showAgainId} className="text-sm font-normal">
                {t('automationsPage.runDialog.showAgain')}
              </Label>
              <InfoTip
                label={t('automationsPage.infoAria', {
                  subject: t('automationsPage.runDialog.showAgain'),
                })}
              >
                {t('automationsPage.runDialog.showAgainInfo')}
              </InfoTip>
            </div>

            {run.isError && (
              <Alert variant="destructive">
                <AlertDescription>
                  {t('automationsPage.toast.runFailed', { message: translateApiError(t, run.error) })}
                </AlertDescription>
              </Alert>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <p className="flex items-center gap-2 text-sm font-medium">
              {t('automationsPage.runDialog.resultTitle')}
              <ExecutionStatusBadge status={result.status} />
            </p>
            {result.actionResults.length === 0 ? (
              executionNoteText(t, result.errorMessage) !== null && (
                <p className="text-sm text-muted-foreground">{executionNoteText(t, result.errorMessage)}</p>
              )
            ) : (
              <ul className="space-y-1.5 text-sm">
                {result.actionResults.map((entry) => (
                  <li key={entry.index} className="flex items-start gap-2">
                    {entry.status === 'success' ? (
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-500" aria-hidden="true" />
                    ) : entry.status === 'failed' ? (
                      <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
                    ) : (
                      <Clock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    )}
                    <span>
                      <span className="font-medium">{actionLabel(t, entry.type)}</span>
                      {actionResultText(t, entry) !== null && <> — {actionResultText(t, entry)}</>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          {result === undefined && !unanswered ? (
            <>
              <ButtonTip
                tip={
                  run.isPending
                    ? t('automationsPage.runDialog.runTipRunning')
                    : t('automationsPage.runDialog.cancelTip')
                }
                disabled={run.isPending}
              >
                <Button variant="outline" onClick={() => close(false)} disabled={run.isPending}>
                  {t('common.cancel')}
                </Button>
              </ButtonTip>
              <ButtonTip tip={runTip} disabled={!canRun}>
                <Button onClick={() => customer !== null && run.mutate(customer)} disabled={!canRun}>
                  {run.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
                  {t('automationsPage.runDialog.run')}
                </Button>
              </ButtonTip>
            </>
          ) : (
            <ButtonTip tip={t('automationsPage.runDialog.doneTip')}>
              <Button onClick={() => close(false)}>{t('automationsPage.runDialog.done')}</Button>
            </ButtonTip>
          )}
        </DialogFooter>

        {/* The X says why it cannot be pressed, like every other control here. */}
        <ButtonTip
          tip={
            run.isPending
              ? t('automationsPage.runDialog.runTipRunning')
              : t('automationsPage.runDialog.cancelTip')
          }
          disabled={run.isPending}
          className="absolute right-4 top-4"
          side="left"
        >
          <DialogPrimitive.Close asChild>
            <button
              type="button"
              disabled={run.isPending}
              className="rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none disabled:opacity-30"
            >
              <X className="h-4 w-4" aria-hidden="true" />
              <span className="sr-only">{t('common.close')}</span>
            </button>
          </DialogPrimitive.Close>
        </ButtonTip>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  )
}

function Note({ children }: { readonly children: string }) {
  return (
    <p className="flex items-start gap-1.5 text-sm text-amber-600 dark:text-amber-400">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </p>
  )
}

/** Each hint the rule shows: what it is and where it may appear, or what is wrong with it. */
function HintSummary({
  keys,
  hints,
}: {
  readonly keys: readonly string[]
  /** `undefined` while the library is loading — nothing is called missing before it has been read. */
  readonly hints: readonly UserHint[] | undefined
}) {
  const { t } = useTranslation()
  if (keys.length === 0 || hints === undefined) return null
  const place = (group: 'surfaces' | 'formFactors', value: string): string =>
    String(t(`userHints.${group}.${value}`, { defaultValue: value }))
  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium">{t('automationsPage.runDialog.hintsLabel')}</p>
      <ul className="space-y-1 text-sm">
        {keys.map((key) => {
          const hint = hints.find((candidate) => candidate.key === key)
          if (hint === undefined) {
            return (
              <li key={key}>
                <Note>{t('automationsPage.runDialog.hintMissing', { key })}</Note>
              </li>
            )
          }
          if (!hint.isActive) {
            return (
              <li key={key}>
                <Note>{t('automationsPage.runDialog.hintOff', { title: hint.titleRu })}</Note>
              </li>
            )
          }
          const where = [
            hint.surfaces.map((surface) => place('surfaces', surface)).join(', '),
            hint.formFactors.map((factor) => place('formFactors', factor)).join(', '),
          ].filter((part) => part.length > 0)
          return (
            <li key={key} className="text-muted-foreground">
              {t('automationsPage.runDialog.hintLine', {
                title: hint.titleRu,
                mode: String(
                  t(`automationsPage.runDialog.modes.${hint.mode}`, { defaultValue: hint.mode }),
                ),
                where: where.length > 0 ? where.join(' · ') : t('automationsPage.runDialog.everywhere'),
              })}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function CustomerResults({
  typed,
  loading,
  error,
  customers,
  onPick,
}: {
  readonly typed: boolean
  readonly loading: boolean
  readonly error: unknown
  readonly customers: readonly RunCustomer[] | undefined
  readonly onPick: (customer: RunCustomer) => void
}) {
  const { t } = useTranslation()
  if (!typed) {
    return <p className="text-xs text-muted-foreground">{t('automationsPage.runDialog.searchPrompt')}</p>
  }
  if (error) {
    return (
      <p className="text-xs text-destructive">
        {t('automationsPage.runDialog.searchFailed', { message: translateApiError(t, error) })}
      </p>
    )
  }
  if (customers === undefined || (loading && customers.length === 0)) {
    return <p className="text-xs text-muted-foreground">{t('automationsPage.runDialog.searching')}</p>
  }
  if (customers.length === 0) {
    return <p className="text-xs text-muted-foreground">{t('automationsPage.runDialog.noCustomers')}</p>
  }
  return (
    <ul className="divide-y rounded-md border">
      {customers.map((candidate) => (
        <li key={candidate.id}>
          <button
            type="button"
            className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-muted/60"
            onClick={() => onPick(candidate)}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{customerName(candidate)}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {customerDetail(candidate)}
              </span>
            </span>
            {candidate.isBlocked && (
              <Badge variant="destructive" className="shrink-0">
                {t('automationsPage.runDialog.blocked')}
              </Badge>
            )}
          </button>
        </li>
      ))}
    </ul>
  )
}
