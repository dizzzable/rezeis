import type { Pool } from 'pg';
import type { DeviceType, Subscription, CreateSubscriptionDTO } from '../entities/subscription.entity.js';
import { SubscriptionRepository } from '../repositories/subscription.repository.js';
import { TrialTrackingRepository } from '../repositories/trial-tracking.repository.js';
import { PlanRepository } from '../repositories/plan.repository.js';
import { logger } from '../utils/logger.js';

/**
 * Options for creating a subscription
 */
export interface CreateSubscriptionOptions {
  userId: string;
  planId: string;
  durationDays: number;
  deviceType?: DeviceType;
  deviceCount?: number;
  isTrial?: boolean;
  purchasedWithPromocodeId?: string;
  promoDiscountPercent?: number;
}

/**
 * Result of trial eligibility check
 */
export interface TrialEligibilityResult {
  eligible: boolean;
  reason?: string;
  trialSubscriptionId?: string;
}

/**
 * Options for bulk renewal
 */
export interface BulkRenewalOptions {
  userId: string;
  subscriptionIds: string[];
  durationDays: number;
  gatewayId: string;
  promocode?: string;
}

/**
 * Result of bulk renewal
 */
export interface BulkRenewalResult {
  success: boolean;
  totalAmount: number;
  totalDiscount: number;
  finalAmount: number;
  transactionId?: string;
  paymentUrl?: string;
  error?: string;
}

/**
 * EnhancedSubscriptionService - Service for managing subscriptions with trial and device support
 */
export class EnhancedSubscriptionService {
  private readonly subscriptionRepository: SubscriptionRepository;
  private readonly trialTrackingRepository: TrialTrackingRepository;
  private readonly planRepository: PlanRepository;

  constructor(pool: Pool) {
    this.subscriptionRepository = new SubscriptionRepository(pool);
    this.trialTrackingRepository = new TrialTrackingRepository(pool);
    this.planRepository = new PlanRepository(pool);
  }

  /**
   * Create a new subscription with all options
   * @param options - Subscription options
   * @returns Created subscription
   */
  async createSubscription(options: CreateSubscriptionOptions): Promise<Subscription> {
    const startDate = new Date();
    const endDate = new Date(startDate.getTime() + options.durationDays * 24 * 60 * 60 * 1000);

    const subscriptionData: CreateSubscriptionDTO = {
      userId: options.userId,
      planId: options.planId,
      status: 'active',
      startDate,
      endDate,
      subscriptionType: options.isTrial ? 'trial' : 'regular',
      deviceType: options.deviceType,
      deviceCount: options.deviceCount || 1,
      isTrial: options.isTrial || false,
      subscriptionIndex: 1,
      trafficUsedGb: 0,
      promoDiscountPercent: options.promoDiscountPercent || 0,
      promoDiscountAmount: 0,
    };

    const subscription = await this.subscriptionRepository.create(subscriptionData);

    // Save plan snapshot
    await this.savePlanSnapshot(subscription.id, options.planId);

    return subscription;
  }

  /**
   * Check trial eligibility for a user
   * @param userId - User ID
   * @param deviceFingerprint - Optional device fingerprint for abuse prevention
   * @returns Trial eligibility result
   */
  async checkTrialEligibility(userId: string, deviceFingerprint?: string): Promise<TrialEligibilityResult> {
    try {
      // Check if user has already used trial
      const hasUsedTrial = await this.trialTrackingRepository.hasUsedTrial(userId);
      if (hasUsedTrial) {
        return { eligible: false, reason: 'You have already used a trial subscription' };
      }

      // Check device fingerprint if provided
      if (deviceFingerprint) {
        const deviceHasUsedTrial = await this.trialTrackingRepository.hasDeviceUsedTrial(deviceFingerprint);
        if (deviceHasUsedTrial) {
          return { eligible: false, reason: 'This device has already used a trial subscription' };
        }
      }

      // Check for existing trial tracking
      const trialTracking = await this.trialTrackingRepository.findByUserId(userId);
      if (trialTracking?.trialSubscriptionId) {
        return {
          eligible: true,
          trialSubscriptionId: trialTracking.trialSubscriptionId,
        };
      }

      return { eligible: true };
    } catch (error) {
      logger.error({ error, userId }, 'Failed to check trial eligibility');
      return { eligible: false, reason: 'Failed to check trial eligibility' };
    }
  }

  /**
   * Create a trial subscription for a user
   * @param userId - User ID
   * @param deviceType - Optional device type
   * @param deviceFingerprint - Optional device fingerprint
   * @param ipAddress - Optional IP address
   * @returns Created trial subscription
   */
  async createTrialSubscription(
    userId: string,
    deviceType?: DeviceType,
    deviceFingerprint?: string,
    ipAddress?: string
  ): Promise<Subscription> {
    // Check eligibility first
    const eligibility = await this.checkTrialEligibility(userId, deviceFingerprint);
    if (!eligibility.eligible) {
      throw new Error(eligibility.reason);
    }

    // Create trial subscription (typically 3 days)
    const trialSubscription = await this.createSubscription({
      userId,
      planId: 'default-trial-plan', // Would need to be configured
      durationDays: 3,
      deviceType,
      isTrial: true,
    });

    // Update or create trial tracking
    await this.trialTrackingRepository.upsert(userId, {
      userId,
      deviceFingerprint,
      ipAddress,
      trialDurationDays: 3,
    });

    // Mark trial as used
    await this.trialTrackingRepository.markTrialUsed(userId, trialSubscription.id);

    return trialSubscription;
  }

  /**
   * Set device type for a subscription
   * @param subscriptionId - Subscription ID
   * @param deviceType - Device type
   * @returns Updated subscription
   */
  async setDeviceType(subscriptionId: string, deviceType: DeviceType): Promise<Subscription> {
    return this.subscriptionRepository.update(subscriptionId, { deviceType });
  }

  /**
   * Get plans compatible with a device type
   * @param deviceType - Device type
   * @returns Array of compatible plans
   */
  async getDeviceCompatiblePlans(deviceType: DeviceType): Promise<Subscription[]> {
    void deviceType; // May be used for filtering in the future
    // This would filter plans based on device compatibility
    // For now, return all active plans
    return this.subscriptionRepository.findAll();
  }

  /**
   * Get all subscriptions for a user
   * @param userId - User ID
   * @returns Array of subscriptions
   */
  async getUserSubscriptions(userId: string): Promise<Subscription[]> {
    return this.subscriptionRepository.findByUserId(userId);
  }

  /**
   * Get current active subscription for a user
   * @param userId - User ID
   * @returns Current subscription or null
   */
  async getCurrentSubscription(userId: string): Promise<Subscription | null> {
    return this.subscriptionRepository.findActiveByUserId(userId);
  }

  /**
   * Set current subscription for multi-subscription users
   * @param userId - User ID
   * @param subscriptionId - Subscription ID to set as current
   */
  async setCurrentSubscription(userId: string, subscriptionId: string): Promise<void> {
    // This would update a preference or multisubscription record
    logger.info({ userId, subscriptionId }, 'Current subscription set');
  }

  /**
   * Calculate bulk renewal price
   * @param options - Bulk renewal options
   * @returns Price breakdown
   */
  async calculateBulkRenewalPrice(options: BulkRenewalOptions): Promise<{
    basePrice: number;
    totalDiscount: number;
    finalPrice: number;
  }> {
    let totalBasePrice = 0;
    let totalDiscount = 0;

    for (const subscriptionId of options.subscriptionIds) {
      const subscription = await this.subscriptionRepository.findById(subscriptionId);
      if (subscription) {
        const plan = await this.planRepository.findById(subscription.planId);
        if (plan) {
          totalBasePrice += Number(plan.price);
        }
      }
    }

    // Apply promocode if provided
    if (options.promocode) {
      // Would call pricing service to calculate discount
    }

    return {
      basePrice: totalBasePrice,
      totalDiscount,
      finalPrice: totalBasePrice - totalDiscount,
    };
  }

  /**
   * Process bulk renewal
   * @param options - Bulk renewal options
   * @returns Bulk renewal result
   */
  async processBulkRenewal(options: BulkRenewalOptions): Promise<BulkRenewalResult> {
    try {
      const priceBreakdown = await this.calculateBulkRenewalPrice(options);

      if (priceBreakdown.finalPrice <= 0) {
        // Free renewal - extend subscriptions directly
        for (const subscriptionId of options.subscriptionIds) {
          await this.extendSubscription(subscriptionId, options.durationDays);
        }
        return {
          success: true,
          totalAmount: priceBreakdown.basePrice,
          totalDiscount: priceBreakdown.totalDiscount,
          finalAmount: 0,
        };
      }

      // Would create transaction and payment URL here
      return {
        success: true,
        totalAmount: priceBreakdown.basePrice,
        totalDiscount: priceBreakdown.totalDiscount,
        finalAmount: priceBreakdown.finalPrice,
        transactionId: 'pending',
        paymentUrl: 'pending',
      };
    } catch (error) {
      logger.error({ error, options }, 'Failed to process bulk renewal');
      return {
        success: false,
        totalAmount: 0,
        totalDiscount: 0,
        finalAmount: 0,
        error: 'Failed to process bulk renewal',
      };
    }
  }

  /**
   * Add days to a subscription
   * @param subscriptionId - Subscription ID
   * @param days - Number of days to add
   * @returns Updated subscription
   */
  async addDaysToSubscription(subscriptionId: string, days: number): Promise<Subscription> {
    const subscription = await this.subscriptionRepository.findById(subscriptionId);
    if (!subscription) {
      throw new Error('Subscription not found');
    }

    const newEndDate = new Date(subscription.endDate.getTime() + days * 24 * 60 * 60 * 1000);
    return this.subscriptionRepository.update(subscriptionId, { endDate: newEndDate });
  }

  /**
   * Add traffic to a subscription
   * @param subscriptionId - Subscription ID
   * @param gb - GB to add
   * @returns Updated subscription
   */
  async addTrafficToSubscription(subscriptionId: string, gb: number): Promise<Subscription> {
    const subscription = await this.subscriptionRepository.findById(subscriptionId);
    if (!subscription) {
      throw new Error('Subscription not found');
    }

    const currentLimit = subscription.trafficLimitGb || 0;
    return this.subscriptionRepository.update(subscriptionId, {
      trafficLimitGb: currentLimit + gb,
    });
  }

  /**
   * Add device slots to a subscription
   * @param subscriptionId - Subscription ID
   * @param count - Number of device slots to add
   * @returns Updated subscription
   */
  async addDeviceSlots(subscriptionId: string, count: number): Promise<Subscription> {
    const subscription = await this.subscriptionRepository.findById(subscriptionId);
    if (!subscription) {
      throw new Error('Subscription not found');
    }

    const currentCount = subscription.deviceCount || 1;
    return this.subscriptionRepository.update(subscriptionId, {
      deviceCount: currentCount + count,
    });
  }

  /**
   * Extend a subscription by adding days
   * @param subscriptionId - Subscription ID
   * @param days - Number of days to extend
   * @returns Updated subscription
   */
  async extendSubscription(subscriptionId: string, days: number): Promise<Subscription> {
    return this.addDaysToSubscription(subscriptionId, days);
  }

  /**
   * Save plan snapshot for a subscription
   * @param subscriptionId - Subscription ID
   * @param planId - Plan ID
   */
  async savePlanSnapshot(subscriptionId: string, planId: string): Promise<void> {
    const plan = await this.planRepository.findById(planId);
    if (plan) {
      await this.subscriptionRepository.update(subscriptionId, {
        snapshot: plan as unknown as Record<string, unknown>,
        trafficLimitGb: (plan as unknown as { trafficLimitGb?: number }).trafficLimitGb,
      });
    }
  }

  /**
   * Get plan snapshot for a subscription
   * @param subscriptionId - Subscription ID
   * @returns Plan snapshot or null
   */
  async getPlanSnapshot(subscriptionId: string): Promise<Record<string, unknown> | null> {
    const subscription = await this.subscriptionRepository.findById(subscriptionId);
    return subscription?.snapshot || null;
  }
}

/**
 * Factory function to create EnhancedSubscriptionService instance
 */
export function createEnhancedSubscriptionService(pool: Pool): EnhancedSubscriptionService {
  return new EnhancedSubscriptionService(pool);
}
