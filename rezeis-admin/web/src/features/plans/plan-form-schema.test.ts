import { describe, expect, it } from 'vitest'

import { createPlanFormSchema, flattenPlanFormErrors, type PlanFormDraft } from './plan-form-schema'

const messages = {
  nameRequired: 'name required',
  nameTooLong: 'name too long',
  descriptionTooLong: 'description too long',
  tagInvalid: 'tag invalid',
  iconTooLong: 'icon too long',
  planTypeInvalid: 'type invalid',
  availabilityInvalid: 'availability invalid',
  trafficLimitInvalid: 'traffic invalid',
  deviceLimitInvalid: 'device invalid',
  resetStrategyInvalid: 'strategy invalid',
  trialMaxClaimsInvalid: 'trial claims invalid',
  durationRequired: 'duration required',
  durationDaysInvalid: 'duration days invalid',
  durationDuplicate: 'duration duplicate',
  trialDurationCount: 'trial duration count',
  priceRequired: 'price required',
  priceInvalid: 'price invalid',
  currencyInvalid: 'currency invalid',
  currencyDuplicate: 'currency duplicate',
  paidTrialPriceRequired: 'paid trial price required',
  replacementRequired: 'replacement required',
  allowedUsersRequired: 'allowed users required',
  cashbackPercentRange: 'cashback percent range',
  cashbackPointsRange: 'cashback points range',
} as const

describe('plan form schema', () => {
  it('normalizes a valid plan draft before submit', () => {
    const result = createPlanFormSchema(messages).safeParse({
      ...validDraft(),
      name: '  Premium 50GB  ',
      description: '  ',
      trafficLimitGB: '0',
      internalSquads: [' squad-a ', 'squad-a', ''],
      externalSquad: '__none__',
    })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data).toMatchObject({
      name: 'Premium 50GB',
      description: undefined,
      trafficLimit: null,
      internalSquads: ['squad-a'],
      externalSquad: undefined,
      durations: [{ days: 30, prices: [{ currency: 'RUB', price: '299.50' }] }],
    })
  })

  it('rejects malformed numbers and unsupported currencies', () => {
    const result = createPlanFormSchema(messages).safeParse({
      ...validDraft(),
      trafficLimitGB: '',
      deviceLimit: '1.5',
      durations: [{ days: '30', cashbackPoints: '', prices: [{ currency: 'EUR', price: '10' }] }],
    })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(flattenPlanFormErrors(result.error)).toMatchObject({
      trafficLimitGB: 'traffic invalid',
      deviceLimit: 'device invalid',
      'durations.0.prices.0.currency': 'currency invalid',
    })
  })

  it('rejects duplicate duration days and duplicate currencies per duration', () => {
    const result = createPlanFormSchema(messages).safeParse({
      ...validDraft(),
      durations: [
        {
          days: '30',
          cashbackPoints: '',
          prices: [
            { currency: 'RUB', price: '299' },
            { currency: 'RUB', price: '399' },
          ],
        },
        { days: '30', cashbackPoints: '', prices: [{ currency: 'USD', price: '10' }] },
      ],
    })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(flattenPlanFormErrors(result.error)).toMatchObject({
      'durations.0.prices.1.currency': 'currency duplicate',
      'durations.1.days': 'duration duplicate',
    })
  })

  it('rejects archived replacement mode without replacement targets', () => {
    const result = createPlanFormSchema(messages).safeParse({
      ...validDraft(),
      isArchived: true,
      archivedRenewMode: 'REPLACE_ON_RENEW',
      replacementPlanIds: [],
    })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(flattenPlanFormErrors(result.error).replacementPlanIds).toBe('replacement required')
  })

  it('rejects trial payloads with multiple durations or no paid price', () => {
    const result = createPlanFormSchema(messages).safeParse({
      ...validDraft(),
      availability: 'TRIAL',
      trialSettings: { maxClaims: '3', free: false, availabilityScope: 'ALL', requireTelegramLink: false },
      durations: [
        { days: '7', cashbackPoints: '', prices: [{ currency: 'RUB', price: '0' }] },
        { days: '14', cashbackPoints: '', prices: [{ currency: 'USD', price: '0' }] },
      ],
    })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(flattenPlanFormErrors(result.error)).toMatchObject({
      durations: 'trial duration count',
      'trialSettings.free': 'paid trial price required',
    })
  })
})

// ── Points cashback ──────────────────────────────────────────────────────────
//
// Two numbers, of which the mode reads one: the percent under PERCENT, the
// points of each DURATION under FIXED, neither under INHERIT and NONE. The
// schema is where a value the mode does not read stops — validated only when
// it is read, nulled on submit otherwise — so a percent typed under PERCENT
// and then abandoned for INHERIT neither blocks the save nor rides along in it.
describe('plan form schema — points cashback', () => {
  const schema = createPlanFormSchema(messages)
  const prices = [{ currency: 'RUB', price: '299' }]

  it('requires a whole percent from 0 to 100 under PERCENT', () => {
    for (const cashbackPercent of ['', '101', '-1', '7.5', 'ten']) {
      const result = schema.safeParse({ ...validDraft(), cashbackMode: 'PERCENT', cashbackPercent })
      expect(result.success, `percent ${JSON.stringify(cashbackPercent)}`).toBe(false)
      if (result.success) continue
      expect(flattenPlanFormErrors(result.error)).toEqual({ cashbackPercent: 'cashback percent range' })
    }

    const accepted = schema.safeParse({ ...validDraft(), cashbackMode: 'PERCENT', cashbackPercent: ' 15 ' })
    expect(accepted.success).toBe(true)
    if (!accepted.success) return
    expect(accepted.data.cashbackMode).toBe('PERCENT')
    expect(accepted.data.cashbackPercent).toBe(15)
    expect(accepted.data.durations[0]?.cashbackPoints).toBeNull()
  })

  it('neither validates nor submits a percent under any other mode', () => {
    for (const cashbackMode of ['INHERIT', 'NONE', 'FIXED']) {
      const result = schema.safeParse({ ...validDraft(), cashbackMode, cashbackPercent: 'not a number' })
      expect(result.success, cashbackMode).toBe(true)
      if (!result.success) continue
      expect(result.data.cashbackPercent).toBeNull()
    }
  })

  it('reads an empty duration as 0 points under FIXED and keeps a typed value per duration', () => {
    const result = schema.safeParse({
      ...validDraft(),
      cashbackMode: 'FIXED',
      cashbackPercent: '15',
      durations: [
        { days: '30', cashbackPoints: '', prices },
        { days: '365', cashbackPoints: ' 600 ', prices: [{ currency: 'RUB', price: '2990' }] },
      ],
    })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.cashbackMode).toBe('FIXED')
    // A percent left behind by an earlier PERCENT rule does not ride along.
    expect(result.data.cashbackPercent).toBeNull()
    expect(result.data.durations.map((duration) => duration.cashbackPoints)).toEqual([0, 600])
  })

  it('rejects negative, fractional and oversized points under FIXED, on the duration that has them', () => {
    for (const cashbackPoints of ['-5', '1.5', '2147483648', 'many']) {
      const result = schema.safeParse({
        ...validDraft(),
        cashbackMode: 'FIXED',
        durations: [
          { days: '30', cashbackPoints: '10', prices },
          { days: '365', cashbackPoints, prices: [{ currency: 'RUB', price: '2990' }] },
        ],
      })
      expect(result.success, `points ${JSON.stringify(cashbackPoints)}`).toBe(false)
      if (result.success) continue
      expect(flattenPlanFormErrors(result.error)).toEqual({
        'durations.1.cashbackPoints': 'cashback points range',
      })
    }
  })

  it('nulls the duration points under every mode but FIXED', () => {
    for (const cashbackMode of ['INHERIT', 'NONE', 'PERCENT']) {
      const result = schema.safeParse({
        ...validDraft(),
        cashbackMode,
        cashbackPercent: '15',
        durations: [{ days: '30', cashbackPoints: '40', prices }],
      })
      expect(result.success, cashbackMode).toBe(true)
      if (!result.success) continue
      expect(result.data.durations[0]?.cashbackPoints).toBeNull()
      expect(result.data.cashbackPercent).toBe(cashbackMode === 'PERCENT' ? 15 : null)
    }
  })
})

function validDraft(): PlanFormDraft {
  return {
    name: 'Premium 50GB',
    description: 'Best value',
    tag: 'POPULAR',
    icon: null,
    type: 'TRAFFIC',
    availability: 'ALL',
    trafficLimitGB: '50',
    deviceLimit: '1',
    trafficLimitStrategy: 'MONTH',
    isArchived: false,
    archivedRenewMode: 'SELF_RENEW',
    internalSquads: [],
    externalSquad: '__none__',
    upgradeToPlanIds: [],
    replacementPlanIds: [],
    allowedUserIds: [],
    trialSettings: { maxClaims: '1', free: true, availabilityScope: 'ALL', requireTelegramLink: false },
    cashbackMode: 'INHERIT',
    cashbackPercent: '',
    durations: [{ days: '30', cashbackPoints: '', prices: [{ currency: 'RUB', price: '299.50' }] }],
  }
}
