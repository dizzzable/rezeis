import type { FastifyRequest, FastifyReply } from 'fastify';
import { PartnerService } from './partner.service.js';
import { RepositoryError } from '../../repositories/base.repository.js';
import { logger } from '../../utils/logger.js';
import type {
  CreatePartnerBody,
  UpdatePartnerBody,
  PartnerIdParams,
  PayoutIdParams,
  PartnerFiltersQuery,
  CreatePayoutBody,
  ProcessPayoutBody,
  EarningFiltersQuery,
  PayoutFiltersQuery,
} from './partner.schemas.js';

/**
 * Partner Controller
 * Handles HTTP requests for partner management
 */
export class PartnerController {
  constructor(private readonly partnerService: PartnerService) {}

  /**
   * Get all partners with filters
   */
  getPartners = async (
    req: FastifyRequest<{ Querystring: PartnerFiltersQuery }>,
    reply: FastifyReply
  ): Promise<void> => {
    try {
      const result = await this.partnerService.getPartners(req.query);
      reply.send({
        success: true,
        data: result.data,
        total: result.total,
        page: req.query.page || 1,
        limit: req.query.limit || 10,
        totalPages: Math.ceil(result.total / (req.query.limit || 10)),
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get partners');
      reply.status(500).send({
        success: false,
        message: 'Failed to get partners',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };

  /**
   * Get partner by ID
   */
  getPartnerById = async (
    req: FastifyRequest<{ Params: PartnerIdParams }>,
    reply: FastifyReply
  ): Promise<void> => {
    try {
      const partner = await this.partnerService.getPartnerById(req.params.id);
      if (!partner) {
        reply.status(404).send({
          success: false,
          message: 'Partner not found',
        });
        return;
      }
      reply.send({
        success: true,
        data: partner,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get partner');
      reply.status(500).send({
        success: false,
        message: 'Failed to get partner',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };

  /**
   * Create new partner
   */
  createPartner = async (
    req: FastifyRequest<{ Body: CreatePartnerBody }>,
    reply: FastifyReply
  ): Promise<void> => {
    try {
      const partner = await this.partnerService.createPartner(req.body);
      reply.status(201).send({
        success: true,
        data: partner,
        message: 'Partner created successfully',
      });
    } catch (error) {
      if (error instanceof RepositoryError && error.message.includes('already has a partner account')) {
        reply.status(409).send({
          success: false,
          message: error.message,
        });
        return;
      }
      logger.error({ error }, 'Failed to create partner');
      reply.status(500).send({
        success: false,
        message: 'Failed to create partner',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };

  /**
   * Update partner
   */
  updatePartner = async (
    req: FastifyRequest<{ Params: PartnerIdParams; Body: UpdatePartnerBody }>,
    reply: FastifyReply
  ): Promise<void> => {
    try {
      const partner = await this.partnerService.updatePartner(req.params.id, req.body);
      reply.send({
        success: true,
        data: partner,
        message: 'Partner updated successfully',
      });
    } catch (error) {
      logger.error({ error }, 'Failed to update partner');
      reply.status(500).send({
        success: false,
        message: 'Failed to update partner',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };

  /**
   * Delete partner
   */
  deletePartner = async (
    req: FastifyRequest<{ Params: PartnerIdParams }>,
    reply: FastifyReply
  ): Promise<void> => {
    try {
      const deleted = await this.partnerService.deletePartner(req.params.id);
      if (!deleted) {
        reply.status(404).send({
          success: false,
          message: 'Partner not found',
        });
        return;
      }
      reply.send({
        success: true,
        message: 'Partner deleted successfully',
      });
    } catch (error) {
      logger.error({ error }, 'Failed to delete partner');
      reply.status(500).send({
        success: false,
        message: 'Failed to delete partner',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };

  /**
   * Approve partner
   */
  approvePartner = async (
    req: FastifyRequest<{ Params: PartnerIdParams }>,
    reply: FastifyReply
  ): Promise<void> => {
    try {
      const partner = await this.partnerService.approvePartner(req.params.id);
      if (!partner) {
        reply.status(404).send({
          success: false,
          message: 'Partner not found',
        });
        return;
      }
      reply.send({
        success: true,
        data: partner,
        message: 'Partner approved successfully',
      });
    } catch (error) {
      if (error instanceof RepositoryError) {
        reply.status(400).send({
          success: false,
          message: error.message,
        });
        return;
      }
      logger.error({ error }, 'Failed to approve partner');
      reply.status(500).send({
        success: false,
        message: 'Failed to approve partner',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };

  /**
   * Reject partner
   */
  rejectPartner = async (
    req: FastifyRequest<{ Params: PartnerIdParams }>,
    reply: FastifyReply
  ): Promise<void> => {
    try {
      const partner = await this.partnerService.rejectPartner(req.params.id);
      if (!partner) {
        reply.status(404).send({
          success: false,
          message: 'Partner not found',
        });
        return;
      }
      reply.send({
        success: true,
        data: partner,
        message: 'Partner rejected successfully',
      });
    } catch (error) {
      if (error instanceof RepositoryError) {
        reply.status(400).send({
          success: false,
          message: error.message,
        });
        return;
      }
      logger.error({ error }, 'Failed to reject partner');
      reply.status(500).send({
        success: false,
        message: 'Failed to reject partner',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };

  /**
   * Suspend partner
   */
  suspendPartner = async (
    req: FastifyRequest<{ Params: PartnerIdParams }>,
    reply: FastifyReply
  ): Promise<void> => {
    try {
      const partner = await this.partnerService.suspendPartner(req.params.id);
      if (!partner) {
        reply.status(404).send({
          success: false,
          message: 'Partner not found',
        });
        return;
      }
      reply.send({
        success: true,
        data: partner,
        message: 'Partner suspended successfully',
      });
    } catch (error) {
      if (error instanceof RepositoryError) {
        reply.status(400).send({
          success: false,
          message: error.message,
        });
        return;
      }
      logger.error({ error }, 'Failed to suspend partner');
      reply.status(500).send({
        success: false,
        message: 'Failed to suspend partner',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };

  /**
   * Get partner earnings
   */
  getPartnerEarnings = async (
    req: FastifyRequest<{ Params: PartnerIdParams; Querystring: EarningFiltersQuery }>,
    reply: FastifyReply
  ): Promise<void> => {
    try {
      const result = await this.partnerService.getPartnerEarnings(req.params.id, req.query);
      reply.send({
        success: true,
        data: result.data,
        total: result.total,
        page: req.query.page || 1,
        limit: req.query.limit || 10,
        totalPages: Math.ceil(result.total / (req.query.limit || 10)),
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get partner earnings');
      reply.status(500).send({
        success: false,
        message: 'Failed to get partner earnings',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };

  /**
   * Get partner payouts
   */
  getPartnerPayouts = async (
    req: FastifyRequest<{ Params: PartnerIdParams; Querystring: PayoutFiltersQuery }>,
    reply: FastifyReply
  ): Promise<void> => {
    try {
      const result = await this.partnerService.getPartnerPayouts(req.params.id, req.query);
      reply.send({
        success: true,
        data: result.data,
        total: result.total,
        page: req.query.page || 1,
        limit: req.query.limit || 10,
        totalPages: Math.ceil(result.total / (req.query.limit || 10)),
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get partner payouts');
      reply.status(500).send({
        success: false,
        message: 'Failed to get partner payouts',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };

  /**
   * Create payout
   */
  createPayout = async (
    req: FastifyRequest<{ Params: PartnerIdParams; Body: CreatePayoutBody }>,
    reply: FastifyReply
  ): Promise<void> => {
    try {
      const payout = await this.partnerService.createPayout(
        req.params.id,
        req.body.amount,
        req.body.method,
        req.body.notes
      );
      reply.status(201).send({
        success: true,
        data: payout,
        message: 'Payout created successfully',
      });
    } catch (error) {
      if (error instanceof RepositoryError && error.message.includes('Insufficient pending earnings')) {
        reply.status(400).send({
          success: false,
          message: error.message,
        });
        return;
      }
      logger.error({ error }, 'Failed to create payout');
      reply.status(500).send({
        success: false,
        message: 'Failed to create payout',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };

  /**
   * Process payout
   */
  processPayout = async (
    req: FastifyRequest<{ Params: PayoutIdParams; Body: ProcessPayoutBody }>,
    reply: FastifyReply
  ): Promise<void> => {
    try {
      const payout = await this.partnerService.processPayout(
        req.params.payoutId,
        req.body.transactionId,
        req.body.notes
      );
      if (!payout) {
        reply.status(404).send({
          success: false,
          message: 'Payout not found',
        });
        return;
      }
      reply.send({
        success: true,
        data: payout,
        message: 'Payout processed successfully',
      });
    } catch (error) {
      if (error instanceof RepositoryError) {
        reply.status(400).send({
          success: false,
          message: error.message,
        });
        return;
      }
      logger.error({ error }, 'Failed to process payout');
      reply.status(500).send({
        success: false,
        message: 'Failed to process payout',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };

  /**
   * Get partner stats
   */
  getPartnerStats = async (_req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try {
      const stats = await this.partnerService.getPartnerStats();
      reply.send({
        success: true,
        data: stats,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get partner stats');
      reply.status(500).send({
        success: false,
        message: 'Failed to get partner stats',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };

  /**
   * Get partner dashboard
   */
  getPartnerDashboard = async (
    req: FastifyRequest<{ Params: PartnerIdParams }>,
    reply: FastifyReply
  ): Promise<void> => {
    try {
      const dashboard = await this.partnerService.getPartnerDashboard(req.params.id);
      if (!dashboard) {
        reply.status(404).send({
          success: false,
          message: 'Partner not found',
        });
        return;
      }
      reply.send({
        success: true,
        data: dashboard,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get partner dashboard');
      reply.status(500).send({
        success: false,
        message: 'Failed to get partner dashboard',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };
}
