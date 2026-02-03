import { PartnerRepository } from '../../repositories/partner.repository.js';
import { RepositoryError } from '../../repositories/base.repository.js';
import { logger } from '../../utils/logger.js';
import type {
  Partner,
  PartnerEarning,
  PartnerPayout,
  CreatePartnerDto,
  UpdatePartnerDto,
  PartnerFilters,
  PayoutFilters,
  EarningFilters,
  PartnerStats,
  PartnerDashboard,
  PayoutMethod,
} from '../../entities/partner.entity.js';
import { randomBytes } from 'crypto';

/**
 * Partner Service
 * Business logic for partner program management
 */
export class PartnerService {
  constructor(private readonly partnerRepository: PartnerRepository) {}

  /**
   * Generate a unique referral code
   */
  private generateReferralCode(): string {
    return 'PARTNER-' + randomBytes(4).toString('hex').toUpperCase();
  }

  /**
   * Get all partners with filters
   */
  async getPartners(filters: PartnerFilters): Promise<{ data: Partner[]; total: number }> {
    try {
      return await this.partnerRepository.findWithFilters(filters);
    } catch (error) {
      logger.error({ error, filters }, 'Failed to get partners');
      throw error;
    }
  }

  /**
   * Get partner by ID
   */
  async getPartnerById(id: string): Promise<Partner | null> {
    try {
      return await this.partnerRepository.findById(id);
    } catch (error) {
      logger.error({ error, id }, 'Failed to get partner by ID');
      throw error;
    }
  }

  /**
   * Create a new partner
   */
  async createPartner(data: CreatePartnerDto): Promise<Partner> {
    try {
      // Check if user already has a partner account
      const existingPartner = await this.partnerRepository.findByUserId(data.userId);
      if (existingPartner) {
        throw new RepositoryError('User already has a partner account');
      }

      // Generate referral code if not provided
      const partnerData: CreatePartnerDto = {
        ...data,
        referralCode: data.referralCode || this.generateReferralCode(),
      };

      return await this.partnerRepository.create(partnerData);
    } catch (error) {
      logger.error({ error, data }, 'Failed to create partner');
      throw error;
    }
  }

  /**
   * Update partner
   */
  async updatePartner(id: string, data: UpdatePartnerDto): Promise<Partner> {
    try {
      return await this.partnerRepository.update(id, data);
    } catch (error) {
      logger.error({ error, id, data }, 'Failed to update partner');
      throw error;
    }
  }

  /**
   * Delete partner
   */
  async deletePartner(id: string): Promise<boolean> {
    try {
      return await this.partnerRepository.delete(id);
    } catch (error) {
      logger.error({ error, id }, 'Failed to delete partner');
      throw error;
    }
  }

  /**
   * Approve pending partner
   */
  async approvePartner(id: string): Promise<Partner | null> {
    try {
      const partner = await this.partnerRepository.findById(id);
      if (!partner) {
        throw new RepositoryError('Partner not found');
      }

      if (partner.status !== 'pending') {
        throw new RepositoryError('Only pending partners can be approved');
      }

      return await this.partnerRepository.updateStatus(id, 'active');
    } catch (error) {
      logger.error({ error, id }, 'Failed to approve partner');
      throw error;
    }
  }

  /**
   * Reject pending partner
   */
  async rejectPartner(id: string): Promise<Partner | null> {
    try {
      const partner = await this.partnerRepository.findById(id);
      if (!partner) {
        throw new RepositoryError('Partner not found');
      }

      if (partner.status !== 'pending') {
        throw new RepositoryError('Only pending partners can be rejected');
      }

      return await this.partnerRepository.updateStatus(id, 'rejected');
    } catch (error) {
      logger.error({ error, id }, 'Failed to reject partner');
      throw error;
    }
  }

  /**
   * Suspend active partner
   */
  async suspendPartner(id: string): Promise<Partner | null> {
    try {
      const partner = await this.partnerRepository.findById(id);
      if (!partner) {
        throw new RepositoryError('Partner not found');
      }

      if (partner.status !== 'active') {
        throw new RepositoryError('Only active partners can be suspended');
      }

      return await this.partnerRepository.updateStatus(id, 'suspended');
    } catch (error) {
      logger.error({ error, id }, 'Failed to suspend partner');
      throw error;
    }
  }

  /**
   * Get partner earnings
   */
  async getPartnerEarnings(partnerId: string, filters: Omit<EarningFilters, 'partnerId'>): Promise<{ data: PartnerEarning[]; total: number }> {
    try {
      return await this.partnerRepository.getEarnings({ ...filters, partnerId });
    } catch (error) {
      logger.error({ error, partnerId }, 'Failed to get partner earnings');
      throw error;
    }
  }

  /**
   * Create partner earning
   */
  async createEarning(
    partnerId: string,
    referredUserId: string | null,
    subscriptionId: string | null,
    amount: number
  ): Promise<PartnerEarning> {
    try {
      const partner = await this.partnerRepository.findById(partnerId);
      if (!partner) {
        throw new RepositoryError('Partner not found');
      }

      const earningAmount = (amount * partner.commissionRate) / 100;

      const earning = await this.partnerRepository.createEarning({
        partnerId,
        referredUserId,
        subscriptionId,
        amount: earningAmount,
        commissionRate: partner.commissionRate,
        status: 'pending',
      });

      // Update partner totals
      await this.partnerRepository.updateEarningsTotals(
        partnerId,
        partner.totalEarnings + earningAmount,
        partner.pendingEarnings + earningAmount
      );

      // Increment referral count if it's a new referral
      if (referredUserId) {
        await this.partnerRepository.incrementReferralCount(partnerId);
      }

      return earning;
    } catch (error) {
      logger.error({ error, partnerId, amount }, 'Failed to create earning');
      throw error;
    }
  }

  /**
   * Get partner payouts
   */
  async getPartnerPayouts(partnerId: string, filters: Omit<PayoutFilters, 'partnerId'>): Promise<{ data: PartnerPayout[]; total: number }> {
    try {
      return await this.partnerRepository.getPayouts({ ...filters, partnerId });
    } catch (error) {
      logger.error({ error, partnerId }, 'Failed to get partner payouts');
      throw error;
    }
  }

  /**
   * Create payout request
   */
  async createPayout(partnerId: string, amount: number, method: PayoutMethod, notes?: string): Promise<PartnerPayout> {
    try {
      const partner = await this.partnerRepository.findById(partnerId);
      if (!partner) {
        throw new RepositoryError('Partner not found');
      }

      if (partner.pendingEarnings < amount) {
        throw new RepositoryError('Insufficient pending earnings for payout');
      }

      const payout = await this.partnerRepository.createPayout({
        partnerId,
        amount,
        method,
        status: 'pending',
        transactionId: null,
        notes: notes || null,
      });

      return payout;
    } catch (error) {
      logger.error({ error, partnerId, amount }, 'Failed to create payout');
      throw error;
    }
  }

  /**
   * Process payout (approve and mark as paid)
   */
  async processPayout(payoutId: string, transactionId?: string, _notes?: string): Promise<PartnerPayout | null> {
    try {
      const payouts = await this.partnerRepository.getPayouts({ page: 1, limit: 1 });
      const payout = payouts.data.find(p => p.id === payoutId);
      
      if (!payout) {
        throw new RepositoryError('Payout not found');
      }

      if (payout.status !== 'pending') {
        throw new RepositoryError('Only pending payouts can be processed');
      }

      const partner = await this.partnerRepository.findById(payout.partnerId);
      if (!partner) {
        throw new RepositoryError('Partner not found');
      }

      // Update payout status
      const updatedPayout = await this.partnerRepository.updatePayoutStatus(
        payoutId,
        'completed',
        transactionId,
        new Date()
      );

      if (updatedPayout) {
        // Update partner earnings
        await this.partnerRepository.updateEarningsTotals(
          payout.partnerId,
          partner.totalEarnings,
          partner.pendingEarnings - payout.amount
        );

        // Also update paid_earnings
        await this.partnerRepository.update(payout.partnerId, {
          paidEarnings: partner.paidEarnings + payout.amount,
        });
      }

      return updatedPayout;
    } catch (error) {
      logger.error({ error, payoutId }, 'Failed to process payout');
      throw error;
    }
  }

  /**
   * Get partner program statistics
   */
  async getPartnerStats(): Promise<PartnerStats> {
    try {
      return await this.partnerRepository.getPartnerStats();
    } catch (error) {
      logger.error({ error }, 'Failed to get partner stats');
      throw error;
    }
  }

  /**
   * Get partner dashboard
   */
  async getPartnerDashboard(partnerId: string): Promise<PartnerDashboard | null> {
    try {
      const partner = await this.partnerRepository.findById(partnerId);
      if (!partner) {
        return null;
      }

      const earnings = await this.partnerRepository.getEarnings({ partnerId, page: 1, limit: 10 });
      const payouts = await this.partnerRepository.getPayouts({ partnerId, page: 1, limit: 10 });

      return {
        partner,
        earnings: {
          total: partner.totalEarnings,
          paid: partner.paidEarnings,
          pending: partner.pendingEarnings,
        },
        recentEarnings: earnings.data,
        recentPayouts: payouts.data,
        referrals: partner.referralCount,
      };
    } catch (error) {
      logger.error({ error, partnerId }, 'Failed to get partner dashboard');
      throw error;
    }
  }

  /**
   * Find partner by referral code
   */
  async findByReferralCode(code: string): Promise<Partner | null> {
    try {
      return await this.partnerRepository.findByReferralCode(code);
    } catch (error) {
      logger.error({ error, code }, 'Failed to find partner by referral code');
      throw error;
    }
  }
}
