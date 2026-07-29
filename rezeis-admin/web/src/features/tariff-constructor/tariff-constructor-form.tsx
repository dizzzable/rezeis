import { Plus, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { Plan } from '@/features/plans/plans-api'
import type { TariffConstructorDraft } from './tariff-constructor-schema'

interface TariffConstructorFormProps {
  readonly draft: TariffConstructorDraft
  readonly plans: readonly Plan[]
  readonly disabled: boolean
  readonly error: string | null
  readonly onChange: (draft: TariffConstructorDraft) => void
  readonly onSubmit: () => void
}

export function TariffConstructorForm({ draft, plans, disabled, error, onChange, onSubmit }: TariffConstructorFormProps) {
  const updateDuration = (index: number, key: 'days' | 'currency' | 'baseAmount', value: string) => {
    const durations = draft.durations.map((duration, durationIndex) =>
      durationIndex === index ? { ...duration, [key]: key === 'days' ? Number(value) : value } : duration,
    )
    const modules = draft.modules.map((module) => ({
      ...module,
      prices: durations.map((duration, durationIndex) => ({
        days: duration.days,
        currency: duration.currency,
        perStepAmount: module.prices[durationIndex]?.perStepAmount ?? '',
      })),
    }))
    onChange({ ...draft, durations, modules })
  }

  const addDuration = () => onChange({
    ...draft,
    durations: [...draft.durations, { days: 0, currency: '', baseAmount: '' }],
    modules: draft.modules.map((module) => ({
      ...module,
      prices: [...module.prices, { days: 0, currency: '', perStepAmount: '' }],
    })),
  })

  const removeDuration = (index: number) => onChange({
    ...draft,
    durations: draft.durations.filter((_, durationIndex) => durationIndex !== index),
    modules: draft.modules.map((module) => ({
      ...module,
      prices: module.prices.filter((_, priceIndex) => priceIndex !== index),
    })),
  })

  return (
    <form className="space-y-6" onSubmit={(event) => { event.preventDefault(); onSubmit() }}>
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Base plan</CardTitle>
          <CardDescription>The constructor inherits non-price plan settings from this active plan.</CardDescription>
        </CardHeader>
        <CardContent>
          <Label htmlFor="base-plan">Active plan</Label>
          <Select value={draft.basePlanId || undefined} onValueChange={(basePlanId) => onChange({ ...draft, basePlanId })} disabled={disabled}>
            <SelectTrigger id="base-plan" aria-label="Active base plan" className="mt-2">
              <SelectValue placeholder="Select a plan" />
            </SelectTrigger>
            <SelectContent>{plans.map((plan) => <SelectItem key={plan.id} value={plan.id}>{plan.name}</SelectItem>)}</SelectContent>
          </Select>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-start justify-between space-y-0">
          <div><CardTitle className="text-lg">Durations</CardTitle><CardDescription>Base amount by duration and currency.</CardDescription></div>
          <Button type="button" variant="outline" size="sm" onClick={addDuration} disabled={disabled}><Plus className="h-4 w-4" /> Add duration</Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {draft.durations.map((duration, index) => (
            <div key={index} className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[1fr_1fr_1.5fr_auto]">
              <Field label="Days"><Input aria-label={`Duration ${index + 1} days`} type="number" min="1" value={duration.days || ''} onChange={(event) => updateDuration(index, 'days', event.target.value)} disabled={disabled} /></Field>
              <Field label="Currency"><Input aria-label={`Duration ${index + 1} currency`} placeholder="Currency" value={duration.currency} onChange={(event) => updateDuration(index, 'currency', event.target.value.toUpperCase())} disabled={disabled} /></Field>
              <Field label="Base amount"><Input aria-label={`Duration ${index + 1} base amount`} inputMode="decimal" placeholder="0.00" value={duration.baseAmount} onChange={(event) => updateDuration(index, 'baseAmount', event.target.value)} disabled={disabled} /></Field>
              <Button type="button" variant="ghost" size="icon" className="self-end" aria-label={`Remove duration ${index + 1}`} onClick={() => removeDuration(index)} disabled={disabled}><Trash2 className="h-4 w-4" /></Button>
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="grid gap-6 xl:grid-cols-2">
        {draft.modules.map((module, moduleIndex) => (
          <Card key={module.type}>
            <CardHeader><CardTitle className="text-lg">{module.type === 'TRAFFIC' ? 'Traffic' : 'Devices'}</CardTitle><CardDescription>Allowed values and incremental price per duration.</CardDescription></CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {(['minValue', 'maxValue', 'defaultValue', 'step'] as const).map((key) => (
                  <Field key={key} label={{ minValue: 'Minimum', maxValue: 'Maximum', defaultValue: 'Default', step: 'Step' }[key]}>
                    <Input aria-label={`${module.type} ${key}`} type="number" min={key === 'step' ? 1 : 0} value={module[key]} onChange={(event) => onChange({ ...draft, modules: draft.modules.map((item, index) => index === moduleIndex ? { ...item, [key]: Number(event.target.value) } : item) })} disabled={disabled} />
                  </Field>
                ))}
              </div>
              <div className="space-y-2">
                {module.prices.map((price, priceIndex) => (
                  <Field key={priceIndex} label={`${price.days || '?'} days / ${price.currency || '?'}`}>
                    <Input aria-label={`${module.type} duration ${priceIndex + 1} per-step amount`} inputMode="decimal" placeholder="0.00" value={price.perStepAmount} onChange={(event) => onChange({ ...draft, modules: draft.modules.map((item, index) => index === moduleIndex ? { ...item, prices: item.prices.map((itemPrice, index) => index === priceIndex ? { ...itemPrice, perStepAmount: event.target.value } : itemPrice) } : item) })} disabled={disabled} />
                  </Field>
                ))}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end"><Button type="submit" disabled={disabled}>Save draft</Button></div>
    </form>
  )
}

function Field({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return <div className="space-y-1.5"><Label>{label}</Label>{children}</div>
}
