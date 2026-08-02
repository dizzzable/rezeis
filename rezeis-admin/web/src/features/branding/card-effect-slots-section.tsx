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
import { Check, Plus, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

import { CardEffectPicker } from './card-effect-section'
import { getCardEffectDefaults } from './card-effect-registry'
import { CARD_GRADIENT_PRESETS } from './theme-presets'
import { useCustomGradients } from './use-custom-gradients'

export interface CardEffectSlot {
  mode?: 'inherit' | 'override'
  cardEffect?: string
  cardEffectProps?: Record<string, unknown>
  cardEffectOpacity?: number
  /** Optional per-slot static gradient. Null/absent = use the global gradient. */
  cardGradient?: string | null
}

interface CardEffectSlotsSectionProps {
  slots: CardEffectSlot[]
  onChange: (slots: CardEffectSlot[]) => void
  /** Avoid initialising effect renderers while this editor tab is hidden. */
  livePreview?: boolean
}

const MAX_SLOTS = 20

export function CardEffectSlotsSection({
  slots,
  onChange,
  livePreview = false,
}: CardEffectSlotsSectionProps) {
  const { t } = useTranslation()
  const customGradients = useCustomGradients()

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
      { mode: 'inherit' as const, cardGradient: null },
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
            {(() => {
              const overridesEffect = slot.mode === 'override'
              return <>
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
            <div className="flex items-center justify-between rounded-lg border border-border/60 bg-background/40 p-2.5">
              <div className="space-y-0.5">
                <span className="block text-xs text-muted-foreground">
                  {overridesEffect
                    ? t('brandingPage.sections.cardEffectSlots.effectOverride')
                    : t('brandingPage.sections.cardEffectSlots.effectInherit')}
                </span>
                <span className="block text-[11px] text-muted-foreground">
                  {t('brandingPage.sections.cardEffectSlots.effectModeHint')}
                </span>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[11px]"
                onClick={() => updateSlot(index, overridesEffect
                  ? { mode: 'inherit' }
                  : {
                      mode: 'override',
                      cardEffect: 'aurora',
                      cardEffectProps: getCardEffectDefaults('aurora'),
                      cardEffectOpacity: 1,
                    })}
              >
                {overridesEffect
                  ? t('brandingPage.sections.cardEffectSlots.effectUseGlobal')
                  : t('brandingPage.sections.cardEffectSlots.effectCustomize')}
              </Button>
            </div>
            {/* Reuse the picker body (grid + opacity + dynamic controls) WITHOUT
                the surrounding Card/title to avoid duplicate headers. */}
            {overridesEffect && (
              <CardEffectPicker
                effect={slot.cardEffect ?? 'aurora'}
                props={slot.cardEffectProps ?? {}}
                opacity={slot.cardEffectOpacity ?? 1}
                livePreview={livePreview}
                onEffectChange={(e) => updateSlot(index, { mode: 'override', cardEffect: e })}
                onPropsChange={(p) => updateSlot(index, { mode: 'override', cardEffectProps: p })}
                onOpacityChange={(o) => updateSlot(index, { mode: 'override', cardEffectOpacity: o })}
              />
            )}

            {/* Per-slot static gradient — overrides the global card gradient
                for this card position. Absent = use the global gradient. */}
            <div className="space-y-1.5 rounded-lg border border-border/60 bg-background/40 p-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium">
                  {t('brandingPage.sections.cardEffectSlots.gradientLabel')}
                </span>
                {(slot.cardGradient ?? '').trim().length > 0 ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-[11px]"
                    onClick={() => updateSlot(index, { cardGradient: null })}
                  >
                    {t('brandingPage.sections.cardEffectSlots.gradientUseGlobal')}
                  </Button>
                ) : (
                  <span className="text-[11px] text-muted-foreground">
                    {t('brandingPage.sections.cardEffectSlots.gradientUsingGlobal')}
                  </span>
                )}
              </div>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(32px,1fr))] gap-1.5">
                {[...CARD_GRADIENT_PRESETS.map((p) => p.value), ...customGradients.custom].map((css) => {
                  const isActive = (slot.cardGradient ?? '').trim().toLowerCase() === css.toLowerCase()
                  return (
                    <button
                      key={css}
                      type="button"
                      title={css}
                      aria-label={t('brandingPage.sections.cardEffectSlots.gradientSwatch')}
                      onClick={() => updateSlot(index, { cardGradient: css })}
                      className={`relative aspect-square rounded-md ring-1 transition-all hover:scale-[1.08] ${
                        isActive ? 'ring-2 ring-primary' : 'ring-white/10 hover:ring-primary/40'
                      }`}
                      style={{ backgroundImage: css }}
                    >
                      {isActive && (
                        <span className="absolute inset-0 flex items-center justify-center">
                          <span className="flex h-3 w-3 items-center justify-center rounded-full bg-black/50 text-white">
                            <Check className="h-2 w-2" />
                          </span>
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
              <Input
                value={slot.cardGradient ?? ''}
                onChange={(e) => updateSlot(index, { cardGradient: e.target.value.trim() || null })}
                className="font-mono text-xs"
                placeholder={t('brandingPage.sections.cardEffectSlots.gradientPlaceholder')}
              />
            </div>
              </>
            })()}
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
