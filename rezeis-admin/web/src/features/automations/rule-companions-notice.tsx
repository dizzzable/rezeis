import { useTranslation } from 'react-i18next'
import { Layers } from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'

import { popupEventName } from './popup-audience'
import { ButtonTip } from './rule-button-tip'
import type { DraftCompanion } from './rule-companions'

/**
 * The rules «Создать» will save besides the one on screen.
 *
 * Said on the draft itself, because the draft is one rule on one event and
 * «Создать» writes more than that: an operator reading only the form would be
 * surprised by a second row in the list, and could not know it was coming.
 * «Не создавать эти правила» takes them off, for an operator who wants the one
 * rule after all.
 */
export function RuleCompanionsNotice({
  companions,
  onDrop,
  disabled,
}: {
  readonly companions: readonly DraftCompanion[]
  readonly onDrop: () => void
  readonly disabled: boolean
}) {
  const { t } = useTranslation()
  if (companions.length === 0) return null
  return (
    <Alert>
      <Layers className="h-4 w-4" />
      <AlertTitle>{t('automationsPage.editor.companions.title')}</AlertTitle>
      <AlertDescription className="space-y-2">
        <ul className="list-disc pl-4 text-sm">
          {companions.map((companion) => (
            <li key={`${companion.name}:${companion.triggerSpec}`}>
              <span className="font-medium">{companion.name}</span>
              {' — '}
              {popupEventName(t, companion.triggerSpec) ?? companion.triggerSpec}
            </li>
          ))}
        </ul>
        <p className="text-sm text-muted-foreground">{t('automationsPage.editor.companions.body')}</p>
        <ButtonTip tip={t('automationsPage.tips.dropCompanions')} disabled={disabled}>
          <Button variant="outline" size="sm" onClick={onDrop} disabled={disabled}>
            {t('automationsPage.editor.companions.drop')}
          </Button>
        </ButtonTip>
      </AlertDescription>
    </Alert>
  )
}
