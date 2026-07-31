import { useId, useMemo, useState } from 'react'
import { Check, Search, Sparkles } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

import {
  CONCEPT_CARD_EFFECTS,
  CONCEPT_CARD_PRESETS,
  CONCEPT_CARD_VISUAL_FAMILIES,
  createConceptCardPresetVisualPatch,
  filterConceptCardPresets,
  type ConceptCardPreset,
  type ConceptCardPresetVisualPatch,
} from './concept-card-presets'

export interface ConceptCardPresetGalleryLabels {
  readonly catalogLabel: string
  readonly searchLabel: string
  readonly searchPlaceholder: string
  readonly familyFilterLabel: string
  readonly allFamilies: string
  readonly effectFilterLabel: string
  readonly allEffects: string
  readonly effect: string
  readonly pattern: string
  readonly noPattern: string
  readonly selected: string
  readonly noResults: string
  readonly showMore: string
  readonly results: (visible: number, total: number) => string
  readonly apply: (preset: ConceptCardPreset) => string
}

export interface ConceptCardPresetGalleryProps {
  readonly presets?: readonly ConceptCardPreset[]
  readonly selectedPresetId?: string | null
  readonly onApply: (
    preset: ConceptCardPreset,
    patch: ConceptCardPresetVisualPatch,
  ) => void
  readonly labels?: Partial<ConceptCardPresetGalleryLabels>
  readonly className?: string
}

const DEFAULT_LABELS: ConceptCardPresetGalleryLabels = {
  catalogLabel: 'Concept subscription-card presets',
  searchLabel: 'Search concept subscription cards',
  searchPlaceholder: 'Name, code, family or effect',
  familyFilterLabel: 'Filter by visual family',
  allFamilies: 'All visual families',
  effectFilterLabel: 'Filter by animation effect',
  allEffects: 'All animation effects',
  effect: 'Effect',
  pattern: 'Pattern',
  noPattern: 'No pattern',
  selected: 'Applied',
  noResults: 'No concept cards match these filters.',
  showMore: 'Show more cards',
  results: (visible, total) => `${visible} of ${total} cards`,
  apply: (preset) =>
    `Apply ${preset.code} ${preset.name}; effect ${preset.cardEffectName}`,
}

const PRESET_PAGE_SIZE = 18

/**
 * Static, filterable gallery for the 104 independent concept card presets.
 *
 * Previews use only CSS gradients and patterns. Animated effect components
 * are deliberately not mounted here, avoiding 104 concurrent WebGL canvases.
 */
export function ConceptCardPresetGallery({
  presets = CONCEPT_CARD_PRESETS,
  selectedPresetId,
  onApply,
  labels: labelsOverride,
  className,
}: ConceptCardPresetGalleryProps) {
  const id = useId()
  const [query, setQuery] = useState('')
  const [visualFamily, setVisualFamily] = useState('')
  const [cardEffect, setCardEffect] = useState('')
  const [visibleLimit, setVisibleLimit] = useState(PRESET_PAGE_SIZE)
  const [lastAppliedId, setLastAppliedId] = useState<string | null>(null)
  const labels = { ...DEFAULT_LABELS, ...labelsOverride }
  const activePresetId =
    selectedPresetId === undefined ? lastAppliedId : selectedPresetId

  const availableFamilies = useMemo(() => {
    if (presets === CONCEPT_CARD_PRESETS) {
      return CONCEPT_CARD_VISUAL_FAMILIES
    }
    return [...new Set(presets.map((preset) => preset.visualFamily))]
  }, [presets])

  const availableEffects = useMemo(() => {
    if (presets === CONCEPT_CARD_PRESETS) return CONCEPT_CARD_EFFECTS
    const effects = new Map<string, string>()
    for (const preset of presets) {
      effects.set(preset.cardEffect, preset.cardEffectName)
    }
    return [...effects].map(([effectId, effectName]) => ({
      id: effectId,
      name: effectName,
    }))
  }, [presets])

  const visiblePresets = useMemo(
    () =>
      filterConceptCardPresets(presets, {
        query,
        visualFamily,
        cardEffect,
      }),
    [cardEffect, presets, query, visualFamily],
  )
  const displayedPresets = visiblePresets.slice(0, visibleLimit)

  return (
    <section
      aria-label={labels.catalogLabel}
      className={cn('space-y-4', className)}
    >
      <div className="grid gap-3 xl:grid-cols-[minmax(16rem,1fr)_14rem_14rem_auto] xl:items-end">
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-search`}>{labels.searchLabel}</Label>
          <div className="relative">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              id={`${id}-search`}
              type="search"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setVisibleLimit(PRESET_PAGE_SIZE)
              }}
              placeholder={labels.searchPlaceholder}
              className="pl-9"
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={`${id}-family`}>{labels.familyFilterLabel}</Label>
          <select
            id={`${id}-family`}
            value={visualFamily}
            onChange={(event) => {
              setVisualFamily(event.target.value)
              setVisibleLimit(PRESET_PAGE_SIZE)
            }}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <option value="">{labels.allFamilies}</option>
            {availableFamilies.map((family) => (
              <option key={family} value={family}>
                {formatTaxonomyLabel(family)}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={`${id}-effect`}>{labels.effectFilterLabel}</Label>
          <select
            id={`${id}-effect`}
            value={cardEffect}
            onChange={(event) => {
              setCardEffect(event.target.value)
              setVisibleLimit(PRESET_PAGE_SIZE)
            }}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <option value="">{labels.allEffects}</option>
            {availableEffects.map((effect) => (
              <option key={effect.id} value={effect.id}>
                {effect.name}
              </option>
            ))}
          </select>
        </div>

        <p
          aria-live="polite"
          className="pb-2 text-sm tabular-nums text-muted-foreground xl:text-right"
        >
          {labels.results(displayedPresets.length, visiblePresets.length)}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 2xl:grid-cols-3">
        {displayedPresets.map((preset) => {
          const selected = activePresetId === preset.id
          return (
            <button
              key={preset.id}
              type="button"
              aria-label={labels.apply(preset)}
              aria-pressed={selected}
              onClick={() => {
                setLastAppliedId(preset.id)
                onApply(preset, createConceptCardPresetVisualPatch(preset))
              }}
              className={cn(
                'group min-h-24 overflow-hidden border bg-card text-left shadow-sm transition-[border-color,box-shadow,transform] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 motion-safe:hover:-translate-y-0.5 motion-safe:hover:shadow-md',
                selected
                  ? 'border-primary ring-1 ring-primary/35'
                  : 'border-border hover:border-primary/45',
              )}
            >
              <div
                aria-hidden="true"
                className="relative h-20 overflow-hidden border-b"
                style={{ backgroundImage: preset.cardGradient }}
              >
                {preset.cardPattern && (
                  <span
                    className="absolute inset-0 opacity-70"
                    style={{
                      backgroundImage: preset.cardPattern,
                      backgroundSize: '22px 22px',
                    }}
                  />
                )}
                <span className="absolute inset-0 bg-gradient-to-r from-black/10 via-transparent to-black/20" />
                <span className="absolute left-3 top-3 border border-white/35 bg-black/75 px-2 py-1 font-mono text-[11px] font-bold tracking-[0.18em] text-white shadow-sm">
                  {preset.code}
                </span>
                <span className="absolute bottom-3 right-3 inline-flex items-center gap-1 border border-white/25 bg-black/75 px-2 py-1 text-[11px] font-medium text-white">
                  <Sparkles aria-hidden="true" className="h-3 w-3" />
                  {preset.cardEffectName}
                </span>
              </div>

              <div className="flex items-start justify-between gap-3 p-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">
                    {preset.name}
                  </p>
                  <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <span>{formatTaxonomyLabel(preset.visualFamily)}</span>
                    <span aria-hidden="true">·</span>
                    <span>
                      {labels.effect}: {preset.cardEffectName}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>
                      {preset.cardPattern ? labels.pattern : labels.noPattern}
                    </span>
                  </p>
                </div>
                {selected && (
                  <Badge className="shrink-0 gap-1">
                    <Check aria-hidden="true" className="h-3 w-3" />
                    {labels.selected}
                  </Badge>
                )}
              </div>
            </button>
          )
        })}
      </div>

      {visiblePresets.length === 0 && (
        <div className="rounded-md border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          {labels.noResults}
        </div>
      )}

      {displayedPresets.length < visiblePresets.length && (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={() =>
              setVisibleLimit((current) => current + PRESET_PAGE_SIZE)
            }
            className="inline-flex h-10 items-center justify-center rounded-md border border-input bg-background px-5 text-sm font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            {labels.showMore}
          </button>
        </div>
      )}
    </section>
  )
}

function formatTaxonomyLabel(value: string): string {
  return value
    .split('-')
    .map((part) => `${part.charAt(0).toLocaleUpperCase()}${part.slice(1)}`)
    .join(' ')
}
