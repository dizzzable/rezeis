import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { InfoTip } from '@/components/ui/info-tip'
import { cn } from '@/lib/utils'

import {
  ARRIVAL_AUDIENCES,
  planArrival,
  type ArrivalAudience,
  type HintTemplatePlan,
} from './hint-templates'
import { popupEventName } from './popup-audience'
import { ButtonTip } from './rule-button-tip'

/**
 * «Первое появление» — one card with a choice of whom it greets, in place of the
 * two welcome templates.
 *
 * ── The report this is for ───────────────────────────────────────────────────
 *
 * The owner applied the welcome, set its hint's «Где показывать» to «Браузер»,
 * and waited for people signing up in the browser to be greeted. None ever
 * were: that template's rule listens to the Telegram sign-up, and a sign-up on
 * the site is another event. As two cards, the door each one watched was a code
 * string under its title.
 *
 * So the choice is made HERE, in words, and the line under it names the event
 * or events the rule will fire on for that choice — read off the very plan
 * «Использовать» applies, so the card cannot say one thing and do another.
 */
export function ArrivalTemplateCard({
  onUse,
  pending,
}: {
  readonly onUse: (plan: HintTemplatePlan) => void
  readonly pending: boolean
}) {
  const { t } = useTranslation()
  const groupName = useId()
  const labelId = useId()
  const [audience, setAudience] = useState<ArrivalAudience>('everyone')

  const plan = planArrival(audience)
  const events = [plan.template.triggerSpec, ...plan.companions.map((companion) => companion.triggerSpec)]
  const audienceLabel = t('automationsPage.hintTemplates.arrival.audienceLabel')

  return (
    <div className="flex flex-col rounded-lg border p-3">
      <p className="text-xs font-medium">{t('automationsPage.hintTemplates.arrival.title')}</p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">
        {t('automationsPage.hintTemplates.arrival.description')}
      </p>

      <div className="mt-2 flex items-center gap-1.5">
        <span id={labelId} className="text-[11px] font-semibold">
          {audienceLabel}
        </span>
        <InfoTip label={t('automationsPage.infoAria', { subject: audienceLabel })}>
          {t('automationsPage.hintTemplates.arrival.audienceInfo')}
        </InfoTip>
      </div>
      <div role="radiogroup" aria-labelledby={labelId} className="mt-1 space-y-1">
        {ARRIVAL_AUDIENCES.map((value) => (
          <label
            key={value}
            className={cn(
              'flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1 text-[11px] transition-colors',
              audience === value ? 'border-primary bg-primary/5' : 'border-transparent hover:bg-muted/50',
            )}
          >
            <input
              type="radio"
              name={groupName}
              value={value}
              checked={audience === value}
              onChange={() => setAudience(value)}
              disabled={pending}
              className="h-3.5 w-3.5 accent-primary"
            />
            {t(`automationsPage.hintTemplates.arrival.audiences.${value}`)}
          </label>
        ))}
      </div>

      {/* WHAT THE CHOICE FIRES ON, in the operator's words. Live: it follows
          the choice above rather than explaining it in advance. */}
      <div className="mt-2 mb-2 flex-1 text-[11px] text-muted-foreground" aria-live="polite">
        <p>
          {events.length > 1
            ? t('automationsPage.hintTemplates.arrival.firesOnBoth')
            : t('automationsPage.hintTemplates.arrival.firesOnOne')}
        </p>
        <ul className="ml-4 list-disc">
          {events.map((event) => (
            <li key={event}>{popupEventName(t, event) ?? event}</li>
          ))}
        </ul>
      </div>

      <ButtonTip tip={t('automationsPage.tips.useHintTemplate')} disabled={pending} className="flex [&>*]:flex-1">
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          disabled={pending}
          onClick={() => onUse(plan)}
        >
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          {t('automationsPage.help.useTemplate')}
        </Button>
      </ButtonTip>
    </div>
  )
}
