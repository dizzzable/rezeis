import type { Pool } from 'pg';
import { PlanRepository } from '../repositories/plan.repository.js';
import { UserPersonalDiscountRepository } from '../repositories/user-personal-discount.repository.js';
import { UserRepository } from '../repositories/user.repository.js';
import { logger } from '../utils/logger.js';

/**
 * Price breakdown structure
 */
export interface PriceBreakdown {
  basePrice: number;
  bundleDiscount: number;
  personalDiscount: number;
  purchaseDiscount: number;
  promocodeDiscount: number;
  totalDiscount: number;
  finalPrice: number;
  currency: string;
  appliedDiscounts: AppliedDiscount[];
}

/**
 * Applied discount information
 */
export interface AppliedDiscount {
  type: 'bundle' | 'personal' | 'purchase' | 'promocode';
  value: number;
  description: string;
}

/**
 * Options for calculating price
 */
export interface CalculatePriceOptions {
  userId: string;
  planId: string;
  durationId: string;
  quantity?: number;
  promocode?: string;
  isRenewal?: boolean;
}

/**
 * Plan duration info
 */
export interface PlanDurationInfo {
  id: string;
  durationDays: number;
  discountPercent: number;
  price: number;
}

/**
 * PricingService - Service for complex pricing calculations
 */
export class PricingService {
  private readonly planRepository: PlanRepository;
  private readonly personalDiscountRepository: UserPersonalDiscountRepository;
  private readonly userRepository: UserRepository;

  constructor(pool: Pool) {
    this.planRepository = new PlanRepository(pool);
    this.personalDiscountRepository = new UserPersonalDiscountRepository(pool);
    this.userRepository = new UserRepository(pool);
  }

  /**
   * Calculate final price with all discounts
   * @param options - Price calculation options
   * @returns Price breakdown
   */
  async calculatePrice(options: CalculatePriceOptions): Promise<PriceBreakdown> {
    const appliedDiscounts: AppliedDiscount[] = [];
    let basePrice = 0;
    let bundleDiscount = 0;
    let personalDiscount = 0;
    let purchaseDiscount = 0;
    let promocodeDiscount = 0;

    // Get base price from plan duration
    const basePlanPrice = await this.getPlanDurationPrice(options.planId, options.durationId);
    basePrice = basePlanPrice * (options.quantity || 1);

    // Calculate bundle discount (quantity-based)
    if (options.quantity && options.quantity > 1) {
      const bundleResult = await this.calculateBundleDiscount(options.planId, options.quantity, basePlanPrice);
      bundleDiscount = bundleResult.discount;
      if (bundleDiscount > 0) {
        appliedDiscounts.push({
          type: 'bundle',
          value: bundleDiscount,
          description: `Bundle discount (${options.quantity}x)`,
        });
      }
    }

    // Calculate personal discount
    personalDiscount = await this.getPersonalDiscount(options.userId);
    if (personalDiscount > 0) {
      const discountAmount = (basePrice - bundleDiscount) * (personalDiscount / 100);
      appliedDiscounts.push({
        type: 'personal',
        value: discountAmount,
        description: `Personal discount (${personalDiscount}%)`,
      });
    }

    // Calculate purchase discount (one-time)
    const purchaseDiscountInfo = await this.getPurchaseDiscount(options.userId);
    if (purchaseDiscountInfo.percent > 0) {
      purchaseDiscount = (basePrice - bundleDiscount - personalDiscount) * (purchaseDiscountInfo.percent / 100);
      appliedDiscounts.push({
        type: 'purchase',
        value: purchaseDiscount,
        description: `First purchase discount (${purchaseDiscountInfo.percent}%)`,
      });
    }

    // Calculate promocode discount
    if (options.promocode) {
      const promocodeResult = await this.calculatePromocodeDiscount(
        options.promocode,
        basePrice - bundleDiscount - personalDiscount - purchaseDiscount,
        options.userId
      );
      promocodeDiscount = promocodeResult.discount;
      if (promocodeDiscount > 0) {
        appliedDiscounts.push({
          type: 'promocode',
          value: promocodeDiscount,
          description: `Promocode discount (${promocodeResult.type})`,
        });
      }
    }

    const totalDiscount = bundleDiscount + personalDiscount + purchaseDiscount + promocodeDiscount;
    const finalPrice = Math.max(0, basePrice - totalDiscount);

    return {
      basePrice,
      bundleDiscount,
      personalDiscount,
      purchaseDiscount,
      promocodeDiscount,
      totalDiscount,
      finalPrice,
      currency: 'USD',
      appliedDiscounts,
    };
  }

  /**
   * Calculate bundle discount based on quantity
   * @param planId - Plan ID
   * @param quantity - Number of subscriptions
   * @param basePrice - Base price per subscription
   * @returns Bundle discount info
   */
  async calculateBundleDiscount(planId: string, quantity: number, basePrice: number): Promise<{
    discount: number;
    percent: number;
    ruleId?: string;
  }> {
    // Bundle discount rules (could be database-driven)
    const bundleRules = [
      { quantity: 2, discountPercent: 5 },
      { quantity: 3, discountPercent: 10 },
      { quantity: 5, discountPercent: 15 },
      { quantity: 10, discountPercent: 25 },
    ];

    const applicableRule = bundleRules
      .filter((rule) => quantity >= rule.quantity)
      .sort((a, b) => b.quantity - a.quantity)[0];

    if (!applicableRule) {
      return { discount: 0, percent: 0 };
    }

    const totalBasePrice = basePrice * quantity;
    const discount = (totalBasePrice * applicableRule.discountPercent) / 100;

    return {
      discount,
      percent: applicableRule.discountPercent,
    };
  }

  /**
   * Get personal discount for a user
   * @param userId - User ID
   * @returns Personal discount percentage
   */
  async getPersonalDiscount(userId: string): Promise<number> {
    // Check user_personal_discounts table
    const personalDiscount = await this.personalDiscountRepository.getActiveDiscountPercent(userId);
    if (personalDiscount > 0) {
      return personalDiscount;
    }

    // Fall back to user table discount field
    const user = await this.userRepository.findById(userId);
    const userData = user as unknown as { personalDiscountPercent?: number };
    return userData?.personalDiscountPercent || 0;
  }

  /**
   * Get purchase discount for a user (one-time)
   * @param userId - User ID
   * @returns Purchase discount info
   */
  async getPurchaseDiscount(userId: string): Promise<{
    percent: number;
    expiresAt?: Date;
  }> {
    const user = await this.userRepository.findById(userId);
    if (!user) {
      return { percent: 0 };
    }

    const userData = user as unknown as { purchaseDiscountPercent?: number; purchaseDiscountExpiresAt?: Date };

    // Check if purchase discount is valid
    if ((userData.purchaseDiscountPercent || 0) <= 0) {
      return { percent: 0 };
    }

    if (userData.purchaseDiscountExpiresAt && userData.purchaseDiscountExpiresAt < new Date()) {
      return { percent: 0 };
    }

    return {
      percent: userData.purchaseDiscountPercent || 0,
      expiresAt: userData.purchaseDiscountExpiresAt,
    };
  }

  /**
   * Calculate promocode discount
   * @param code - Promocode code
   * @param amount - Amount to apply discount to
   * @param userId - User ID
   * @returns Promocode discount info
   */
  async calculatePromocodeDiscount(code: string, amount: number, userId: string): Promise<{
    discount: number;
    type: 'percentage' | 'fixed';
    promocodeId?: string;
  }> {
    // Would integrate with PromocodeService
    logger.info({ code, amount, userId }, 'Calculating promocode discount');
    return { discount: 0, type: 'percentage' };
  }

  /**
   * Get price for a plan duration
   * @param planId - Plan ID
   * @param durationId - Duration ID
   * @returns Price
   */
  async getPlanDurationPrice(planId: string, _durationId: string): Promise<number> {
    // Would look up plan price from database
    // For now, return placeholder
    const plan = await this.planRepository.findById(planId);
    if (plan) {
      return Number(plan.price);
    }
    return 0;
  }

  /**
   * Get available durations for a plan
   * @param planId - Plan ID
   * @returns Array of duration options
   */
  async getPlanDurations(planId: string): Promise<PlanDurationInfo[]> {
    // Would look up plan durations from database
    logger.info({ planId }, 'Getting plan durations');
    return [
      { id: '1', durationDays: 30, discountPercent: 0, price: 10 },
      { id: '2', durationDays: 90, discountPercent: 10, price: 27 },
      { id: '3', durationDays: 180, discountPercent: 15, price: 51 },
      { id: '4', durationDays: 365, discountPercent: 25, price: 90 },
    ];
  }
}

/**
 * Factory function to create PricingService instance
 */
export function createPricingService(pool: Pool): PricingService {
  return new PricingService(pool);
}
