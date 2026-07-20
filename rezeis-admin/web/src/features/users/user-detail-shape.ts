/**
 * Lightweight typed surface for the user detail object returned by
 * `GET /admin/users/:telegramId`.
 *
 * This is intentionally a permissive interface (most fields are
 * optional) — the backend ships a wide bag of nested relations that we
 * surface in the right-hand panel. We do not zod-validate here yet, but
 * this beats the previous file-wide `eslint-disable @typescript-eslint/no-explicit-any`
 * because it forces us to declare which fields the UI consumes.
 *
 * If you need a new field in the panel, add it here; the compiler will
 * point you at every consumer.
 */

export interface UserSubscription {
  readonly id: string
  readonly status: string
  readonly isTrial?: boolean
  readonly trafficLimit?: number | null
  readonly deviceLimit?: number | null
  readonly expireAt?: string
  readonly createdAt?: string
  readonly configUrl?: string | null
  /** Remnawave panel user UUID — present once the subscription has been provisioned. */
  readonly remnawaveId?: string | null
  /** Live username from the Remnawave panel (`rz_<user>_sub_N` or operator-renamed). */
  readonly remnawaveProfileName?: string | null
  /** Raw description shown on the Remnawave profile (multi-line, includes our `reiwa_id:` marker). */
  readonly remnawaveProfileDescription?: string | null
  readonly planSnapshot?: {
    readonly planId?: string | null
    readonly name?: string | null
  } | null
  readonly plan?: {
    readonly id?: string
    readonly name?: string | null
    readonly type?: string | null
  } | null
  readonly devices?: ReadonlyArray<{ readonly hwid: string; readonly title?: string | null; readonly seenAt?: string | null }>
  /** Per-subscription card-appearance override (animated background, gradient, opacity). */
  readonly cardBranding?: {
    readonly cardEffect?: string | null
    readonly cardEffectProps?: Record<string, unknown> | null
    readonly cardEffectOpacity?: number | null
    readonly cardGradient?: string | null
  } | null
}

export interface UserTransaction {
  readonly id: string
  readonly paymentId?: string | null
  readonly status: string
  readonly amount: number | string
  readonly currency: string
  readonly gatewayType?: string | null
  readonly purchaseType?: string | null
  readonly createdAt: string
}

export interface UserReferralEntry {
  readonly id: string
  readonly level: number
  readonly qualifiedAt?: string | null
  readonly referred?: { readonly name?: string | null; readonly telegramId?: string | number | bigint | null } | null
  readonly referrer?: { readonly name?: string | null; readonly username?: string | null } | null
  readonly referral?: { readonly name?: string | null; readonly username?: string | null } | null
  readonly referralUserId?: string | null
}

export interface UserPartnerTransaction {
  readonly id: string
  readonly amount: number
  readonly note?: string | null
  readonly createdAt: string
  readonly level?: number | null
  readonly description?: string | null
  readonly earnedAmount?: number | null
}

export interface UserPartner {
  readonly id?: number
  readonly isActive?: boolean
  readonly balance?: number
  readonly totalEarned?: number
  readonly totalWithdrawn?: number
  readonly useGlobalSettings?: boolean
  readonly accrualStrategy?: string | null
  readonly rewardType?: string | null
  readonly level1Percent?: number | string | null
  readonly level2Percent?: number | string | null
  readonly level3Percent?: number | string | null
  readonly level1FixedAmount?: number | string | null
  readonly level2FixedAmount?: number | string | null
  readonly level3FixedAmount?: number | string | null
  readonly referrals?: ReadonlyArray<UserReferralEntry>
  readonly transactions?: ReadonlyArray<UserPartnerTransaction>
  readonly individualSettings?: {
    readonly level1Percent?: number | string | null
    readonly level2Percent?: number | string | null
    readonly level3Percent?: number | string | null
  } | null
}

export interface UserWebAccount {
  readonly login?: string | null
  readonly username?: string | null
  readonly email?: string | null
  readonly requiresPasswordChange?: boolean
  readonly temporaryPasswordExpiresAt?: string | null
}

export interface UserReferralBackref {
  readonly level: number
  readonly referrer?: { readonly name?: string | null; readonly username?: string | null } | null
}

export interface InviteEffective {
  readonly linkTtlEnabled?: boolean
  readonly linkTtlSeconds?: number | null
  readonly slotsEnabled?: boolean
  readonly initialSlots?: number | null
  readonly refillThresholdQualified?: number | null
  readonly refillAmount?: number | null
}

export interface InviteOverride {
  readonly useGlobalSettings?: boolean
  readonly linkTtlEnabled?: boolean | null
  readonly linkTtlSeconds?: number | null
  readonly slotsEnabled?: boolean | null
  readonly initialSlots?: number | null
  readonly refillThresholdQualified?: number | null
  readonly refillAmount?: number | null
}

export interface UserDetail {
  readonly id: string
  readonly telegramId: string | number | bigint
  readonly username?: string | null
  readonly name?: string | null
  readonly email?: string | null
  readonly language?: string | null
  readonly role?: string | null
  readonly isBlocked: boolean
  readonly isBotBlocked?: boolean
  readonly isRulesAccepted?: boolean
  readonly isPartner?: boolean
  readonly identityKind?: string
  readonly points?: number | string | null
  readonly maxSubscriptions?: number | null
  readonly trafficLimit?: number | null
  readonly deviceLimit?: number | null
  readonly personalDiscount?: number | string | null
  readonly purchaseDiscount?: number | string | null
  readonly partnerBalanceCurrencyOverride?: string | null
  readonly attachReferrerReason?: string | null
  readonly referralCode?: string | null
  readonly createdAt: string
  readonly updatedAt?: string
  readonly lastSeenAt?: string | null
  readonly subscriptions?: ReadonlyArray<UserSubscription>
  readonly transactions?: ReadonlyArray<UserTransaction>
  readonly referral?: UserReferralBackref | null
  readonly referralsGiven?: ReadonlyArray<UserReferralEntry>
  readonly partner?: UserPartner | null
  readonly webAccount?: UserWebAccount | null
  readonly effectiveInviteSettings?: InviteEffective | null
  readonly userInviteSettingsOverride?: InviteOverride | null
  /** Present when admin has users:view_registration (otherwise null/stripped). */
  readonly canViewRegistration?: boolean
  readonly registrationIp?: string | null
  readonly registrationUserAgent?: string | null
  readonly registrationReferer?: string | null
  readonly registrationUtm?: Record<string, string> | null
  readonly registrationChannel?: string | null
  readonly acquisitionAt?: string | null
  readonly acquisitionPlacement?: {
    readonly id: string
    readonly platform: string
    readonly channel?: string | null
    readonly trackingCode: string
    readonly status: string
    readonly ownerType: string
    readonly campaignId: string
    readonly campaignName: string
  } | null
  readonly acquiredByPartner?: {
    readonly partnerId: string
    readonly level?: number | null
    readonly name?: string | null
    readonly username?: string | null
    readonly telegramId?: string | null
  } | null
}
