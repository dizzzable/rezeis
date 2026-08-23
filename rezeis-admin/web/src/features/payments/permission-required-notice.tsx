/**
 * "You are not allowed to see this", said out loud.
 * ─────────────────────────────────────────────────
 * The refusal a Payments surface renders in place of the data it cannot load.
 *
 * WHY A REFUSAL RATHER THAN HIDING THE TAB.
 * Hiding and refusing are different products, and this repo has already picked
 * one. `<PermissionGate>`'s own docblock draws the line: "Defaults to nothing,
 * which is the right choice for navigation entries / inline buttons. Pass an
 * explicit fallback for whole-page surfaces." Every whole surface in this
 * feature follows it — `payments-page.tsx` refuses with `PaymentsAccessDenied`,
 * `gateway-settings-page.tsx:747` refuses with a card whose copy names the
 * missing token in words. A tab body is a surface, not an affordance.
 *
 * It is also the only option that answers the operator's actual question.
 * Hiding the tab swaps one ambiguity ("is the inbox empty, or am I blind?")
 * for another ("does this panel have no webhook view, or do I not have one?"),
 * and it hides the existence of a capability the operator would otherwise know
 * to ask for. The refusal ends the guessing: it says which token is missing,
 * so the operator can quote it to whoever administers roles.
 *
 * The token is not typed here. It comes off the same `RoutePermission` the
 * caller passed to the query's `enabled:`, so the sentence and the check can
 * never disagree.
 */
import { useTranslation } from 'react-i18next'
import { ShieldAlert } from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import type { RoutePermission } from './payments-route-permissions'

export interface PermissionRequiredNoticeProps {
  /** The permission the route behind this surface demands. */
  readonly permission: RoutePermission
  /** What is being refused, in the operator's language. */
  readonly title: string
  /**
   * Why this surface is empty and what it is NOT. The one thing worth saying
   * here is the thing the silent empty table could not: that this is a refusal
   * and not a zero.
   */
  readonly description: string
}

export function PermissionRequiredNotice({
  permission,
  title,
  description,
}: PermissionRequiredNoticeProps) {
  const { t } = useTranslation()

  return (
    <Card>
      <CardHeader className="space-y-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldAlert className="h-4 w-4 shrink-0 text-muted-foreground" />
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-1">
        <p className="text-xs font-medium text-muted-foreground">
          {t('paymentsAccess.requiredPermission')}
        </p>
        {/* Monospaced and selectable: the operator is expected to copy this
            string into a message to whoever administers roles. */}
        <code className="inline-block rounded bg-muted px-2 py-1 font-mono text-xs">
          {permission.token}
        </code>
        <p className="pt-1 text-xs text-muted-foreground">
          {t('paymentsAccess.askAdministrator')}
        </p>
      </CardContent>
    </Card>
  )
}

export default PermissionRequiredNotice
