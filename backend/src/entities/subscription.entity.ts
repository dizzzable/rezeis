import type { PromocodeRewardType } from './promocode.entity.js';

/**
 * Subscription status enum
 */
export type SubscriptionStatus = 'active' | 'expired' | 'cancelled' | 'pending';

/**
 * Device types for VPN MiniApp
 */
export type DeviceType = 'android' | 'iphone' | 'windows' | 'mac';

/**
 * Subscription types for VPN MiniApp
 */
export type SubscriptionType = 'regular' | 'trial' | 'gift' | 'referral';

/**
 * Subscription entity interface - enhanced version for VPN MiniApp
 */
export interface Subscription {
  id: string;
  userId: string;
  planId: string;

  // Status
  status: SubscriptionStatus;
  startDate: Date;
  endDate: Date;

  // VPN reference
  remnawaveUuid?: string;

  // Subscription type and device info
  subscriptionType: SubscriptionType;
  deviceType?: DeviceType;
  deviceCount: number;
  isTrial: boolean;
  trialEndsAt?: Date;
  trialParentId?: string;
  subscriptionIndex: number;

  // Plan snapshot
  snapshot?: Record<string, unknown>;
  trafficLimitGb?: number;
  trafficUsedGb: number;

  // Renewal tracking
  renewedFromId?: string;
  renewedToId?: string;

  // Promocode tracking
  purchasedWithPromocodeId?: string;
  promoDiscountPercent: number;
  promoDiscountAmount: number;

  createdAt: Date;
  updatedAt: Date;
}

/**
 * Create subscription DTO
 */
export type CreateSubscriptionDTO = Omit<
  Subscription,
  'id' | 'createdAt' | 'updatedAt'
>;

/**
 * Update subscription DTO
 */
export type UpdateSubscriptionDTO = Partial<
  Omit<Subscription, 'id' | 'createdAt' | 'updatedAt'>
>;

/**
 * Trial tracking entity - prevents trial abuse
 */
export interface TrialTracking {
  id: string;
  userId: string;

  // Trial usage
  hasUsedTrial: boolean;
  trialSubscriptionId?: string;
  trialActivatedAt?: Date;
  trialDurationDays: number;

  // Device info at trial (fingerprinting for abuse prevention)
  deviceFingerprint?: string;
  phoneNumber?: string;
  ipAddress?: string;
  telegramId?: string;

  // Metadata
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Create trial tracking DTO
 */
export type CreateTrialTrackingDTO = Omit<
  TrialTracking,
  'id' | 'hasUsedTrial' | 'createdAt' | 'updatedAt'
>;

/**
 * Update trial tracking DTO
 */
export type UpdateTrialTrackingDTO = Partial<
  Omit<TrialTracking, 'id' | 'createdAt' | 'updatedAt'>
>;

/**
 * User personal discount entity - advanced discount tracking
 */
export interface UserPersonalDiscount {
  id: string;
  userId: string;

  // Discount details
  discountPercent: number;
  discountAmount?: number;

  // Source
  sourceType?: string; // 'promocode', 'referral', 'manual', 'loyalty'
  sourceId?: string;

  // Validity
  isActive: boolean;
  expiresAt?: Date;

  // Usage
  maxUses: number; // -1 = unlimited
  usedCount: number;

  // Metadata
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Create user personal discount DTO
 */
export type CreateUserPersonalDiscountDTO = Omit<
  UserPersonalDiscount,
  'id' | 'usedCount' | 'createdAt' | 'updatedAt'
>;

/**
 * Update user personal discount DTO
 */
export type UpdateUserPersonalDiscountDTO = Partial<
  Omit<UserPersonalDiscount, 'id' | 'createdAt' | 'updatedAt'>
>;

/**
 * Reward details for promocode activation
 */
export interface RewardApplied {
  type: PromocodeRewardType;
  value: number;
  description: string;
}
