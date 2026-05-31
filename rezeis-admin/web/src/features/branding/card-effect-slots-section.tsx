/**
 * CardEffectSlotsSection — WEB Reiwa configurator block for PER-POSITION card
 * backgrounds.
 *
 * The Nth slot styles the Nth subscription card (ordered by subscription
 * creation date) for ALL users: slot 1 → first subscription, slot 2 → second,
 * etc. Subscriptions beyond the configured slots fall back to the global card
 * effect. Operators add/remove slots and tune each one's effect + opacity,
 * reusing the same picker as the global "Animated Card Background" block.
 */

import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

import { CardEffectPicker } from './card-effect-section'
import { getCardEffectDefaults } from './card-effect-registry'

export interface CardEffectSlot {
  cardEffect: string
  cardEffectProps: Record<string, unknown>
  cardEffectOpacity: number
}

interface CardEffectSlotsSectionProps {
  slots: CardEffectSlot[]
  onChange: (slots: CardEffectSlot[]) => void
}

const MAX_SLOTS = 20

export function CardEffectSlotsSection({ slots, onChange }: CardEffectSlotsSectionProps) {
  const { t } = useTranslation()

  // Track the latest slots in a ref so multiple patches dispatched in the same
  // tick compound instead of clobbering each other. The picker's effect change
  // fires `onEffectChange` AND `onPropsChange` synchronously; without this the
  // second call would recompute from the stale `slots` closure and revert the
  // first, making effect selection appear to do nothing.
  const slotsRef = useRef(slots)
  useEffect(() => {
    slotsRef.current = slots
  }, [slots])

  const updateSlot = (index: number, patch: Partial<CardEffectSlot>) => {
    const next = slotsRef.current.map((s, i) => (i === index ? { ...s, ...patch } : s))
    slotsRef.current = next
    onChange(next)
  }

  const addSlot = () => {
    if (slotsRef.current.length >= MAX_SLOTS) return
    const next = [
      ...slotsRef.current,
      { cardEffect: 'aurora', cardEffectProps: getCardEffectDefaults('aurora'), cardEffectOpacity: 1 },
    ]
    slotsRef.current = next
    onChange(next)
  }

  const removeSlot = (index: number) => {
    const next = slotsRef.current.filter((_, i) => i !== index)
    slotsRef.current = next
    onChange(next)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('brandingPage.sections.cardEffectSlots.title')}</CardTitle>
        <CardDescription>{t('brandingPage.sections.cardEffectSlots.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {slots.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {t('brandingPage.sections.cardEffectSlots.empty')}
          </p>
        )}

        {slots.map((slot, index) => (
          <div key={index} className="space-y-2 rounded-xl border border-border/60 bg-muted/20 p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">
                {t('brandingPage.sections.cardEffectSlots.slotLabel', { index: index + 1 })}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-destructive hover:text-destructive"
                onClick={() => removeSlot(index)}
                aria-label={t('brandingPage.sections.cardEffectSlots.removeSlot')}
              >
                <Trash2 className="mr-1 h-3.5 w-3.5" />
                {t('brandingPage.sections.cardEffectSlots.removeSlot')}
              </Button>
            </div>
            {/* Reuse the picker body (grid + opacity + dynamic controls) WITHOUT
                the surrounding Card/title to avoid duplicate headers. */}
            <CardEffectPicker
              effect={slot.cardEffect}
              props={slot.cardEffectProps ?? {}}
              opacity={slot.cardEffectOpacity ?? 1}
              onEffectChange={(e) => updateSlot(index, { cardEffect: e })}
              onPropsChange={(p) => updateSlot(index, { cardEffectProps: p })}
              onOpacityChange={(o) => updateSlot(index, { cardEffectOpacity: o })}
            />
          </div>
        ))}

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={addSlot}
          disabled={slots.length >= MAX_SLOTS}
        >
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          {t('brandingPage.sections.cardEffectSlots.addSlot')}
        </Button>
      </CardContent>
    </Card>
  )
}
