import { useId } from 'react'
import { useTranslation } from 'react-i18next'

import { PLAN_DELETE_CONSEQUENCE_I18N_KEYS, type PlanDeleteImpact } from './plan-delete'

/**
 * «Сейчас используется:» — what still uses the plan — and the lines saying what
 * the delete does about it, as `describePlanReferences` (or, before a delete
 * that follows a move, `describePlanReferencesAfterMove`) names them.
 *
 * Every delete shows it before it is confirmed: today's dialog before «Удалить»,
 * and the preview before «Перенести и удалить», whose delete comes on its own
 * once the move is done. Nothing is drawn when nothing uses the plan.
 */
export function PlanUsageDetails({ impact }: { readonly impact: PlanDeleteImpact }) {
  const { t } = useTranslation()
  const usedById = useId()
  if (impact.rows.length === 0) return null

  return (
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
  )
}
