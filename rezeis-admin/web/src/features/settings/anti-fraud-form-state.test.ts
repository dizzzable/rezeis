import { describe, expect, it } from 'vitest'

import {
  buildResetPatch,
  getAntiFraudFormKey,
  serverMessage,
  toFormState,
} from './anti-fraud-form-state'
import type { AntiFraudSettings } from './settings-api'

const SHARING = {
  enableHwidOverage: true,
  enableIpSharing: false,
  ipWindowMinutes: 10,
  ipConcurrencyWindowSeconds: 180,
  maxNodesPerRun: 25,
  maxIpsInMetadata: 20,
  ipNetworkGrouping: true,
  ipV4PrefixLength: 24,
  ipV6PrefixLength: 48,
  ipOverageMargin: 1,
} as const

const TRAFFIC = {
  enabled: true,
  minGb: 200,
  medianMultiplier: 4,
  sharePercent: 35,
  maxNodesPerRun: 7,
} as const

const SUBSCRIPTION_UA = {
  enableSubscriptionUaTunnel: false,
  uaEvidenceWindowMinutes: 60,
  uaRequestPageSize: 500,
} as const

function settings(stored: AntiFraudSettings['stored']): AntiFraudSettings {
  return {
    effective: {
      sharing: { ...SHARING },
      trafficAbuse: { ...TRAFFIC },
      subscriptionUa: { ...SUBSCRIPTION_UA },
    },
    fallback: {
      sharing: { ...SHARING },
      trafficAbuse: { ...TRAFFIC },
      subscriptionUa: { ...SUBSCRIPTION_UA },
    },
    stored,
    overridden: { sharing: [], trafficAbuse: [], subscriptionUa: [] },
    ranges: { sharing: {}, trafficAbuse: {}, subscriptionUa: {} },
  }
}

describe('toFormState', () => {
  it('keeps the two sections independent even where their field names collide', () => {
    // `maxNodesPerRun` is a field of BOTH configs, with different bounds and a
    // different meaning (nodes probed for IPs vs. nodes aggregated for traffic).
    // Merging them into one map lets whichever is written last win, and the form
    // then saves the wrong number to the wrong detector.
    const sharing = toFormState(SHARING)
    const traffic = toFormState(TRAFFIC)
    expect(sharing.maxNodesPerRun).toBe('25')
    expect(traffic.maxNodesPerRun).toBe('7')
  })

  it('holds numbers as strings so a half-typed value is not coerced', () => {
    expect(toFormState(SHARING).ipWindowMinutes).toBe('10')
    expect(toFormState(TRAFFIC).medianMultiplier).toBe('4')
  })

  it('leaves booleans as booleans', () => {
    expect(toFormState(SHARING).enableHwidOverage).toBe(true)
    expect(toFormState(SHARING).enableIpSharing).toBe(false)
  })
})

describe('getAntiFraudFormKey', () => {
  it('preserves edits across an unchanged background refetch', () => {
    expect(getAntiFraudFormKey(settings({ sharing: { ipWindowMinutes: 45 } }))).toBe(
      getAntiFraudFormKey(settings({ sharing: { ipWindowMinutes: 45 } })),
    )
  })

  it('changes when the stored settings actually change', () => {
    expect(getAntiFraudFormKey(settings({ sharing: { ipWindowMinutes: 45 } }))).not.toBe(
      getAntiFraudFormKey(settings({ sharing: { ipWindowMinutes: 60 } })),
    )
    expect(getAntiFraudFormKey(settings({}))).not.toBe(
      getAntiFraudFormKey(settings({ sharing: { ipWindowMinutes: 45 } })),
    )
  })

  it('has a distinct key while loading', () => {
    expect(getAntiFraudFormKey(undefined)).toBe('loading')
  })
})

describe('buildResetPatch', () => {
  it('nulls every field of the section — the API contract for "use the env var"', () => {
    expect(buildResetPatch('sharing', ['ipWindowMinutes', 'enableIpSharing'])).toEqual({
      sharing: { ipWindowMinutes: null, enableIpSharing: null },
    })
  })

  it('touches only the section being reset', () => {
    const patch = buildResetPatch('trafficAbuse', ['minGb'])
    expect(patch.trafficAbuse).toEqual({ minGb: null })
    expect(patch.sharing).toBeUndefined()
  })

  it('resets the subscription-UA section to its defaults, which is OFF', () => {
    // That section has no env layer, so "null" means the built-in default — and
    // the built-in default for the switch is off. Resetting must never be a way
    // to leave a detector running.
    const patch = buildResetPatch('subscriptionUa', [
      'enableSubscriptionUaTunnel',
      'uaEvidenceWindowMinutes',
      'uaRequestPageSize',
    ])
    expect(patch.subscriptionUa).toEqual({
      enableSubscriptionUaTunnel: null,
      uaEvidenceWindowMinutes: null,
      uaRequestPageSize: null,
    })
    expect(patch.sharing).toBeUndefined()
    expect(patch.trafficAbuse).toBeUndefined()
  })
})

describe('serverMessage', () => {
  it('surfaces the API rejection verbatim — it names the field and its range', () => {
    expect(
      serverMessage({
        response: {
          data: {
            message: 'antiFraudSettings.sharing.ipWindowMinutes must be an integer between 1 and 1440 (received 0)',
          },
        },
      }),
    ).toMatch(/between 1 and 1440/)
  })

  it('takes the first entry when class-validator returns an array', () => {
    expect(
      serverMessage({ response: { data: { message: ['sharing.maxNodesPerRun must not be less than 1'] } } }),
    ).toBe('sharing.maxNodesPerRun must not be less than 1')
  })

  it('returns null when there is nothing useful to show', () => {
    expect(serverMessage(new Error('network'))).toBeNull()
    expect(serverMessage(undefined)).toBeNull()
    expect(serverMessage({ response: { data: { message: 42 } } })).toBeNull()
  })
})
