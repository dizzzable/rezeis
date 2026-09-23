/**
 * MainMenuSystemPanel — what the bot adds to its main menu by itself, under
 * the menu's own editor in the inspector of «Карта бота».
 *
 * The menu's editor lists the operator's buttons. reiwa builds more around
 * them (`start.ts`): a trial button on top for a customer without a
 * subscription, the greeting's fallback line and the subscription lines under
 * the greeting. None of it is a stored button, so none of it was anywhere on
 * the map — see `MAIN_MENU_SYSTEM_BUTTONS` / `MAIN_MENU_TEXT_KEYS`.
 */
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { Lock } from 'lucide-react'

import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'

import { MAIN_MENU_SYSTEM_BUTTONS, MAIN_MENU_TEXT_KEYS } from '../system-screens'
import { SystemButtonCard } from './SystemButtonCard'
import { BotTextKeysSection } from './SystemScreenTexts'

export function MainMenuSystemPanel() {
  const { t } = useTranslation()
  const titleId = useId()

  return (
    <section aria-labelledby={titleId} className="space-y-2 pt-3">
      <Separator />
      <div className="flex items-center gap-1.5">
        <Lock className="h-3 w-3 text-muted-foreground" aria-hidden />
        <Label id={titleId} className="text-xs font-medium">
          {t('botFlow.mainMenu.title')}
        </Label>
      </div>
      <p className="text-[10px] leading-snug text-muted-foreground">{t('botFlow.mainMenu.hint')}</p>
      <div className="space-y-2">
        {MAIN_MENU_SYSTEM_BUTTONS.map((button) => (
          <SystemButtonCard
            key={button.key}
            label={t(button.labelKey)}
            condition={button.conditionKey !== undefined ? t(button.conditionKey) : null}
            iconKey={button.iconKey}
            textKey={button.textKey}
          />
        ))}
      </div>
      <BotTextKeysSection keys={MAIN_MENU_TEXT_KEYS} titleKey="botFlow.mainMenu.textsTitle" />
    </section>
  )
}
