import type { Pool } from 'pg';
import { SubscriptionRepository } from '../../repositories/subscription.repository.js';
import { UserRepository } from '../../repositories/user.repository.js';
import { PlanRepository } from '../../repositories/plan.repository.js';
import { logger } from '../../utils/logger.js';
import type {
  CreateSubscriptionInput,
  UpdateSubscriptionInput,
  GetSubscriptionsQuery,
  SubscriptionResponse,
  ExpiringSubscriptionsQuery,
} from './subscription.schemas.js';
import type { Subscription } from '../../entities/subscription.entity.js';
import type { PaginatedResult } from '../../repositories/base.repository.js';

/**
 * Subscription service configuration
 */
interface SubscriptionServiceConfig {
  subscriptionRepository: SubscriptionRepository;
  userRepository: UserRepository;
  planRepository: PlanRepository;
}

/**
 * Subscription not found error
 */
export class SubscriptionNotFoundError extends Error {
  constructor(subscriptionId: string) {
    super(`Subscription with id ${subscriptionId} not found`);
    this.name = 'SubscriptionNotFoundError';
  }
}

/**
 * Invalid subscription data error
 */
export class InvalidSubscriptionDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSubscriptionDataError';
  }
}

/**
 * Create subscription service factory
 * @param db - PostgreSQL pool instance
 * @returns Subscription service instance
 */
export function createSubscriptionService(db: Pool): SubscriptionService {
  const subscriptionRepository = new SubscriptionRepository(db);
  const userRepository = new UserRepository(db);
  const planRepository = new PlanRepository(db);
  return new SubscriptionService({ subscriptionRepository, userRepository, planRepository });
}

/**
 * Subscription service class
 * Handles all subscription-related business logic
 */
class SubscriptionService {
  private readonly subscriptionRepository: SubscriptionRepository;
  private readonly userRepository: UserRepository;
  private readonly planRepository: PlanRepository;

  constructor(config: SubscriptionServiceConfig) {
    this.subscriptionRepository = config.subscriptionRepository;
    this.userRepository = config.userRepository;
    this.planRepository = config.planRepository;
  }

  /**
   * Map Subscription entity to SubscriptionResponse
   * @param subscription - Subscription entity
   * @returns Subscription response object
   */
  private mapSubscriptionToResponse(subscription: Subscription): SubscriptionResponse {
    return {
      id: subscription.id,
      userId: subscription.userId,
      planId: subscription.planId,
      status: subscription.status,
      startDate: subscription.startDate.toISOString(),
      endDate: subscription.endDate.toISOString(),
      remnawaveUuid: subscription.remnawaveUuid,
      createdAt: subscription.createdAt.toISOString(),
      updatedAt: subscription.updatedAt.toISOString(),
    };
  }

  /**
   * Get subscriptions with pagination and filters
   * @param params - Query parameters
   * @returns Paginated subscriptions
   */
  async getSubscriptions(params: GetSubscriptionsQuery): Promise<PaginatedResult<SubscriptionResponse>> {
    const { page, limit, status, userId, planId } = params;

    // Get all subscriptions and filter manually for complex queries
    let subscriptions: Subscription[];

    if (userId) {
      subscriptions = await this.subscriptionRepository.findByUserId(userId);
    } else if (planId) {
      subscriptions = await this.subscriptionRepository.findByPlanId(planId);
    } else {
      subscriptions = await this.subscriptionRepository.findAll();
    }

    // Apply status filter
    if (status) {
      subscriptions = subscriptions.filter((sub) => sub.status === status);
    }

    // Calculate pagination
    const total = subscriptions.length;
    const totalPages = Math.ceil(total / limit);
    const offset = (page - 1) * limit;
    const paginatedSubscriptions = subscriptions.slice(offset, offset + limit);

    return {
      data: paginatedSubscriptions.map((sub) => this.mapSubscriptionToResponse(sub)),
      total,
      page,
      limit,
      totalPages,
    };
  }

  /**
   * Get subscription by ID
   * @param id - Subscription ID
   * @returns Subscription or null
   */
  async getSubscriptionById(id: string): Promise<SubscriptionResponse | null> {
    const subscription = await this.subscriptionRepository.findById(id);
    return subscription ? this.mapSubscriptionToResponse(subscription) : null;
  }

  /**
   * Create new subscription
   * @param data - Create subscription data
   * @returns Created subscription
   */
  async createSubscription(data: CreateSubscriptionInput): Promise<SubscriptionResponse> {
    // Validate user exists
    const user = await this.userRepository.findById(data.userId);
    if (!user) {
      throw new InvalidSubscriptionDataError(`User with id ${data.userId} not found`);
    }

    // Validate plan exists
    const plan = await this.planRepository.findById(data.planId);
    if (!plan) {
      throw new InvalidSubscriptionDataError(`Plan with id ${data.planId} not found`);
    }

    // Validate dates
    const startDate = new Date(data.startDate);
    const endDate = new Date(data.endDate);

    if (endDate <= startDate) {
      throw new InvalidSubscriptionDataError('End date must be after start date');
    }

    const createData = {
      userId: data.userId,
      planId: data.planId,
      status: data.status,
      startDate,
      endDate,
      remnawaveUuid: data.remnawaveUuid,
      subscriptionType: 'regular' as const,
      deviceCount: 1,
      isTrial: false,
      subscriptionIndex: 0,
      trafficUsedGb: 0,
      promoDiscountPercent: 0,
      promoDiscountAmount: 0,
    };

    const subscription = await this.subscriptionRepository.create(createData);
    logger.info({ subscriptionId: subscription.id, userId: data.userId }, 'Subscription created successfully');

    return this.mapSubscriptionToResponse(subscription);
  }

  /**
   * Update subscription
   * @param id - Subscription ID
   * @param data - Update subscription data
   * @returns Updated subscription
   */
  async updateSubscription(id: string, data: UpdateSubscriptionInput): Promise<SubscriptionResponse> {
    const existingSubscription = await this.subscriptionRepository.findById(id);
    if (!existingSubscription) {
      throw new SubscriptionNotFoundError(id);
    }

    // Validate plan if being updated
    if (data.planId) {
      const plan = await this.planRepository.findById(data.planId);
      if (!plan) {
        throw new InvalidSubscriptionDataError(`Plan with id ${data.planId} not found`);
      }
    }

    // Validate dates if being updated
    if (data.startDate || data.endDate) {
      const startDate = data.startDate ? new Date(data.startDate) : existingSubscription.startDate;
      const endDate = data.endDate ? new Date(data.endDate) : existingSubscription.endDate;

      if (endDate <= startDate) {
        throw new InvalidSubscriptionDataError('End date must be after start date');
      }
    }

    const updateData = {
      planId: data.planId,
      status: data.status,
      startDate: data.startDate ? new Date(data.startDate) : undefined,
      endDate: data.endDate ? new Date(data.endDate) : undefined,
      remnawaveUuid: data.remnawaveUuid,
    };

    const subscription = await this.subscriptionRepository.update(id, updateData);
    logger.info({ subscriptionId: id }, 'Subscription updated successfully');

    return this.mapSubscriptionToResponse(subscription);
  }

  /**
   * Delete subscription
   * @param id - Subscription ID
   * @returns True if deleted
   */
  async deleteSubscription(id: string): Promise<boolean> {
    const existingSubscription = await this.subscriptionRepository.findById(id);
    if (!existingSubscription) {
      throw new SubscriptionNotFoundError(id);
    }

    const deleted = await this.subscriptionRepository.delete(id);
    if (deleted) {
      logger.info({ subscriptionId: id }, 'Subscription deleted successfully');
    }

    return deleted;
  }

  /**
   * Renew subscription (extend end date based on plan duration)
   * @param id - Subscription ID
   * @returns Updated subscription
   */
  async renewSubscription(id: string): Promise<SubscriptionResponse> {
    const existingSubscription = await this.subscriptionRepository.findById(id);
    if (!existingSubscription) {
      throw new SubscriptionNotFoundError(id);
    }

    const plan = await this.planRepository.findById(existingSubscription.planId);
    if (!plan) {
      throw new InvalidSubscriptionDataError('Associated plan not found');
    }

    // Calculate new end date
    const currentEndDate = new Date(existingSubscription.endDate);
    const newEndDate = new Date(currentEndDate);
    newEndDate.setDate(newEndDate.getDate() + plan.durationDays);

    const subscription = await this.subscriptionRepository.update(id, {
      endDate: newEndDate,
      status: 'active',
    });

    logger.info({ subscriptionId: id, newEndDate }, 'Subscription renewed successfully');
    return this.mapSubscriptionToResponse(subscription);
  }

  /**
   * Cancel subscription
   * @param id - Subscription ID
   * @returns Updated subscription
   */
  async cancelSubscription(id: string): Promise<SubscriptionResponse> {
    const existingSubscription = await this.subscriptionRepository.findById(id);
    if (!existingSubscription) {
      throw new SubscriptionNotFoundError(id);
    }

    const subscription = await this.subscriptionRepository.cancelSubscription(id);
    logger.info({ subscriptionId: id }, 'Subscription cancelled successfully');

    return this.mapSubscriptionToResponse(subscription);
  }

  /**
   * Get expiring subscriptions
   * @param params - Query parameters with days
   * @returns Array of expiring subscriptions
   */
  async getExpiringSubscriptions(params: ExpiringSubscriptionsQuery): Promise<SubscriptionResponse[]> {
    const subscriptions = await this.subscriptionRepository.findExpiringSoon(params.days);
    return subscriptions.map((sub) => this.mapSubscriptionToResponse(sub));
  }
}
