/**
 * SystemScreenPanel — the inspector of a screen the bot builds by itself with
 * no flow block (`SYSTEM_SCREENS`): how a customer gets there, its buttons —
 * default caption, when the bot shows them, icon where the bot reads one, the
 * caption to rewrite — and every text it sends, each with the editor the
 * built-in screens use.
 *
 * These texts were editable before only by typing a key nobody could guess
 * into «Тексты»; the map did not show the screens at all.
 */
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { Lock } from 'lucide-react'

import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'

import type { SystemScreen } from '../system-screens'
import { SystemButtonCard } from './SystemButtonCard'
import { BotTextKeysSection } from './SystemScreenTexts'

interface SystemScreenPanelProps {
  readonly screen: SystemScreen
}

export function SystemScreenPanel({ screen }: SystemScreenPanelProps) {
  const { t } = useTranslation()
  const buttonsTitleId = useId()
  const captions = Object.fromEntries(
    screen.texts.flatMap((text) => (text.captionKey !== undefined ? [[text.key, text.captionKey]] : [])),
  )

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <div className="flex items-center gap-1.5">
          <Lock className="h-3 w-3 text-muted-foreground" aria-hidden />
          <h3 className="text-sm font-medium">{t(screen.titleKey)}</h3>
        </div>
        <p className="text-[11px] leading-snug text-muted-foreground">{t(screen.triggerKey)}</p>
        <p className="text-[10px] leading-snug text-muted-foreground">{t('botFlow.systemScreens.hint')}</p>
      </div>

      {screen.buttons.length > 0 ? (
        <section aria-labelledby={buttonsTitleId} className="space-y-2">
          <Separator />
          <Label id={buttonsTitleId} className="text-xs font-medium">
            {t('botFlow.systemButtons.title')}
          </Label>
          <div className="space-y-2">
            {screen.buttons.map((button) => (
              <SystemButtonCard
                key={button.key}
                label={t(button.labelKey)}
                condition={button.conditionKey !== undefined ? t(button.conditionKey) : null}
                iconKey={button.iconKey}
                textKey={button.textKey}
              />
            ))}
          </div>
        </section>
      ) : null}

      <BotTextKeysSection keys={screen.texts.map((text) => text.key)} captions={captions} />
    </div>
  )
}
