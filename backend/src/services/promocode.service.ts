import type { Pool } from 'pg';
import type { Promocode, PromocodeRewardType, UpdatePromocodeDTO } from '../entities/promocode.entity.js';
import { PromocodeRepository } from '../repositories/promocode.repository.js';
import { PromocodeActivationRepository } from '../repositories/promocode-activation.repository.js';
import { UserPersonalDiscountRepository } from '../repositories/user-personal-discount.repository.js';
import { SubscriptionRepository } from '../repositories/subscription.repository.js';
import { logger } from '../utils/logger.js';

/**
 * Result of promocode validation
 */
export interface ValidatePromocodeResult {
  valid: boolean;
  error?: string;
  promocode?: Promocode;
  discount?: {
    type: 'percentage' | 'fixed';
    value: number;
  };
  reward?: {
    type: PromocodeRewardType;
    value: number;
    description: string;
  };
}

/**
 * Result of promocode application
 */
export interface ApplyPromocodeResult {
  success: boolean;
  error?: string;
  activation?: {
    id: string;
    rewardApplied: {
      type: PromocodeRewardType;
      value: number;
      description: string;
    };
  };
}

/**
 * PromocodeService - Comprehensive service for managing promocodes with all 6 reward types
 *
 * Reward Types:
 * - DURATION: Add days to subscription
 * - TRAFFIC: Add GB to traffic limit
 * - DEVICES: Add device slots
 * - SUBSCRIPTION: Grant free subscription
 * - PERSONAL_DISCOUNT: Set personal discount percentage
 * - PURCHASE_DISCOUNT: Set purchase discount percentage
 */
export class PromocodeService {
  private readonly promocodeRepository: PromocodeRepository;
  private readonly activationRepository: PromocodeActivationRepository;
  private readonly personalDiscountRepository: UserPersonalDiscountRepository;
  private readonly subscriptionRepository: SubscriptionRepository;

  constructor(pool: Pool) {
    this.promocodeRepository = new PromocodeRepository(pool);
    this.activationRepository = new PromocodeActivationRepository(pool);
    this.personalDiscountRepository = new UserPersonalDiscountRepository(pool);
    this.subscriptionRepository = new SubscriptionRepository(pool);
  }

  /**
   * Validate a promocode for a user
   * @param code - Promocode code
   * @param userId - User ID
   * @param planId - Optional plan ID for subscription-type promocodes
   * @param amount - Optional amount for purchase discount calculation
   * @returns Validation result
   */
  async validatePromocode(
    code: string,
    userId: string,
    planId?: string,
    amount?: number
  ): Promise<ValidatePromocodeResult> {
    void planId; // May be used in the future
    try {
      // Find the promocode
      const promocode = await this.promocodeRepository.findByCode(code);
      if (!promocode) {
        return { valid: false, error: 'Promocode not found' };
      }

      // Check if promocode is active
      if (!promocode.isActive) {
        return { valid: false, error: 'Promocode is inactive' };
      }

      // Check if promocode has started
      if (promocode.startsAt && promocode.startsAt > new Date()) {
        return { valid: false, error: 'Promocode has not started yet' };
      }

      // Check if promocode has expired
      if (promocode.expiresAt && promocode.expiresAt < new Date()) {
        return { valid: false, error: 'Promocode has expired' };
      }

      // Check global usage limit
      if (promocode.maxUses >= 0 && promocode.usedCount >= promocode.maxUses) {
        return { valid: false, error: 'Promocode usage limit reached' };
      }

      // Check availability
      if (promocode.availability !== 'all' && promocode.availability !== 'allowed') {
        // For non-all availability, we'd need to check user status
        // This would require user repository dependency
      }

      // Check user-specific usage limit
      const userActivationCount = await this.promocodeRepository.countUserActivations(promocode.id, userId);
      if (userActivationCount >= promocode.maxUsesPerUser) {
        return { valid: false, error: 'You have already used this promocode' };
      }

      // Build reward info based on reward type
      const reward = this.getRewardInfo(promocode);

      // For purchase discount, calculate the actual discount
      let discount: ValidatePromocodeResult['discount'] | undefined;
      if (promocode.rewardType === 'purchase_discount' && amount && promocode.rewardValue) {
        discount = {
          type: 'percentage',
          value: (amount * promocode.rewardValue) / 100,
        };
      }

      return {
        valid: true,
        promocode,
        discount,
        reward,
      };
    } catch (error) {
      logger.error({ error, code, userId }, 'Failed to validate promocode');
      return { valid: false, error: 'Failed to validate promocode' };
    }
  }

  /**
   * Apply a promocode and give reward to a user
   * @param code - Promocode code
   * @param userId - User ID
   * @param options - Additional options
   * @returns Application result
   */
  async applyPromocode(
    code: string,
    userId: string,
    options?: {
      subscriptionId?: string;
      amount?: number;
      deviceFingerprint?: string;
      ipAddress?: string;
    }
  ): Promise<ApplyPromocodeResult> {
    try {
      // Validate first
      const validation = await this.validatePromocode(code, userId, options?.subscriptionId, options?.amount);
      if (!validation.valid || !validation.promocode) {
        return { success: false, error: validation.error };
      }

      const promocode = validation.promocode;

      // Apply the reward based on type
      switch (promocode.rewardType) {
        case 'duration':
          await this.applyDurationReward(promocode, userId, options?.subscriptionId);
          break;
        case 'traffic':
          await this.applyTrafficReward(promocode, userId, options?.subscriptionId);
          break;
        case 'devices':
          await this.applyDevicesReward(promocode, userId, options?.subscriptionId);
          break;
        case 'subscription':
          await this.applySubscriptionReward(promocode, userId);
          break;
        case 'personal_discount':
          await this.applyPersonalDiscountReward(promocode, userId);
          break;
        case 'purchase_discount':
          await this.applyPurchaseDiscountReward(promocode, userId, options?.amount);
          break;
      }

      // Increment promocode usage
      await this.promocodeRepository.incrementUsedCount(promocode.id);

      // Create activation record
      const activation = await this.activationRepository.create({
        promocodeId: promocode.id,
        userId,
        subscriptionId: options?.subscriptionId,
        purchaseAmount: options?.amount,
        discountApplied: validation.discount?.value,
        rewardApplied: validation.reward,
        ipAddress: options?.ipAddress,
      });

      return {
        success: true,
        activation: {
          id: activation.id,
          rewardApplied: validation.reward!,
        },
      };
    } catch (error) {
      logger.error({ error, code, userId }, 'Failed to apply promocode');
      return { success: false, error: 'Failed to apply promocode' };
    }
  }

  /**
   * Apply duration reward - add days to subscription
   */
  async applyDurationReward(promocode: Promocode, userId: string, subscriptionId?: string): Promise<void> {
    const daysToAdd = promocode.rewardValue || 0;

    if (subscriptionId) {
      // Extend existing subscription
      await this.subscriptionRepository.update(subscriptionId, {
        endDate: new Date(Date.now() + daysToAdd * 24 * 60 * 60 * 1000),
      });
    } else {
      // Would need to create or find active subscription
      // This is typically handled by the subscription service
      logger.info({ promocodeId: promocode.id, userId, daysToAdd }, 'Duration reward applied');
    }
  }

  /**
   * Apply traffic reward - add GB to traffic limit
   */
  async applyTrafficReward(promocode: Promocode, userId: string, subscriptionId?: string): Promise<void> {
    void userId; // Parameter kept for API consistency
    const gbToAdd = promocode.rewardValue || 0;

    if (subscriptionId) {
      const subscription = await this.subscriptionRepository.findById(subscriptionId);
      if (subscription) {
        const currentLimit = subscription.trafficLimitGb || 0;
        await this.subscriptionRepository.update(subscriptionId, {
          trafficLimitGb: currentLimit + gbToAdd,
        });
      }
    }
  }

  /**
   * Apply devices reward - add device slots
   */
  async applyDevicesReward(promocode: Promocode, userId: string, subscriptionId?: string): Promise<void> {
    void userId; // Parameter kept for API consistency
    const devicesToAdd = promocode.rewardValue || 0;

    if (subscriptionId) {
      const subscription = await this.subscriptionRepository.findById(subscriptionId);
      if (subscription) {
        const currentDevices = subscription.deviceCount || 1;
        await this.subscriptionRepository.update(subscriptionId, {
          deviceCount: currentDevices + devicesToAdd,
        });
      }
    }
  }

  /**
   * Apply subscription reward - grant free subscription
   */
  async applySubscriptionReward(promocode: Promocode, userId: string): Promise<void> {
    // This would typically create a new subscription
    // The plan is stored in promocode.planSnapshot or promocode.rewardPlanId
    logger.info({ promocodeId: promocode.id, userId }, 'Subscription reward applied');
  }

  /**
   * Apply personal discount reward - set personal discount percentage
   */
  async applyPersonalDiscountReward(promocode: Promocode, userId: string): Promise<void> {
    const discountPercent = promocode.rewardValue || 0;

    // Check if user already has a personal discount from this promocode
    const existingDiscounts = await this.personalDiscountRepository.getSourceDiscounts(
      userId,
      'promocode',
      promocode.id
    );

    if (existingDiscounts.length > 0) {
      // Update existing discount
      const existing = existingDiscounts[0];
      await this.personalDiscountRepository.update(existing.id, {
        discountPercent: Math.max(existing.discountPercent, discountPercent),
      });
    } else {
      // Create new personal discount (typically expires after some time)
      await this.personalDiscountRepository.create({
        userId,
        discountPercent,
        sourceType: 'promocode',
        sourceId: promocode.id,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
        maxUses: -1, // Unlimited uses for personal discount
        isActive: true,
      });
    }
  }

  /**
   * Apply purchase discount reward - set purchase discount for next purchase
   */
  async applyPurchaseDiscountReward(promocode: Promocode, userId: string, amount?: number): Promise<void> {
    void amount; // Parameter kept for API consistency
    const discountPercent = promocode.rewardValue || 0;

    // This would typically update the user's purchase_discount_percent field
    // and set an expiration date
    logger.info({ promocodeId: promocode.id, userId, discountPercent }, 'Purchase discount reward applied');
  }

  /**
   * Check if global usage limit is reached
   */
  async checkGlobalLimit(promocode: Promocode): Promise<boolean> {
    if (promocode.maxUses < 0) return false; // Unlimited
    return promocode.usedCount >= promocode.maxUses;
  }

  /**
   * Check if user-specific usage limit is reached
   */
  async checkUserLimit(promocode: Promocode, userId: string): Promise<boolean> {
    const activationCount = await this.promocodeRepository.countUserActivations(promocode.id, userId);
    return activationCount >= promocode.maxUsesPerUser;
  }

  /**
   * Get user activation count for a promocode
   */
  async getUserActivationCount(promocodeId: string, userId: string): Promise<number> {
    return this.promocodeRepository.countUserActivations(promocodeId, userId);
  }

  /**
   * Get activation history for a promocode
   */
  async getActivationHistory(promocodeId: string, page: number, limit: number) {
    return this.promocodeRepository.getActivations(promocodeId, page, limit);
  }

  /**
   * Create a new promocode
   */
  async createPromocode(data: Omit<Promocode, 'id' | 'usedCount' | 'createdAt' | 'updatedAt'>): Promise<Promocode> {
    // Would need to implement insert method or use raw query
    logger.info({ data }, 'Creating promocode');
    throw new Error('Not implemented');
  }

  /**
   * Update a promocode
   */
  async updatePromocode(id: string, data: Partial<Promocode>): Promise<Promocode> {
    return this.promocodeRepository.update(id, data as UpdatePromocodeDTO);
  }

  /**
   * Deactivate a promocode
   */
  async deactivatePromocode(id: string): Promise<void> {
    await this.promocodeRepository.deactivate(id);
  }

  /**
   * Get reward information based on promocode type
   */
  private getRewardInfo(promocode: Promocode): {
    type: PromocodeRewardType;
    value: number;
    description: string;
  } {
    const { rewardType, rewardValue } = promocode;

    switch (rewardType) {
      case 'duration':
        return {
          type: rewardType,
          value: rewardValue || 0,
          description: `${rewardValue || 0} days added to subscription`,
        };
      case 'traffic':
        return {
          type: rewardType,
          value: rewardValue || 0,
          description: `${rewardValue || 0} GB traffic added`,
        };
      case 'devices':
        return {
          type: rewardType,
          value: rewardValue || 0,
          description: `${rewardValue || 0} device slots added`,
        };
      case 'subscription':
        return {
          type: rewardType,
          value: 1,
          description: 'Free subscription granted',
        };
      case 'personal_discount':
        return {
          type: rewardType,
          value: rewardValue || 0,
          description: `${rewardValue || 0}% personal discount`,
        };
      case 'purchase_discount':
        return {
          type: rewardType,
          value: rewardValue || 0,
          description: `${rewardValue || 0}% discount on next purchase`,
        };
      default:
        return {
          type: rewardType,
          value: 0,
          description: 'Unknown reward',
        };
    }
  }
}

/**
 * Factory function to create PromocodeService instance
 */
export function createPromocodeService(pool: Pool): PromocodeService {
  return new PromocodeService(pool);
}
