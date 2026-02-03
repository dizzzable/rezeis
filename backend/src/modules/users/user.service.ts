import type { Pool } from 'pg';
import { UserRepository } from '../../repositories/user.repository.js';
import { SubscriptionRepository } from '../../repositories/subscription.repository.js';
import { PartnerRepository } from '../../repositories/partner.repository.js';
import { ReferralRepository, ReferralRewardRepository } from '../../repositories/referral.repository.js';
import { hashPassword } from '../../utils/password.js';
import { logger } from '../../utils/logger.js';
import type {
  CreateUserInput,
  UpdateUserInput,
  GetUsersQuery,
  UserResponse,
  UserDetailsResponse,
} from './user.schemas.js';
import type { User, UserFilters } from '../../entities/user.entity.js';
import type { Subscription } from '../../entities/subscription.entity.js';
import type { PaginatedResult } from '../../repositories/base.repository.js';

/**
 * User service configuration
 */
interface UserServiceConfig {
  userRepository: UserRepository;
  subscriptionRepository: SubscriptionRepository;
  partnerRepository: PartnerRepository;
  referralRepository: ReferralRepository;
  referralRewardRepository: ReferralRewardRepository;
}

/**
 * User not found error
 */
export class UserNotFoundError extends Error {
  constructor(userId: string) {
    super(`User with id ${userId} not found`);
    this.name = 'UserNotFoundError';
  }
}

/**
 * User already exists error
 */
export class UserAlreadyExistsError extends Error {
  constructor(field: string, value: string) {
    super(`User with ${field} '${value}' already exists`);
    this.name = 'UserAlreadyExistsError';
  }
}

/**
 * Create user service factory
 * @param db - PostgreSQL pool instance
 * @returns User service instance
 */
export function createUserService(db: Pool): UserService {
  const userRepository = new UserRepository(db);
  const subscriptionRepository = new SubscriptionRepository(db);
  const partnerRepository = new PartnerRepository(db);
  const referralRepository = new ReferralRepository(db);
  const referralRewardRepository = new ReferralRewardRepository(db);
  return new UserService({
    userRepository,
    subscriptionRepository,
    partnerRepository,
    referralRepository,
    referralRewardRepository,
  });
}

/**
 * User service class
 * Handles all user-related business logic
 */
class UserService {
  private readonly userRepository: UserRepository;
  private readonly subscriptionRepository: SubscriptionRepository;
  private readonly partnerRepository: PartnerRepository;
  private readonly referralRepository: ReferralRepository;
  private readonly referralRewardRepository: ReferralRewardRepository;

  constructor(config: UserServiceConfig) {
    this.userRepository = config.userRepository;
    this.subscriptionRepository = config.subscriptionRepository;
    this.partnerRepository = config.partnerRepository;
    this.referralRepository = config.referralRepository;
    this.referralRewardRepository = config.referralRewardRepository;
  }

  /**
   * Map User entity to UserResponse
   * @param user - User entity
   * @returns User response object
   */
  private mapUserToResponse(user: User): UserResponse {
    return {
      id: user.id,
      username: user.username,
      telegramId: user.telegramId,
      firstName: user.firstName,
      lastName: user.lastName,
      photoUrl: user.photoUrl,
      role: user.role,
      isActive: user.isActive,
      lastLoginAt: user.lastLoginAt?.toISOString(),
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
    };
  }

  /**
   * Get users with pagination and filters
   * @param params - Query parameters
   * @returns Paginated users
   */
  async getUsers(params: GetUsersQuery): Promise<PaginatedResult<UserResponse>> {
    const filters: UserFilters = {};

    if (params.role) {
      filters.role = params.role;
    }

    if (params.isActive !== undefined) {
      filters.isActive = params.isActive;
    }

    if (params.search) {
      filters.search = params.search;
    }

    const result = await this.userRepository.getUsersWithPagination(
      params.page,
      params.limit,
      Object.keys(filters).length > 0 ? filters : undefined
    );

    return {
      data: result.data.map((user) => this.mapUserToResponse(user)),
      total: result.total,
      page: result.page,
      limit: result.limit,
      totalPages: result.totalPages,
    };
  }

  /**
   * Get user by ID
   * @param id - User ID
   * @returns User or null
   */
  async getUserById(id: string): Promise<UserResponse | null> {
    const user = await this.userRepository.findById(id);
    return user ? this.mapUserToResponse(user) : null;
  }

  /**
   * Create new user
   * @param data - Create user data
   * @returns Created user
   */
  async createUser(data: CreateUserInput): Promise<UserResponse> {
    // Check if username already exists
    const existingByUsername = await this.userRepository.findByUsername(data.username);
    if (existingByUsername) {
      throw new UserAlreadyExistsError('username', data.username);
    }

    // Check if telegramId already exists
    if (data.telegramId) {
      const existingByTelegram = await this.userRepository.findByTelegramId(data.telegramId);
      if (existingByTelegram) {
        throw new UserAlreadyExistsError('telegramId', data.telegramId);
      }
    }

    // Hash password if provided
    let passwordHash: string | undefined;
    if (data.password) {
      passwordHash = await hashPassword(data.password);
    }

    const createData = {
      username: data.username,
      passwordHash,
      telegramId: data.telegramId,
      firstName: data.firstName,
      lastName: data.lastName,
      photoUrl: data.photoUrl,
      role: data.role,
      isActive: data.isActive,
    };

    const user = await this.userRepository.create(createData);
    logger.info({ userId: user.id }, 'User created successfully');

    return this.mapUserToResponse(user);
  }

  /**
   * Update user
   * @param id - User ID
   * @param data - Update user data
   * @returns Updated user
   */
  async updateUser(id: string, data: UpdateUserInput): Promise<UserResponse> {
    const existingUser = await this.userRepository.findById(id);
    if (!existingUser) {
      throw new UserNotFoundError(id);
    }

    // Check if username is being changed and if it already exists
    if (data.username && data.username !== existingUser.username) {
      const existingByUsername = await this.userRepository.findByUsername(data.username);
      if (existingByUsername) {
        throw new UserAlreadyExistsError('username', data.username);
      }
    }

    const updateData = {
      username: data.username,
      firstName: data.firstName,
      lastName: data.lastName,
      photoUrl: data.photoUrl,
      role: data.role,
      isActive: data.isActive,
    };

    const user = await this.userRepository.update(id, updateData);
    logger.info({ userId: id }, 'User updated successfully');

    return this.mapUserToResponse(user);
  }

  /**
   * Delete user
   * @param id - User ID
   * @returns True if deleted
   */
  async deleteUser(id: string): Promise<boolean> {
    const existingUser = await this.userRepository.findById(id);
    if (!existingUser) {
      throw new UserNotFoundError(id);
    }

    const deleted = await this.userRepository.delete(id);
    if (deleted) {
      logger.info({ userId: id }, 'User deleted successfully');
    }

    return deleted;
  }

  /**
   * Block user
   * @param id - User ID
   * @returns Updated user
   */
  async blockUser(id: string): Promise<UserResponse> {
    const existingUser = await this.userRepository.findById(id);
    if (!existingUser) {
      throw new UserNotFoundError(id);
    }

    const user = await this.userRepository.update(id, { isActive: false });
    logger.info({ userId: id }, 'User blocked successfully');

    return this.mapUserToResponse(user);
  }

  /**
   * Unblock user
   * @param id - User ID
   * @returns Updated user
   */
  async unblockUser(id: string): Promise<UserResponse> {
    const existingUser = await this.userRepository.findById(id);
    if (!existingUser) {
      throw new UserNotFoundError(id);
    }

    const user = await this.userRepository.update(id, { isActive: true });
    logger.info({ userId: id }, 'User unblocked successfully');

    return this.mapUserToResponse(user);
  }

  /**
   * Get user subscriptions
   * @param id - User ID
   * @returns Array of subscriptions
   */
  async getUserSubscriptions(id: string): Promise<Subscription[]> {
    const existingUser = await this.userRepository.findById(id);
    if (!existingUser) {
      throw new UserNotFoundError(id);
    }

    return this.subscriptionRepository.findByUserId(id);
  }

  /**
   * Get comprehensive user details
   * @param id - User ID
   * @returns User details with all related data
   */
  async getUserDetails(id: string): Promise<UserDetailsResponse['data']> {
    const existingUser = await this.userRepository.findById(id);
    if (!existingUser) {
      throw new UserNotFoundError(id);
    }

    // Fetch all related data in parallel
    const [
      subscriptions,
      partner,
      referralsSent,
      referralsReceived,
      referralRewards,
    ] = await Promise.all([
      this.subscriptionRepository.findByUserId(id),
      this.partnerRepository.findByUserId(id),
      this.referralRepository.findByReferrer(id),
      this.referralRepository.findByReferred(id),
      this.referralRewardRepository.findByUser(id),
    ]);

    // Get plan names for subscriptions
    const subscriptionsWithPlan = subscriptions.map((sub) => ({
      id: sub.id,
      userId: sub.userId,
      planId: sub.planId,
      planName: 'Plan', // Will be fetched from plan repository if needed
      planPrice: 0, // Will be fetched from plan repository if needed
      status: sub.status,
      startDate: sub.startDate.toISOString(),
      endDate: sub.endDate.toISOString(),
      remnawaveUuid: sub.remnawaveUuid,
      createdAt: sub.createdAt.toISOString(),
      updatedAt: sub.updatedAt.toISOString(),
    }));

    // Calculate stats
    const totalSpent = 0; // Will be calculated from payments when implemented
    const partnerEarnings = partner?.totalEarnings || 0;
    const referralsCount = referralsSent.length;
    const rewardsEarned = referralRewards.reduce((sum, r) => sum + r.amount, 0);

    // Map partner data
    const partnerInfo = partner
      ? {
          id: partner.id,
          userId: partner.userId,
          commissionRate: partner.commissionRate,
          totalEarnings: partner.totalEarnings,
          paidEarnings: partner.paidEarnings,
          pendingEarnings: partner.pendingEarnings,
          referralCode: partner.referralCode,
          referralCount: partner.referralCount,
          status: partner.status,
          createdAt: partner.createdAt.toISOString(),
          updatedAt: partner.updatedAt.toISOString(),
        }
      : null;

    // Get partner earnings
    const partnerEarningsData = partner
      ? await this.partnerRepository.getEarnings({ partnerId: partner.id, limit: 10 })
      : { data: [] };

    return {
      user: this.mapUserToResponse(existingUser),
      subscriptions: subscriptionsWithPlan,
      partner: partnerInfo,
      partnerEarnings: partnerEarningsData.data.map((e) => ({
        id: e.id,
        partnerId: e.partnerId,
        amount: e.amount,
        status: e.status,
        createdAt: e.createdAt.toISOString(),
      })),
      referralsSent: referralsSent.map((r) => ({
        id: r.id,
        referrerId: r.referrerId,
        referredId: r.referredId,
        referralCode: r.referralCode,
        status: r.status,
        referrerReward: r.referrerReward,
        referredReward: r.referredReward,
        createdAt: r.createdAt.toISOString(),
        completedAt: r.completedAt?.toISOString(),
      })),
      referralsReceived: referralsReceived.length > 0
        ? {
            id: referralsReceived[0].id,
            referrerId: referralsReceived[0].referrerId,
            referredId: referralsReceived[0].referredId,
            referralCode: referralsReceived[0].referralCode,
            status: referralsReceived[0].status,
            referrerReward: referralsReceived[0].referrerReward,
            referredReward: referralsReceived[0].referredReward,
            createdAt: referralsReceived[0].createdAt.toISOString(),
            completedAt: referralsReceived[0].completedAt?.toISOString(),
          }
        : null,
      referralRewards: referralRewards.map((r) => ({
        id: r.id,
        referralId: r.referralId,
        userId: r.userId,
        amount: r.amount,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
        paidAt: r.paidAt?.toISOString(),
      })),
      activity: [], // Will be implemented when activity log table is created
      stats: {
        totalSubscriptions: subscriptions.length,
        activeSubscriptions: subscriptions.filter((s) => s.status === 'active').length,
        totalSpent,
        partnerEarnings,
        referralsCount,
        rewardsEarned,
      },
    };
  }
}
