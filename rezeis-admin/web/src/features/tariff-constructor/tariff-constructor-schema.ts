import { z } from 'zod'

export const TARIFF_MODULE_TYPES = ['TRAFFIC', 'DEVICES'] as const

const amount = z.string().trim().regex(/^\d+(?:\.\d{1,8})?$/, 'Enter a non-negative amount with up to 8 decimals.')
const positiveInteger = z.number().int().min(1)

const durationSchema = z.object({
  days: positiveInteger,
  currency: z.string().trim().min(1, 'Currency is required.'),
  baseAmount: amount,
})

const priceSchema = z.object({
  days: positiveInteger,
  currency: z.string().trim().min(1, 'Currency is required.'),
  perStepAmount: amount,
})

const moduleSchema = z.object({
  type: z.enum(TARIFF_MODULE_TYPES),
  minValue: positiveInteger,
  maxValue: positiveInteger,
  defaultValue: positiveInteger,
  step: positiveInteger,
  prices: z.array(priceSchema).min(1),
})

export const tariffConstructorDraftSchema = z
  .object({
    basePlanId: z.string().trim().min(1, 'Select an active base plan.'),
    durations: z.array(durationSchema).min(1, 'Add at least one duration.'),
    modules: z.array(moduleSchema).length(2),
  })
  .superRefine((draft, ctx) => {
    const durationKeys = new Set<string>()
    draft.durations.forEach((duration, index) => {
      const key = `${duration.days}:${duration.currency}`
      if (durationKeys.has(key)) {
        ctx.addIssue({ code: 'custom', path: ['durations', index], message: 'Duration and currency must be unique.' })
      }
      durationKeys.add(key)
    })

    const moduleTypes = new Set(draft.modules.map((module) => module.type))
    if (moduleTypes.size !== TARIFF_MODULE_TYPES.length) {
      ctx.addIssue({ code: 'custom', path: ['modules'], message: 'Traffic and devices modules are required.' })
    }

    draft.modules.forEach((module, moduleIndex) => {
      if (module.minValue > module.maxValue) {
        ctx.addIssue({ code: 'custom', path: ['modules', moduleIndex, 'maxValue'], message: 'Maximum must be at least minimum.' })
      }
      if (module.defaultValue < module.minValue || module.defaultValue > module.maxValue) {
        ctx.addIssue({ code: 'custom', path: ['modules', moduleIndex, 'defaultValue'], message: 'Default must be within the range.' })
      }
      if ((module.maxValue - module.minValue) % module.step !== 0 || (module.defaultValue - module.minValue) % module.step !== 0) {
        ctx.addIssue({ code: 'custom', path: ['modules', moduleIndex, 'step'], message: 'Range and default must align to the step.' })
      }
      const priceKeys = new Set(module.prices.map((price) => `${price.days}:${price.currency}`))
      if (priceKeys.size !== module.prices.length || priceKeys.size !== durationKeys.size || [...durationKeys].some((key) => !priceKeys.has(key))) {
        ctx.addIssue({ code: 'custom', path: ['modules', moduleIndex, 'prices'], message: 'Every duration needs exactly one module price.' })
      }
    })
  })

export type TariffConstructorDraft = z.infer<typeof tariffConstructorDraftSchema>

export function firstTariffConstructorError(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'Check the form values.'
}
