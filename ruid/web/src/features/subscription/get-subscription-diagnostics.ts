import { subscriptionApi } from '@/features/subscription/subscription-api'
import { formatBytes } from '@/lib/format-bytes'

const EXPIRING_SOON_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

interface SubscriptionDiagnostics {
  readonly stateLabel: string
  readonly stateDescription: string
  readonly timingLabel: string
  readonly timingDescription: string
  readonly trialLabel: string
  readonly trialDescription: string
  readonly configLabel: string
  readonly configDescription: string
  readonly entitlementSummary: string
  readonly entitlementDescription: string
  readonly safeConfigUrl: string | null
  readonly compactValue: string
  readonly compactDetail: string
}

type SubscriptionRecord = NonNullable<Awaited<ReturnType<typeof subscriptionApi.getSubscription>>>

export function getSubscriptionDiagnostics(subscription: SubscriptionRecord): SubscriptionDiagnostics {
  const now: Date = new Date()
  const startedAtDate: Date | null = parseDate(subscription.startedAt)
  const expiresAtDate: Date | null = parseDate(subscription.expiresAt)
  const isDisabled: boolean = subscription.status === 'DISABLED'
  const isLimited: boolean = subscription.status === 'LIMITED'
  const isDeleted: boolean = subscription.status === 'DELETED'
  const hasExplicitExpiryStatus: boolean = subscription.status === 'EXPIRED'
  const hasDerivedExpiry: boolean = subscription.status === 'ACTIVE' && expiresAtDate !== null && expiresAtDate.getTime() <= now.getTime()
  const hasExpired: boolean = hasExplicitExpiryStatus || hasDerivedExpiry
  const isUpcoming: boolean = subscription.status === 'ACTIVE' && !hasExpired && startedAtDate !== null && startedAtDate.getTime() > now.getTime()
  const isExpiringSoon: boolean = subscription.status === 'ACTIVE' && !hasExpired && expiresAtDate !== null && expiresAtDate.getTime() - now.getTime() <= EXPIRING_SOON_WINDOW_MS
  const safeConfigUrl: string | null = getSafeConfigUrl(subscription.configUrl)
  const entitlementSummary: string = getEntitlementSummary(subscription)
  const entitlementDescription: string = getEntitlementDescription(subscription)
  const stateLabel: string = getStateLabel({ subscription, hasExpired, isUpcoming, isExpiringSoon })
  const stateDescription: string = getStateDescription({ subscription, hasExpired, isUpcoming })
  const timingLabel: string = getTimingLabel({ subscription, hasExpired, isUpcoming, isExpiringSoon, expiresAtDate })
  const timingDescription: string = getTimingDescription({
    subscription,
    hasExpired,
    hasExplicitExpiryStatus,
    isDisabled,
    isLimited,
    isDeleted,
    isUpcoming,
    isExpiringSoon,
    startedAtDate,
    expiresAtDate,
  })
  const trialLabel: string = subscription.isTrial ? 'Trial subscription' : 'Standard subscription'
  const trialDescription: string = getTrialDescription({ subscription, startedAtDate, expiresAtDate, hasExpired, isUpcoming })
  const configLabel: string = safeConfigUrl ? 'Config URL available' : 'Config URL unavailable'
  const configDescription: string = getConfigDescription({ configUrl: subscription.configUrl, safeConfigUrl })
  return {
    stateLabel,
    stateDescription,
    timingLabel,
    timingDescription,
    trialLabel,
    trialDescription,
    configLabel,
    configDescription,
    entitlementSummary,
    entitlementDescription,
    safeConfigUrl,
    compactValue: stateLabel,
    compactDetail: getCompactDetail({ subscription, entitlementSummary, hasExpired, isUpcoming, isExpiringSoon, expiresAtDate }),
  }
}

function getStateLabel({
  subscription,
  hasExpired,
  isUpcoming,
  isExpiringSoon,
}: {
  readonly subscription: SubscriptionRecord
  readonly hasExpired: boolean
  readonly isUpcoming: boolean
  readonly isExpiringSoon: boolean
}): string {
  if (hasExpired) {
    return 'Expired'
  }
  if (subscription.status === 'DISABLED') {
    return 'Disabled'
  }
  if (subscription.status === 'LIMITED') {
    return 'Limited'
  }
  if (subscription.status === 'DELETED') {
    return 'Deleted'
  }
  if (isUpcoming) {
    return 'Starts later'
  }
  if (isExpiringSoon) {
    return 'Expiring soon'
  }
  return 'Active'
}

function getStateDescription({
  subscription,
  hasExpired,
  isUpcoming,
}: {
  readonly subscription: SubscriptionRecord
  readonly hasExpired: boolean
  readonly isUpcoming: boolean
}): string {
  if (hasExpired) {
    return 'This subscription is no longer current based on the available status or expiry timestamp.'
  }
  if (subscription.status === 'DISABLED') {
    return 'This subscription is currently marked as disabled. The payload does not explain why it was disabled.'
  }
  if (subscription.status === 'LIMITED') {
    return 'This subscription is currently marked as limited. The payload does not specify which entitlement is reduced.'
  }
  if (subscription.status === 'DELETED') {
    return 'This subscription is currently marked as deleted. This page only reflects that stored state.'
  }
  if (isUpcoming) {
    return 'This subscription is present in the payload, but its start time is still in the future.'
  }
  return 'This subscription is currently available through the route-scoped read surface exposed by the user contract.'
}

function getTimingLabel({
  subscription,
  hasExpired,
  isUpcoming,
  isExpiringSoon,
  expiresAtDate,
}: {
  readonly subscription: SubscriptionRecord
  readonly hasExpired: boolean
  readonly isUpcoming: boolean
  readonly isExpiringSoon: boolean
  readonly expiresAtDate: Date | null
}): string {
  if (subscription.status === 'DISABLED') {
    return 'Disabled state'
  }
  if (subscription.status === 'LIMITED') {
    return 'Limited state'
  }
  if (subscription.status === 'DELETED') {
    return 'Deleted state'
  }
  if (hasExpired) {
    return 'Expired'
  }
  if (isUpcoming) {
    return 'Starts later'
  }
  if (isExpiringSoon) {
    return 'Expiring soon'
  }
  if (expiresAtDate === null) {
    return 'No expiry shown'
  }
  return 'Scheduled expiry'
}

function getTimingDescription({
  subscription,
  hasExpired,
  hasExplicitExpiryStatus,
  isDisabled,
  isLimited,
  isDeleted,
  isUpcoming,
  isExpiringSoon,
  startedAtDate,
  expiresAtDate,
}: {
  readonly subscription: SubscriptionRecord
  readonly hasExpired: boolean
  readonly hasExplicitExpiryStatus: boolean
  readonly isDisabled: boolean
  readonly isLimited: boolean
  readonly isDeleted: boolean
  readonly isUpcoming: boolean
  readonly isExpiringSoon: boolean
  readonly startedAtDate: Date | null
  readonly expiresAtDate: Date | null
}): string {
  if (isDisabled) {
    return getNonActiveTimingDescription({
      prefix: 'The subscription is marked as disabled.',
      expiresAtDate,
    })
  }
  if (isLimited) {
    return getNonActiveTimingDescription({
      prefix: 'The subscription is marked as limited.',
      expiresAtDate,
    })
  }
  if (isDeleted) {
    return getNonActiveTimingDescription({
      prefix: 'The subscription is marked as deleted.',
      expiresAtDate,
    })
  }
  if (hasExpired) {
    return expiresAtDate === null || hasExplicitExpiryStatus
      ? 'The payload marks the subscription as expired.'
      : `Expired ${formatRelativeTime(expiresAtDate)} on ${formatDate(expiresAtDate)}.`
  }
  if (isUpcoming && startedAtDate !== null) {
    return `Starts ${formatRelativeTime(startedAtDate)} on ${formatDate(startedAtDate)}.`
  }
  if (isExpiringSoon && expiresAtDate !== null) {
    return `Expires ${formatRelativeTime(expiresAtDate)} on ${formatDate(expiresAtDate)}.`
  }
  if (expiresAtDate === null) {
    return 'No expiry timestamp is attached to this subscription payload.'
  }
  return `Expires on ${formatDate(expiresAtDate)}.`
}

function getTrialDescription({
  subscription,
  startedAtDate,
  expiresAtDate,
  hasExpired,
  isUpcoming,
}: {
  readonly subscription: SubscriptionRecord
  readonly startedAtDate: Date | null
  readonly expiresAtDate: Date | null
  readonly hasExpired: boolean
  readonly isUpcoming: boolean
}): string {
  if (!subscription.isTrial) {
    return 'This subscription is not marked as a trial in the current payload.'
  }
  if (subscription.status === 'DISABLED') {
    return 'This subscription is marked as a trial and is currently marked as disabled.'
  }
  if (subscription.status === 'LIMITED') {
    return 'This subscription is marked as a trial and is currently marked as limited.'
  }
  if (subscription.status === 'DELETED') {
    return 'This subscription is marked as a trial and is currently marked as deleted.'
  }
  if (expiresAtDate === null) {
    return 'This subscription is marked as a trial. No trial end timestamp is included in the payload.'
  }
  if (hasExpired) {
    return `This subscription is marked as a trial and its current expiry timestamp is ${formatDate(expiresAtDate)}.`
  }
  if (isUpcoming && startedAtDate !== null) {
    return `This subscription is marked as a trial and is scheduled to start on ${formatDate(startedAtDate)}.`
  }
  return `This subscription is marked as a trial and currently runs until ${formatDate(expiresAtDate)}.`
}

function getConfigDescription({
  configUrl,
  safeConfigUrl,
}: {
  readonly configUrl: string | null
  readonly safeConfigUrl: string | null
}): string {
  if (safeConfigUrl !== null) {
    return 'The subscription payload includes an HTTP(S) config URL that can be opened in a compatible client when needed.'
  }
  if (configUrl !== null) {
    return 'A config URL is present in the payload, but it is not shown as a clickable link because it is not a safe HTTP(S) URL.'
  }
  return 'No config URL is currently attached to this subscription payload.'
}

function getEntitlementSummary(subscription: SubscriptionRecord): string {
  const trafficSummary: string = subscription.trafficLimit === null ? 'unlimited traffic' : `${formatBytes(subscription.trafficLimit)} traffic`
  const deviceSummary: string = subscription.deviceLimit === 1 ? '1 device' : `${subscription.deviceLimit} devices`
  return `${trafficSummary}, ${deviceSummary}`
}

function getEntitlementDescription(subscription: SubscriptionRecord): string {
  if (subscription.trafficLimit === null) {
    return `The current payload does not set a traffic cap and shows access for ${formatDeviceCount(subscription.deviceLimit)}.`
  }
  return `The current payload shows up to ${formatBytes(subscription.trafficLimit)} of traffic and access for ${formatDeviceCount(subscription.deviceLimit)}.`
}

function getCompactDetail({
  subscription,
  entitlementSummary,
  hasExpired,
  isUpcoming,
  isExpiringSoon,
  expiresAtDate,
}: {
  readonly subscription: SubscriptionRecord
  readonly entitlementSummary: string
  readonly hasExpired: boolean
  readonly isUpcoming: boolean
  readonly isExpiringSoon: boolean
  readonly expiresAtDate: Date | null
}): string {
  const planName: string = subscription.plan?.name ?? 'Plan details unavailable'
  const trialPrefix: string = subscription.isTrial ? 'Trial, ' : ''
  if (subscription.status === 'DISABLED' || subscription.status === 'LIMITED' || subscription.status === 'DELETED') {
    return `${trialPrefix}${planName}. ${entitlementSummary}.`
  }
  if (hasExpired) {
    return expiresAtDate === null
      ? `${trialPrefix}${planName}. Marked as expired.`
      : `${trialPrefix}${planName}. Expired on ${formatDate(expiresAtDate)}.`
  }
  if (isUpcoming) {
    return `${trialPrefix}${planName}. ${entitlementSummary}.`
  }
  if (isExpiringSoon && expiresAtDate !== null) {
    return `${trialPrefix}${planName}. Expires ${formatRelativeTime(expiresAtDate)}.`
  }
  return `${trialPrefix}${planName}. ${entitlementSummary}.`
}

function formatDeviceCount(deviceLimit: number): string {
  if (deviceLimit === 1) {
    return '1 device'
  }
  return `${deviceLimit} devices`
}

function parseDate(value: string | null): Date | null {
  if (!value) {
    return null
  }
  const parsedDate: Date = new Date(value)
  if (Number.isNaN(parsedDate.getTime())) {
    return null
  }
  return parsedDate
}

function formatDate(value: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(value)
}

function formatRelativeTime(value: Date): string {
  const nowTimestamp: number = Date.now()
  const differenceMs: number = value.getTime() - nowTimestamp
  const differenceDays: number = Math.round(differenceMs / (24 * 60 * 60 * 1000))
  if (Math.abs(differenceDays) >= 1) {
    return new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' }).format(differenceDays, 'day')
  }
  const differenceHours: number = Math.round(differenceMs / (60 * 60 * 1000))
  if (Math.abs(differenceHours) >= 1) {
    return new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' }).format(differenceHours, 'hour')
  }
  const differenceMinutes: number = Math.round(differenceMs / (60 * 1000))
  return new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' }).format(differenceMinutes, 'minute')
}

function getNonActiveTimingDescription({
  prefix,
  expiresAtDate,
}: {
  readonly prefix: string
  readonly expiresAtDate: Date | null
}): string {
  if (expiresAtDate === null) {
    return prefix
  }
  return `${prefix} The payload also shows an expiry timestamp of ${formatDate(expiresAtDate)}.`
}

function getSafeConfigUrl(value: string | null): string | null {
  if (value === null) {
    return null
  }
  try {
    const parsedUrl: URL = new URL(value)
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return null
    }
    return parsedUrl.toString()
  } catch {
    return null
  }
}
