import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'

import type { UserHint } from '@/features/user-hints/user-hints-api'

import { popupEventName, surfaceGap } from './popup-audience'
import type { DraftCompanion } from './rule-companions'

/**
 * What is wrong with the hint an action picked, said under the picker while the
 * rule can still be changed.
 *
 * Both are the owner's failures. A switched-off hint behind a switched-on rule
 * queues nothing on every fire, and nothing on «Правила» said so. And a hint
 * limited to «Браузер» behind a rule on the Telegram sign-up waits for people
 * who open the cabinet inside Telegram, where it is never drawn — the
 * WHERE of the hint and the WHOM of the event disagreeing, with each tab showing
 * only its own half.
 *
 * Warnings, not refusals: a customer who signed up in the bot can open the site
 * later, and a hint may be switched off on purpose while it is being written.
 *
 * THE COMPANION RULES ARE ASKED TOO. «Первое появление» for everyone shows this
 * one hint from a second rule on the site sign-up, which exists only as a line
 * on the draft until «Создать». A welcome limited to «Telegram» is right for the
 * draft's own event and never drawn for anybody the companion greets.
 */
export function RuleHintWarnings({
  hint,
  actionType,
  triggerKind,
  triggerSpec,
  companions = [],
}: {
  /** The picked hint, or `undefined` while none is picked or the library is loading. */
  readonly hint: UserHint | undefined
  readonly actionType: string
  readonly triggerKind: string
  readonly triggerSpec: string
  /** The rules «Создать» saves with this draft, each showing the same hint on its own event. */
  readonly companions?: readonly DraftCompanion[]
}) {
  const { t } = useTranslation()
  if (hint === undefined) return null

  const warnings: string[] = []
  if (!hint.isActive) {
    warnings.push(t('automationsPage.actions.hintOff', { title: hint.titleRu }))
  }
  // Only a rule that fires on an event knows where its customer is. An audience
  // action runs on a schedule and picks its own people.
  if (actionType === 'show_hint' && triggerKind === 'REALTIME') {
    const place = (surface: string): string =>
      String(t(`userHints.surfaces.${surface}`, { defaultValue: surface }))
    const allowed = hint.surfaces.map(place).join(', ')
    const home = surfaceGap(triggerSpec, hint.surfaces)
    if (home.length > 0) {
      warnings.push(
        t('automationsPage.actions.surfaceGap', {
          allowed,
          event: popupEventName(t, triggerSpec) ?? triggerSpec.trim(),
          home: home.map(place).join(', '),
        }),
      )
    }
    for (const companion of companions) {
      const companionHome = surfaceGap(companion.triggerSpec, hint.surfaces)
      if (companionHome.length === 0) continue
      warnings.push(
        t('automationsPage.actions.surfaceGapCompanion', {
          allowed,
          rule: companion.name,
          event: popupEventName(t, companion.triggerSpec) ?? companion.triggerSpec.trim(),
          home: companionHome.map(place).join(', '),
        }),
      )
    }
  }
  if (warnings.length === 0) return null

  return (
    <div className="space-y-1">
      {warnings.map((warning) => (
        <p
          key={warning}
          className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{warning}</span>
        </p>
      ))}
    </div>
  )
}
