/* eslint-disable react-refresh/only-export-components */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CalendarIcon } from 'lucide-react'
import { format } from 'date-fns'

import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'

export type AnalyticsRangeId = '7d' | '30d' | '90d' | '180d' | 'custom'

export interface AnalyticsRangeValue {
  readonly id: AnalyticsRangeId
  readonly from: string
  readonly to: string
  readonly granularity: 'day' | 'week'
}

const PRESETS: ReadonlyArray<{ readonly id: Exclude<AnalyticsRangeId, 'custom'>; readonly days: number }> = [
  { id: '7d', days: 7 },
  { id: '30d', days: 30 },
  { id: '90d', days: 90 },
  { id: '180d', days: 180 },
]

function buildPreset(days: number, id: Exclude<AnalyticsRangeId, 'custom'>): AnalyticsRangeValue {
  const to = new Date()
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000)
  return {
    id,
    from: from.toISOString(),
    to: to.toISOString(),
    granularity: days >= 60 ? 'week' : 'day',
  }
}

export function buildDefaultRange(): AnalyticsRangeValue {
  return buildPreset(30, '30d')
}

interface Props {
  readonly value: AnalyticsRangeValue
  readonly onChange: (next: AnalyticsRangeValue) => void
}

/**
 * Range picker with 4 presets and a custom from/to + granularity selector.
 * Lives at the analytics tab top, controls every chart's data fetch.
 */
export function AnalyticsRangePicker({ value, onChange }: Props) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [draftFrom, setDraftFrom] = useState<Date | undefined>(() => new Date(value.from))
  const [draftTo, setDraftTo] = useState<Date | undefined>(() => new Date(value.to))
  const [draftGranularity, setDraftGranularity] = useState<'day' | 'week'>(value.granularity)

  function handlePreset(preset: (typeof PRESETS)[number]) {
    onChange(buildPreset(preset.days, preset.id))
  }

  function applyCustom() {
    if (!draftFrom || !draftTo) return
    if (draftFrom.getTime() > draftTo.getTime()) return
    onChange({
      id: 'custom',
      from: draftFrom.toISOString(),
      to: draftTo.toISOString(),
      granularity: draftGranularity,
    })
    setOpen(false)
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Tabs
        value={value.id === 'custom' ? '' : value.id}
        onValueChange={(id) => {
          const preset = PRESETS.find((p) => p.id === id)
          if (preset) handlePreset(preset)
        }}
      >
        <TabsList>
          {PRESETS.map((preset) => (
            <TabsTrigger key={preset.id} value={preset.id}>
              {t(`partnersAnalytics.range.${preset.id}`)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant={value.id === 'custom' ? 'default' : 'outline'}
            size="sm"
            className="h-8"
            aria-label={t('partnersAnalytics.range.customAria')}
          >
            <CalendarIcon className="h-3.5 w-3.5 mr-1.5" />
            {value.id === 'custom'
              ? `${format(new Date(value.from), 'dd.MM.yy')} → ${format(new Date(value.to), 'dd.MM.yy')}`
              : t('partnersAnalytics.range.custom')}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="p-3 space-y-3 w-auto" align="end">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">{t('partnersAnalytics.range.from')}</Label>
              <Calendar
                mode="single"
                selected={draftFrom}
                onSelect={setDraftFrom}
                autoFocus
              />
            </div>
            <div>
              <Label className="text-xs">{t('partnersAnalytics.range.to')}</Label>
              <Calendar mode="single" selected={draftTo} onSelect={setDraftTo} />
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            <Tabs
              value={draftGranularity}
              onValueChange={(v) => setDraftGranularity(v as 'day' | 'week')}
            >
              <TabsList>
                <TabsTrigger value="day">
                  {t('partnersAnalytics.range.granularity.day')}
                </TabsTrigger>
                <TabsTrigger value="week">
                  {t('partnersAnalytics.range.granularity.week')}
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <Button size="sm" onClick={applyCustom} disabled={!draftFrom || !draftTo}>
              {t('partnersAnalytics.range.apply')}
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
