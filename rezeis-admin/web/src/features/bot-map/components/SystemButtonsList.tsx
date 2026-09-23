/**
 * SystemButtonsList — the buttons the bot adds by itself, under a card of the
 * «Список» tab: the same buttons «Схема» draws as dashed chips
 * (`systemButtonsOfNode`), each with when the bot shows it.
 *
 * The card used to say only «Системные кнопки бота (добавляются
 * автоматически)» for the three built-in screens, and nothing for every other
 * node the bot adds buttons to.
 */
import { useTranslation } from 'react-i18next'

import type { SystemButtonPreview } from '@/features/bot-flow/types'

interface SystemButtonsListProps {
  readonly buttons: readonly SystemButtonPreview[]
}

export function SystemButtonsList({ buttons }: SystemButtonsListProps) {
  const { t } = useTranslation()
  if (buttons.length === 0) return null

  return (
    <div className="space-y-1" data-system-buttons>
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
        {t('botFlow.systemButtonsCanvasLabel')}
      </p>
      <ul className="space-y-1">
        {buttons.map((button) => (
          <li key={button.key} className="space-y-0.5" data-system-button>
            <span className="inline-block rounded-md border border-dashed border-border/70 bg-muted/30 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
              {t(button.labelKey)}
            </span>
            {button.conditionKey !== undefined ? (
              <p data-condition className="text-[10px] leading-snug text-amber-700 dark:text-amber-400">
                {t(button.conditionKey)}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  )
}
