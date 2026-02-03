/**
 * Referral Routes
 * 
 * Route definitions for referral system
 */

import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { ReferralController } from './referral.controller.js';
import { ReferralService } from './referral.service.js';
import { ReferralRepository, ReferralRuleRepository, ReferralRewardRepository } from '../../repositories/referral.repository.js';
import { authenticate } from '../../middleware/auth.middleware.js';
import {
  referralParamsSchema,
  createReferralSchema,
  updateReferralSchema,
  referralFiltersSchema,
  referralListResponseSchema,
  referralResponseSchema,
  referralStatsResponseSchema,
  createRuleSchema,
  updateRuleSchema,
  ruleResponseSchema,
} from './referral.schemas.js';

/**
 * Register referral routes
 */
export async function referralRoutes(
  fastify: FastifyInstance,
  options: FastifyPluginOptions
): Promise<void> {
  void options;
  const db = fastify.pg;

  // Initialize repositories
  const referralRepository = new ReferralRepository(db);
  const ruleRepository = new ReferralRuleRepository(db);
  const rewardRepository = new ReferralRewardRepository(db);

  // Initialize services
  const referralService = new ReferralService(
    referralRepository,
    ruleRepository,
    rewardRepository
  );

  // Initialize controller
  const referralController = new ReferralController(referralService);

  // Apply authentication to all routes
  fastify.addHook('onRequest', authenticate);

  /**
   * Rule Routes
   */

  // Get all rules
  fastify.get('/rules', {
    schema: {
      tags: ['Referrals'],
      summary: 'Get all referral rules',
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'array',
              items: ruleResponseSchema,
            },
          },
        },
      },
    },
    handler: referralController.getRules.bind(referralController),
  });

  // Get active rules
  fastify.get('/rules/active', {
    schema: {
      tags: ['Referrals'],
      summary: 'Get active referral rules',
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'array',
              items: ruleResponseSchema,
            },
          },
        },
      },
    },
    handler: referralController.getActiveRules.bind(referralController),
  });

  // Get rule by ID
  fastify.get('/rules/:id', {
    schema: {
      tags: ['Referrals'],
      summary: 'Get referral rule by ID',
      security: [{ bearerAuth: [] }],
      params: referralParamsSchema,
      response: {
        200: {
          type: 'object',
          properties: {
            data: ruleResponseSchema,
          },
        },
        404: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
    handler: referralController.getRuleById.bind(referralController),
  });

  // Create rule
  fastify.post('/rules', {
    schema: {
      tags: ['Referrals'],
      summary: 'Create new referral rule',
      security: [{ bearerAuth: [] }],
      body: createRuleSchema,
      response: {
        201: {
          type: 'object',
          properties: {
            data: ruleResponseSchema,
          },
        },
      },
    },
    handler: referralController.createRule.bind(referralController),
  });

  // Update rule
  fastify.put('/rules/:id', {
    schema: {
      tags: ['Referrals'],
      summary: 'Update referral rule',
      security: [{ bearerAuth: [] }],
      params: referralParamsSchema,
      body: updateRuleSchema,
      response: {
        200: {
          type: 'object',
          properties: {
            data: ruleResponseSchema,
          },
        },
      },
    },
    handler: referralController.updateRule.bind(referralController),
  });

  // Delete rule
  fastify.delete('/rules/:id', {
    schema: {
      tags: ['Referrals'],
      summary: 'Delete referral rule',
      security: [{ bearerAuth: [] }],
      params: referralParamsSchema,
      response: {
        204: { type: 'null' },
      },
    },
    handler: referralController.deleteRule.bind(referralController),
  });

  /**
   * Referral Routes
   */

  // Get all referrals
  fastify.get('/', {
    schema: {
      tags: ['Referrals'],
      summary: 'Get all referrals',
      security: [{ bearerAuth: [] }],
      querystring: referralFiltersSchema,
      response: {
        200: referralListResponseSchema,
      },
    },
    handler: referralController.getReferrals.bind(referralController),
  });

  // Get referral by ID
  fastify.get('/:id', {
    schema: {
      tags: ['Referrals'],
      summary: 'Get referral by ID',
      security: [{ bearerAuth: [] }],
      params: referralParamsSchema,
      response: {
        200: {
          type: 'object',
          properties: {
            data: referralResponseSchema,
          },
        },
        404: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
    handler: referralController.getReferralById.bind(referralController),
  });

  // Create referral
  fastify.post('/', {
    schema: {
      tags: ['Referrals'],
      summary: 'Create new referral',
      security: [{ bearerAuth: [] }],
      body: createReferralSchema,
      response: {
        201: {
          type: 'object',
          properties: {
            data: referralResponseSchema,
          },
        },
      },
    },
    handler: referralController.createReferral.bind(referralController),
  });

  // Update referral
  fastify.put('/:id', {
    schema: {
      tags: ['Referrals'],
      summary: 'Update referral',
      security: [{ bearerAuth: [] }],
      params: referralParamsSchema,
      body: updateReferralSchema,
      response: {
        200: {
          type: 'object',
          properties: {
            data: referralResponseSchema,
          },
        },
      },
    },
    handler: referralController.updateReferral.bind(referralController),
  });

  // Complete referral
  fastify.post('/:id/complete', {
    schema: {
      tags: ['Referrals'],
      summary: 'Complete referral',
      security: [{ bearerAuth: [] }],
      params: referralParamsSchema,
      response: {
        200: {
          type: 'object',
          properties: {
            data: referralResponseSchema,
          },
        },
      },
    },
    handler: referralController.completeReferral.bind(referralController),
  });

  // Cancel referral
  fastify.post('/:id/cancel', {
    schema: {
      tags: ['Referrals'],
      summary: 'Cancel referral',
      security: [{ bearerAuth: [] }],
      params: referralParamsSchema,
      body: {
        type: 'object',
        properties: {
          reason: { type: 'string' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: referralResponseSchema,
          },
        },
      },
    },
    handler: referralController.cancelReferral.bind(referralController),
  });

  // Get statistics
  fastify.get('/statistics', {
    schema: {
      tags: ['Referrals'],
      summary: 'Get referral statistics',
      security: [{ bearerAuth: [] }],
      response: {
        200: referralStatsResponseSchema,
      },
    },
    handler: referralController.getStatistics.bind(referralController),
  });

  // Get top referrers
  fastify.get('/top-referrers', {
    schema: {
      tags: ['Referrals'],
      summary: 'Get top referrers',
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  userId: { type: 'string' },
                  referralCount: { type: 'number' },
                  totalRewards: { type: 'number' },
                },
              },
            },
          },
        },
      },
    },
    handler: referralController.getTopReferrers.bind(referralController),
  });
}
