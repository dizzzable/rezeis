import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { DatePicker } from '@/components/ui/date-picker'
import { Label } from '@/components/ui/label'

export interface StatsPeriod {
  readonly from?: Date
  readonly to?: Date
}

interface Props {
  readonly value: StatsPeriod
  readonly onChange: (next: StatsPeriod) => void
}

const PRESETS: ReadonlyArray<{ readonly id: string; readonly days: number }> = [
  { id: 'preset7', days: 7 },
  { id: 'preset30', days: 30 },
  { id: 'preset90', days: 90 },
]

function startOfDay(date: Date): Date {
  const next = new Date(date)
  next.setHours(0, 0, 0, 0)
  return next
}

function endOfDay(date: Date): Date {
  const next = new Date(date)
  next.setHours(23, 59, 59, 999)
  return next
}

export function StatsPeriodFilter({ value, onChange }: Props) {
  const { t } = useTranslation()

  function applyPreset(days: number) {
    const to = endOfDay(new Date())
    const from = startOfDay(new Date(Date.now() - days * 24 * 60 * 60 * 1000))
    onChange({ from, to })
  }

  function reset() {
    onChange({ from: undefined, to: undefined })
  }

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-3">
      <div className="space-y-1">
        <Label className="text-xs">{t('statsFilter.from')}</Label>
        <DatePicker
          value={value.from}
          onChange={(date) => onChange({ ...value, from: date ? startOfDay(date) : undefined })}
          placeholder={t('statsFilter.fromPlaceholder')}
        />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">{t('statsFilter.to')}</Label>
        <DatePicker
          value={value.to}
          onChange={(date) => onChange({ ...value, to: date ? endOfDay(date) : undefined })}
          placeholder={t('statsFilter.toPlaceholder')}
        />
      </div>
      <div className="flex items-center gap-1.5">
        {PRESETS.map((preset) => (
          <Button
            key={preset.id}
            type="button"
            variant="outline"
            size="sm"
            onClick={() => applyPreset(preset.days)}
          >
            {t(`statsFilter.${preset.id}`)}
          </Button>
        ))}
        <Button type="button" variant="ghost" size="sm" onClick={reset}>
          {t('statsFilter.reset')}
        </Button>
      </div>
    </div>
  )
}
