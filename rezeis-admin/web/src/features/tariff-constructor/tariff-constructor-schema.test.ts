import { describe, expect, it } from 'vitest'

import { tariffConstructorDraftSchema } from './tariff-constructor-schema'

const validDraft = {
  basePlanId: 'plan-1',
  durations: [{ days: 30, currency: 'USD', baseAmount: '10.25000000' }],
  modules: [
    { type: 'TRAFFIC', minValue: 10, maxValue: 100, defaultValue: 50, step: 10, prices: [{ days: 30, currency: 'USD', perStepAmount: '1.20' }] },
    { type: 'DEVICES', minValue: 1, maxValue: 3, defaultValue: 2, step: 1, prices: [{ days: 30, currency: 'USD', perStepAmount: '2.00' }] },
  ],
} as const

describe('tariffConstructorDraftSchema', () => {
  it('preserves amount strings', () => {
    const parsed = tariffConstructorDraftSchema.parse(validDraft)
    expect(parsed.durations[0].baseAmount).toBe('10.25000000')
    expect(parsed.modules[0].prices[0].perStepAmount).toBe('1.20')
  })

  it('rejects misaligned defaults and missing duration prices', () => {
    const result = tariffConstructorDraftSchema.safeParse({ ...validDraft, modules: [{ ...validDraft.modules[0], defaultValue: 55, prices: [] }, validDraft.modules[1]] })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.issues.map((issue) => issue.message)).toEqual(expect.arrayContaining(['Range and default must align to the step.', 'Every duration needs exactly one module price.']))
  })
})
