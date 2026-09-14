import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Loader2 } from 'lucide-react'

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
import { cn } from '@/lib/utils'
import { describePlanReferences, PLAN_DELETE_CONSEQUENCE_I18N_KEYS } from './plan-delete'
import { usePlanReferences, type Plan } from './plans-api'

export interface PlanDeleteDialogProps {
  /**
   * The plan the dialog is about. Kept by the page after the dialog closes, so
   * the content does not blank out while it animates away. Its sale flags pick
   * the lead for an unused plan: one still on sale is hidden, not removed.
   */
  readonly plan: Pick<Plan, 'id' | 'name' | 'isActive' | 'isArchived'> | null
  readonly open: boolean
  /** A delete is in flight: both buttons hold, and the dialog cannot be dismissed. */
  readonly deleting: boolean
  readonly onConfirm: (planId: string) => void
  readonly onOpenChange: (open: boolean) => void
}

/**
 * Confirms deleting a plan, and says what the delete will do to it.
 *
 * The delete is never refused (plan-deletion contract v2), so nothing here
 * gates it on the answer: the references are fetched to INFORM the operator.
 * While they load, Delete waits — the point of asking is that the operator sees
 * the answer before confirming. When they cannot be loaded, Delete is released
 * with a warning, because a failed count is no reason to make a delete that the
 * server would accept impossible.
 */
export function PlanDeleteDialog({
  plan,
  open,
  deleting,
  onConfirm,
  onOpenChange,
}: PlanDeleteDialogProps) {
  return (
    <AlertDialog
      open={open && plan !== null}
      onOpenChange={(next) => {
        // Escape must not walk away from a delete whose answer is still coming.
        if (!next && deleting) return
        onOpenChange(next)
      }}
    >
      {plan !== null && (
        <AlertDialogContent>
          {/* Keyed by plan: a different plan starts from a fresh references
              query, never from the previous plan's counts. */}
          <PlanDeleteDialogBody
            key={plan.id}
            plan={plan}
            deleting={deleting}
            onConfirm={onConfirm}
          />
        </AlertDialogContent>
      )}
    </AlertDialog>
  )
}

function PlanDeleteDialogBody({
  plan,
  deleting,
  onConfirm,
}: {
  readonly plan: Pick<Plan, 'id' | 'name' | 'isActive' | 'isArchived'>
  readonly deleting: boolean
  readonly onConfirm: (planId: string) => void
}) {
  const { t } = useTranslation()
  const usedById = useId()
  const references = usePlanReferences(plan.id)
  const impact = references.data === undefined ? null : describePlanReferences(references.data)

  let lead: string
  if (references.isPending) lead = t('plansPage.deleteDialog.checking')
  else if (references.isError) lead = t('plansPage.deleteDialog.checkFailed')
  else if (impact?.keepsPlan === true) lead = t('plansPage.deleteDialog.used')
  // Nothing uses it — and still an unused plan ON SALE is only hidden: the
  // server keeps the row for a checkout that may be writing its invoice right
  // now, and the nightly sweep removes it. "Deleted permanently" is for a plan
  // already off sale.
  else if (plan.isActive && !plan.isArchived)
    lead = t('plansPage.deleteDialog.unusedOnSale', { name: plan.name })
  else lead = t('plansPage.deleteDialog.unused', { name: plan.name })

  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>{t('plansPage.deleteDialog.title', { name: plan.name })}</AlertDialogTitle>
        <AlertDialogDescription
          className={cn(references.isError && 'text-amber-600 dark:text-amber-500')}
        >
          {references.isPending && (
            <Loader2 className="mr-1.5 inline h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          )}
          {references.isError && (
            <AlertTriangle className="mr-1.5 inline h-3.5 w-3.5" aria-hidden="true" />
          )}
          {lead}
        </AlertDialogDescription>
      </AlertDialogHeader>

      {references.isError && (
        <p className="text-sm text-muted-foreground">
          {t('plansPage.deleteDialog.checkFailedHint')}
        </p>
      )}

      {impact !== null && impact.rows.length > 0 && (
        <div className="space-y-3 text-sm">
          <div>
            <p id={usedById} className="font-medium">
              {t('plansPage.deleteDialog.usedBy')}
            </p>
            <ul aria-labelledby={usedById} className="mt-1 list-disc space-y-0.5 pl-5">
              {impact.rows.map((row, index) => (
                <li key={`${index}:${row.kind}`}>
                  {row.recognised
                    ? t(row.i18nKey, { count: row.count })
                    : t(row.i18nKey, { kind: row.kind, count: row.count })}
                </li>
              ))}
            </ul>
          </div>
          {/* Shown whenever there is something to say, not only when the plan
              lingers: an archived plan left with no replacement changes other
              subscribers' renewals even though nothing holds this plan. The
              cleanup line is about the kept row, so it needs one. */}
          {(impact.keepsPlan || impact.consequences.length > 0) && (
            <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
              {impact.consequences.map((consequence) => (
                <li key={consequence}>{t(PLAN_DELETE_CONSEQUENCE_I18N_KEYS[consequence])}</li>
              ))}
              {impact.keepsPlan && <li>{t('plansPage.deleteDialog.consequences.cleanup')}</li>}
            </ul>
          )}
        </div>
      )}

      <AlertDialogFooter>
        <AlertDialogCancel disabled={deleting}>{t('common.cancel')}</AlertDialogCancel>
        <AlertDialogAction
          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          disabled={deleting || references.isPending}
          onClick={(event) => {
            // Radix closes the dialog on Action by default. It stays open until
            // the server answers, so a failure is reported over the dialog the
            // operator is still looking at rather than after it has vanished.
            event.preventDefault()
            onConfirm(plan.id)
          }}
        >
          {deleting && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
          {t('plansPage.deleteDialog.confirm')}
        </AlertDialogAction>
      </AlertDialogFooter>
    </>
  )
}
