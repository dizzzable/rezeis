import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getSubscriptionDiagnostics } from '@/features/subscription/get-subscription-diagnostics'
import { subscriptionApi } from '@/features/subscription/subscription-api'

type SubscriptionRecord = NonNullable<Awaited<ReturnType<typeof subscriptionApi.getSubscription>>>

function createSubscription(overrides: Partial<SubscriptionRecord> = {}): SubscriptionRecord {
  return {
    id: 'subscription-1',
    status: 'ACTIVE',
    isTrial: false,
    plan: {
      name: 'Starter',
      type: 'BOTH',
    },
    trafficLimit: 1073741824,
    deviceLimit: 3,
    configUrl: 'https://configs.rezeis.test/subscription-1',
    startedAt: '2026-04-10T12:00:00.000Z',
    expiresAt: '2026-04-20T12:00:00.000Z',
    createdAt: '2026-04-01T12:00:00.000Z',
    updatedAt: '2026-04-10T12:00:00.000Z',
    ...overrides,
  }
}

describe('getSubscriptionDiagnostics', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-16T12:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('classifies an expiring-soon active subscription and exposes a safe config URL', () => {
    const inputSubscription: SubscriptionRecord = createSubscription({
      expiresAt: '2026-04-18T12:00:00.000Z',
    })

    const actualDiagnostics = getSubscriptionDiagnostics(inputSubscription)

    expect(actualDiagnostics.stateLabel).toBe('Expiring soon')
    expect(actualDiagnostics.timingLabel).toBe('Expiring soon')
    expect(actualDiagnostics.safeConfigUrl).toBe('https://configs.rezeis.test/subscription-1')
    expect(actualDiagnostics.compactDetail).toContain('Starter')
    expect(actualDiagnostics.compactDetail).toContain('Expires in 2 days')
  })

  it('derives expiry from a past timestamp even when the payload still says active', () => {
    const inputSubscription: SubscriptionRecord = createSubscription({
      expiresAt: '2026-04-15T12:00:00.000Z',
      configUrl: 'vmess://unsafe-config',
    })

    const actualDiagnostics = getSubscriptionDiagnostics(inputSubscription)

    expect(actualDiagnostics.stateLabel).toBe('Expired')
    expect(actualDiagnostics.timingLabel).toBe('Expired')
    expect(actualDiagnostics.safeConfigUrl).toBeNull()
    expect(actualDiagnostics.configDescription).toContain('not a safe HTTP(S) URL')
    expect(actualDiagnostics.compactDetail).toContain('Expired on')
  })

  it('describes an upcoming trial subscription with unlimited traffic', () => {
    const inputSubscription: SubscriptionRecord = createSubscription({
      isTrial: true,
      trafficLimit: null,
      deviceLimit: 1,
      startedAt: '2026-04-19T12:00:00.000Z',
      expiresAt: '2026-04-29T12:00:00.000Z',
    })

    const actualDiagnostics = getSubscriptionDiagnostics(inputSubscription)

    expect(actualDiagnostics.stateLabel).toBe('Starts later')
    expect(actualDiagnostics.trialLabel).toBe('Trial subscription')
    expect(actualDiagnostics.entitlementSummary).toBe('unlimited traffic, 1 device')
    expect(actualDiagnostics.trialDescription).toContain('scheduled to start')
  })

  it('describes a limited subscription as a non-active state', () => {
    const inputSubscription: SubscriptionRecord = createSubscription({
      status: 'LIMITED',
      expiresAt: '2026-04-25T12:00:00.000Z',
    })

    const actualDiagnostics = getSubscriptionDiagnostics(inputSubscription)

    expect(actualDiagnostics.stateLabel).toBe('Limited')
    expect(actualDiagnostics.timingLabel).toBe('Limited state')
    expect(actualDiagnostics.timingDescription).toContain('marked as limited')
    expect(actualDiagnostics.compactDetail).toBe('Starter. 1 GiB traffic, 3 devices.')
  })

  it('describes a disabled trial subscription and hides an unsafe config URL', () => {
    const inputSubscription: SubscriptionRecord = createSubscription({
      status: 'DISABLED',
      isTrial: true,
      configUrl: 'vmess://unsafe-config',
    })

    const actualDiagnostics = getSubscriptionDiagnostics(inputSubscription)

    expect(actualDiagnostics.stateLabel).toBe('Disabled')
    expect(actualDiagnostics.timingLabel).toBe('Disabled state')
    expect(actualDiagnostics.trialDescription).toContain('marked as a trial and is currently marked as disabled')
    expect(actualDiagnostics.safeConfigUrl).toBeNull()
    expect(actualDiagnostics.configDescription).toContain('not a safe HTTP(S) URL')
    expect(actualDiagnostics.compactDetail).toBe('Trial, Starter. 1 GiB traffic, 3 devices.')
  })

  it('describes a deleted subscription and preserves a safe config URL when present', () => {
    const inputSubscription: SubscriptionRecord = createSubscription({
      status: 'DELETED',
      configUrl: 'https://configs.rezeis.test/deleted-subscription',
    })

    const actualDiagnostics = getSubscriptionDiagnostics(inputSubscription)

    expect(actualDiagnostics.stateLabel).toBe('Deleted')
    expect(actualDiagnostics.timingLabel).toBe('Deleted state')
    expect(actualDiagnostics.timingDescription).toContain('marked as deleted')
    expect(actualDiagnostics.safeConfigUrl).toBe('https://configs.rezeis.test/deleted-subscription')
    expect(actualDiagnostics.configDescription).toContain('HTTP(S) config URL')
  })
})
