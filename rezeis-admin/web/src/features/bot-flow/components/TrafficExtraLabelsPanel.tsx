/**
 * TrafficExtraLabelsPanel — the «Трафик доп.» caption in «Карта бота» → «Тексты
 * вокруг приветствия».
 *
 * reiwa draws one traffic line per plan of an объединённая подписка: the first
 * (an unlimited plan when the bundle has one, else the plan the app faces) is
 * «Трафик», and every limited plan after it is an extra line. This field is the
 * caption of the FIRST extra line — «Трафик доп.» until the operator renames it
 * («Обходы», say) — and it is also the fallback caption of every further line
 * that has no caption of its own.
 *
 * Captions for the THIRD and later tariffs are NOT windows in this panel any
 * more (the owner, 14.11.2026: «не правильно я выразился это отмени»). They are
 * properties of the merged product and are set in the bundle card itself
 * («Тарифы» → «Объединить тарифы»), where the operator already picks the plans:
 * the first two lines always have their caption (this one, «Трафик доп.»), and
 * every tariff after them can carry its own.
 */
import { useTranslation } from 'react-i18next'

import { TextKeyEditor } from './SystemScreenTexts'

/** The caption of the first extra line — and the fallback of every other one. */
const BASE_KEY = 'profile.traffic_extra'

export function TrafficExtraLabelsPanel() {
  const { t } = useTranslation()
  return (
    <div className="space-y-1.5 rounded-md border bg-muted/20 p-2" data-traffic-extra-labels="">
      <div className="min-w-0">
        <p className="text-[11px] font-medium leading-snug">
          {t('botFlow.mainMenu.trafficExtra.title')}
        </p>
        <p className="text-[10px] leading-snug text-muted-foreground">
          {t('botFlow.mainMenu.trafficExtra.hint')}
        </p>
      </div>
      <TextKeyEditor
        textKey={BASE_KEY}
        captionKey="botFlow.screenTexts.captions.subscriptionLine"
      />
      <p className="text-[10px] leading-snug text-muted-foreground">
        {t('botFlow.mainMenu.trafficExtra.perTariffHint')}
      </p>
    </div>
  )
}
