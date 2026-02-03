/**
 * Promocode reward types for VPN MiniApp
 */
export type PromocodeRewardType =
  | 'duration'
  | 'traffic'
  | 'devices'
  | 'subscription'
  | 'personal_discount'
  | 'purchase_discount';

/**
 * Promocode availability restrictions
 */
export type PromocodeAvailability =
  | 'all'
  | 'new'
  | 'existing'
  | 'invited'
  | 'allowed';

/**
 * Promocode entity interface - enhanced version for VPN MiniApp
 */
export interface Promocode {
  id: string;
  code: string;
  description?: string;

  // Reward configuration
  rewardType: PromocodeRewardType;
  rewardValue?: number; // Meaning depends on reward_type:
  // DURATION: days to add
  // TRAFFIC: GB to add
  // DEVICES: number of devices
  // SUBSCRIPTION: not used
  // PERSONAL_DISCOUNT: discount percentage
  // PURCHASE_DISCOUNT: discount percentage
  rewardPlanId?: string; // For SUBSCRIPTION type - plan to subscribe
  planSnapshot?: Record<string, unknown>; // Store plan snapshot for SUBSCRIPTION type

  // Availability settings
  availability: PromocodeAvailability;
  allowedUserIds: string[]; // For ALLOWED availability type

  // Usage limits
  maxUses: number; // -1 = unlimited
  usedCount: number;
  maxUsesPerUser: number;

  // Time limits
  startsAt?: Date;
  expiresAt?: Date;

  // Status
  isActive: boolean;

  // Metadata
  createdBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Create promocode DTO
 */
export type CreatePromocodeDTO = Omit<
  Promocode,
  'id' | 'usedCount' | 'createdAt' | 'updatedAt'
>;

/**
 * Update promocode DTO
 */
export type UpdatePromocodeDTO = Partial<
  Omit<Promocode, 'id' | 'usedCount' | 'createdAt' | 'updatedAt'>
>;

/**
 * Promocode activation entity - tracks who used which promocode
 */
export interface PromocodeActivation {
  id: string;
  promocodeId: string;
  userId: string;

  // Activation context
  subscriptionId?: string;
  purchaseAmount?: number;
  discountApplied?: number;

  // Reward details stored as JSON for flexibility
  rewardApplied?: {
    type: PromocodeRewardType;
    value: number;
    description: string;
  };

  // Metadata
  activatedAt: Date;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Create promocode activation DTO
 */
export type CreatePromocodeActivationDTO = Omit<
  PromocodeActivation,
  'id' | 'activatedAt'
>;
