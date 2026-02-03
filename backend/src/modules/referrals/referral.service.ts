/**
 * Referral Service
 * 
 * Business logic for referral system
 */

import { ReferralRepository, ReferralRuleRepository, ReferralRewardRepository } from '../../repositories/referral.repository.js';
import {
  Referral,
  ReferralRule,
  CreateReferralDto,
  UpdateReferralDto,
  CreateReferralRuleDto,
  UpdateReferralRuleDto,
} from '../../entities/referral.entity.js';


export class ReferralError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'ReferralError';
  }
}

export class ReferralService {
  constructor(
    private readonly referralRepository: ReferralRepository,
    private readonly ruleRepository: ReferralRuleRepository,
    private readonly rewardRepository: ReferralRewardRepository
  ) {}

  /**
   * Get all referral rules
   */
  async getRules(): Promise<ReferralRule[]> {
    return this.ruleRepository.findAll();
  }

  /**
   * Get active rules
   */
  async getActiveRules(): Promise<ReferralRule[]> {
    return this.ruleRepository.findActive();
  }

  /**
   * Get rule by ID
   */
  async getRuleById(id: string): Promise<ReferralRule | null> {
    return this.ruleRepository.findById(id);
  }

  /**
   * Create new rule
   */
  async createRule(data: CreateReferralRuleDto): Promise<ReferralRule> {
    return this.ruleRepository.create(data);
  }

  /**
   * Update rule
   */
  async updateRule(id: string, data: UpdateReferralRuleDto): Promise<ReferralRule> {
    return this.ruleRepository.update(id, data);
  }

  /**
   * Delete rule
   */
  async deleteRule(id: string): Promise<void> {
    await this.ruleRepository.delete(id);
  }

  /**
   * Get all referrals
   */
  async getReferrals(filters: {
    status?: string;
    referrerId?: string;
    referredId?: string;
    page?: number;
    limit?: number;
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
  }): Promise<{ data: Referral[]; total: number; page: number; limit: number }> {
    const page = filters.page || 1;
    const limit = filters.limit || 10;
    
    const result = await this.referralRepository.search({
      status: filters.status,
      referrerId: filters.referrerId,
      referredId: filters.referredId,
      page,
      limit,
      sortBy: filters.sortBy,
      sortOrder: filters.sortOrder,
    });

    return {
      data: result.data,
      total: result.total,
      page,
      limit,
    };
  }

  /**
   * Get referral by ID
   */
  async getReferralById(id: string): Promise<Referral | null> {
    return this.referralRepository.findById(id);
  }

  /**
   * Create referral
   */
  async createReferral(data: CreateReferralDto): Promise<Referral> {
    // Check for self-referral
    if (data.referrerId === data.referredId) {
      throw new ReferralError('Cannot refer yourself');
    }

    // Check if referral already exists
    const exists = await this.referralRepository.existsReferral(data.referrerId, data.referredId);
    if (exists) {
      throw new ReferralError('Referral already exists between these users');
    }

    // Get rule if specified
    let referrerReward = data.referrerReward || 0;
    let referredReward = data.referredReward || 0;
    
    if (data.ruleId) {
      const rule = await this.ruleRepository.findById(data.ruleId);
      if (rule && rule.isActive) {
        referrerReward = rule.referrerReward;
        referredReward = rule.referredReward;
      }
    }

    return this.referralRepository.create({
      ...data,
      referrerReward,
      referredReward,
      status: 'active',
    });
  }

  /**
   * Update referral
   */
  async updateReferral(id: string, data: UpdateReferralDto): Promise<Referral> {
    const updateData: Partial<Referral> = { ...data };

    if (data.status === 'completed' && !data.completedAt) {
      updateData.completedAt = new Date();
    }

    if (data.status === 'cancelled' && !data.cancelledAt) {
      updateData.cancelledAt = new Date();
    }

    return this.referralRepository.update(id, updateData);
  }

  /**
   * Complete referral
   */
  async completeReferral(id: string): Promise<Referral> {
    const referral = await this.referralRepository.findById(id);
    if (!referral) {
      throw new ReferralError('Referral not found');
    }

    if (referral.status !== 'active') {
      throw new ReferralError('Only active referrals can be completed');
    }

    const updatedReferral = await this.referralRepository.update(id, {
      status: 'completed',
      completedAt: new Date(),
    });

    // Create rewards for both parties
    await this.rewardRepository.create({
      referralId: referral.id,
      userId: referral.referrerId,
      amount: referral.referrerReward,
      ruleId: referral.ruleId,
      description: 'Referral reward for referrer',
    });

    await this.rewardRepository.create({
      referralId: referral.id,
      userId: referral.referredId,
      amount: referral.referredReward,
      ruleId: referral.ruleId,
      description: 'Referral reward for referred user',
    });

    return updatedReferral;
  }

  /**
   * Cancel referral
   */
  async cancelReferral(id: string, reason: string): Promise<Referral> {
    const referral = await this.referralRepository.findById(id);
    if (!referral) {
      throw new ReferralError('Referral not found');
    }

    if (referral.status === 'completed') {
      throw new ReferralError('Cannot cancel completed referral');
    }

    return this.referralRepository.update(id, {
      status: 'cancelled',
      cancelledAt: new Date(),
      cancelledReason: reason,
    });
  }

  /**
   * Get referral statistics
   */
  async getStatistics() {
    return this.rewardRepository.getStatistics();
  }

  /**
   * Get rewards by user
   */
  async getUserRewards(userId: string, status?: string) {
    return this.rewardRepository.findByUser(userId, status);
  }

  /**
   * Get top referrers
   */
  async getTopReferrers(limit: number = 10) {
    const stats = await this.rewardRepository.getStatistics();
    return stats.topReferrers.slice(0, limit);
  }
}
