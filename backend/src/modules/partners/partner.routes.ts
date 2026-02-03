import type { FastifyInstance } from 'fastify';
import { PartnerController } from './partner.controller.js';
import { PartnerService } from './partner.service.js';
import { PartnerRepository } from '../../repositories/partner.repository.js';
import {
  partnerParamsSchema,
  payoutParamsSchema,
  createPartnerSchema,
  updatePartnerSchema,
  partnerFiltersSchema,
  createPayoutSchema,
  processPayoutSchema,
  earningFiltersSchema,
  payoutFiltersSchema,
  partnerResponseSchema,
  partnerListResponseSchema,
  partnerStatsResponseSchema,
} from './partner.schemas.js';
import type { Pool } from 'pg';

/**
 * Partner routes
 */
export async function partnerRoutes(app: FastifyInstance): Promise<void> {
  const db = (app as unknown as { db: Pool }).db;
  const partnerRepository = new PartnerRepository(db);
  const partnerService = new PartnerService(partnerRepository);
  const partnerController = new PartnerController(partnerService);

  /**
   * Get all partners with pagination and filters
   */
  app.get('/', {
    schema: {
      tags: ['partners'],
      summary: 'Get all partners',
      description: 'Retrieve partners with pagination, filtering, and sorting',
      querystring: partnerFiltersSchema,
      response: {
        200: partnerListResponseSchema,
      },
      security: [{ bearerAuth: [] }],
    },
    onRequest: [(app as unknown as { authenticate: () => Promise<void> }).authenticate],
    handler: partnerController.getPartners,
  });

  /**
   * Get partner statistics
   */
  app.get('/stats/overview', {
    schema: {
      tags: ['partners'],
      summary: 'Get partner statistics',
      description: 'Retrieve partner program statistics',
      response: {
        200: partnerStatsResponseSchema,
      },
      security: [{ bearerAuth: [] }],
    },
    onRequest: [(app as unknown as { authenticate: () => Promise<void> }).authenticate],
    handler: partnerController.getPartnerStats,
  });

  /**
   * Create new partner
   */
  app.post('/', {
    schema: {
      tags: ['partners'],
      summary: 'Create partner',
      description: 'Create a new partner',
      body: createPartnerSchema,
      response: {
        201: partnerResponseSchema,
      },
      security: [{ bearerAuth: [] }],
    },
    onRequest: [(app as unknown as { authenticate: () => Promise<void> }).authenticate],
    handler: partnerController.createPartner,
  });

  /**
   * Get partner by ID
   */
  app.get('/:id', {
    schema: {
      tags: ['partners'],
      summary: 'Get partner by ID',
      description: 'Retrieve a specific partner by ID',
      params: partnerParamsSchema,
      response: {
        200: partnerResponseSchema,
      },
      security: [{ bearerAuth: [] }],
    },
    onRequest: [(app as unknown as { authenticate: () => Promise<void> }).authenticate],
    handler: partnerController.getPartnerById,
  });

  /**
   * Update partner
   */
  app.patch('/:id', {
    schema: {
      tags: ['partners'],
      summary: 'Update partner',
      description: 'Update partner details',
      params: partnerParamsSchema,
      body: updatePartnerSchema,
      response: {
        200: partnerResponseSchema,
      },
      security: [{ bearerAuth: [] }],
    },
    onRequest: [(app as unknown as { authenticate: () => Promise<void> }).authenticate],
    handler: partnerController.updatePartner,
  });

  /**
   * Delete partner
   */
  app.delete('/:id', {
    schema: {
      tags: ['partners'],
      summary: 'Delete partner',
      description: 'Delete a partner',
      params: partnerParamsSchema,
      security: [{ bearerAuth: [] }],
    },
    onRequest: [(app as unknown as { authenticate: () => Promise<void> }).authenticate],
    handler: partnerController.deletePartner,
  });

  /**
   * Approve partner
   */
  app.post('/:id/approve', {
    schema: {
      tags: ['partners'],
      summary: 'Approve partner',
      description: 'Approve a pending partner',
      params: partnerParamsSchema,
      response: {
        200: partnerResponseSchema,
      },
      security: [{ bearerAuth: [] }],
    },
    onRequest: [(app as unknown as { authenticate: () => Promise<void> }).authenticate],
    handler: partnerController.approvePartner,
  });

  /**
   * Reject partner
   */
  app.post('/:id/reject', {
    schema: {
      tags: ['partners'],
      summary: 'Reject partner',
      description: 'Reject a pending partner',
      params: partnerParamsSchema,
      response: {
        200: partnerResponseSchema,
      },
      security: [{ bearerAuth: [] }],
    },
    onRequest: [(app as unknown as { authenticate: () => Promise<void> }).authenticate],
    handler: partnerController.rejectPartner,
  });

  /**
   * Suspend partner
   */
  app.post('/:id/suspend', {
    schema: {
      tags: ['partners'],
      summary: 'Suspend partner',
      description: 'Suspend an active partner',
      params: partnerParamsSchema,
      response: {
        200: partnerResponseSchema,
      },
      security: [{ bearerAuth: [] }],
    },
    onRequest: [(app as unknown as { authenticate: () => Promise<void> }).authenticate],
    handler: partnerController.suspendPartner,
  });

  /**
   * Get partner dashboard
   */
  app.get('/:id/dashboard', {
    schema: {
      tags: ['partners'],
      summary: 'Get partner dashboard',
      description: 'Get partner dashboard with earnings and stats',
      params: partnerParamsSchema,
      security: [{ bearerAuth: [] }],
    },
    onRequest: [(app as unknown as { authenticate: () => Promise<void> }).authenticate],
    handler: partnerController.getPartnerDashboard,
  });

  /**
   * Get partner earnings
   */
  app.get('/:id/earnings', {
    schema: {
      tags: ['partners'],
      summary: 'Get partner earnings',
      description: 'Get earnings for a specific partner',
      params: partnerParamsSchema,
      querystring: earningFiltersSchema,
      security: [{ bearerAuth: [] }],
    },
    onRequest: [(app as unknown as { authenticate: () => Promise<void> }).authenticate],
    handler: partnerController.getPartnerEarnings,
  });

  /**
   * Get partner payouts
   */
  app.get('/:id/payouts', {
    schema: {
      tags: ['partners'],
      summary: 'Get partner payouts',
      description: 'Get payouts for a specific partner',
      params: partnerParamsSchema,
      querystring: payoutFiltersSchema,
      security: [{ bearerAuth: [] }],
    },
    onRequest: [(app as unknown as { authenticate: () => Promise<void> }).authenticate],
    handler: partnerController.getPartnerPayouts,
  });

  /**
   * Create payout
   */
  app.post('/:id/payouts', {
    schema: {
      tags: ['partners'],
      summary: 'Create payout',
      description: 'Create a payout request for a partner',
      params: partnerParamsSchema,
      body: createPayoutSchema,
      security: [{ bearerAuth: [] }],
    },
    onRequest: [(app as unknown as { authenticate: () => Promise<void> }).authenticate],
    handler: partnerController.createPayout,
  });

  /**
   * Process payout
   */
  app.post('/:id/payouts/:payoutId/process', {
    schema: {
      tags: ['partners'],
      summary: 'Process payout',
      description: 'Process and complete a payout',
      params: payoutParamsSchema,
      body: processPayoutSchema,
      security: [{ bearerAuth: [] }],
    },
    onRequest: [(app as unknown as { authenticate: () => Promise<void> }).authenticate],
    handler: partnerController.processPayout,
  });
}

export default partnerRoutes;
