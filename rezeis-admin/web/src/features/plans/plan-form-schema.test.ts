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
      durations: [{ days: '30', prices: [{ currency: 'EUR', price: '10' }] }],
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
          prices: [
            { currency: 'RUB', price: '299' },
            { currency: 'RUB', price: '399' },
          ],
        },
        { days: '30', prices: [{ currency: 'USD', price: '10' }] },
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
        { days: '7', prices: [{ currency: 'RUB', price: '0' }] },
        { days: '14', prices: [{ currency: 'USD', price: '0' }] },
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
    durations: [{ days: '30', prices: [{ currency: 'RUB', price: '299.50' }] }],
  }
}
