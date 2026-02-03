import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createRepositories } from '../../../repositories/index.js';
import { logger } from '../../../utils/logger.js';
import type { Promocode } from '../../../entities/promocode.entity.js';

/**
 * Admin promocode management routes
 * These endpoints are for administrators to manage promocodes
 */
export async function adminPromocodesRoutes(fastify: FastifyInstance): Promise<void> {
  const repos = createRepositories(fastify.pg);

  /**
   * Check if user has admin role
   */
  function isAdmin(request: FastifyRequest): boolean {
    return request.user?.role === 'admin';
  }

  /**
   * GET /api/admin/promocodes
   * Get all promocodes
   */
  fastify.get('/', {
    schema: {
      description: 'Get all promocodes',
      tags: ['admin', 'promocodes'],
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                promocodes: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      code: { type: 'string' },
                      description: { type: 'string', nullable: true },
                      rewardType: { type: 'string' },
                      rewardValue: { type: 'number', nullable: true },
                      availability: { type: 'string' },
                      maxUses: { type: 'number' },
                      usedCount: { type: 'number' },
                      startsAt: { type: 'string', nullable: true },
                      expiresAt: { type: 'string', nullable: true },
                      isActive: { type: 'boolean' },
                      createdAt: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
        401: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
        403: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
    onRequest: [fastify.authenticate],
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      if (!isAdmin(request)) {
        return reply.status(403).send({ error: 'Admin access required' });
      }

      try {
        const promocodes = await repos.promocodes.findAll();
        return { success: true, data: { promocodes } };
      } catch (error) {
        logger.error({ error }, 'Failed to get promocodes');
        return reply.status(500).send({ error: 'Failed to get promocodes' });
      }
    },
  });

  /**
   * GET /api/admin/promocodes/stats
   * Get promocode statistics
   */
  fastify.get('/stats', {
    schema: {
      description: 'Get promocode statistics',
      tags: ['admin', 'promocodes'],
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                total: { type: 'number' },
                active: { type: 'number' },
                totalActivations: { type: 'number' },
              },
            },
          },
        },
        401: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
        403: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
    onRequest: [fastify.authenticate],
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      if (!isAdmin(request)) {
        return reply.status(403).send({ error: 'Admin access required' });
      }

      try {
        const total = await repos.promocodes.count();
        const active = await repos.promocodes.count({ isActive: true } as Partial<Promocode>);
        const totalActivations = await repos.promocodeActivations.count();

        return { success: true, data: { total, active, totalActivations } };
      } catch (error) {
        logger.error({ error }, 'Failed to get promocode stats');
        return reply.status(500).send({ error: 'Failed to get promocode stats' });
      }
    },
  });

  /**
   * GET /api/admin/promocodes/:id
   * Get promocode by ID
   */
  fastify.get('/:id', {
    schema: {
      description: 'Get promocode by ID',
      tags: ['admin', 'promocodes'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                promocode: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    code: { type: 'string' },
                    description: { type: 'string', nullable: true },
                    rewardType: { type: 'string' },
                    rewardValue: { type: 'number', nullable: true },
                    availability: { type: 'string' },
                    maxUses: { type: 'number' },
                    usedCount: { type: 'number' },
                    startsAt: { type: 'string', nullable: true },
                    expiresAt: { type: 'string', nullable: true },
                    isActive: { type: 'boolean' },
                    createdAt: { type: 'string' },
                  },
                },
              },
            },
          },
        },
        401: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
        403: {
          type: 'object',
          properties: {
            error: { type: 'string' },
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
    onRequest: [fastify.authenticate],
    handler: async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      if (!isAdmin(request)) {
        return reply.status(403).send({ error: 'Admin access required' });
      }

      try {
        const { id } = request.params;
        const promocode = await repos.promocodes.findById(id);

        if (!promocode) {
          return reply.status(404).send({ error: 'Promocode not found' });
        }

        return { success: true, data: { promocode } };
      } catch (error) {
        logger.error({ error }, 'Failed to get promocode');
        return reply.status(500).send({ error: 'Failed to get promocode' });
      }
    },
  });

  /**
   * POST /api/admin/promocodes
   * Create new promocode
   */
  fastify.post('/', {
    schema: {
      description: 'Create new promocode',
      tags: ['admin', 'promocodes'],
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['code', 'rewardType'],
        properties: {
          code: { type: 'string' },
          description: { type: 'string' },
          rewardType: { type: 'string', enum: ['duration', 'traffic', 'devices', 'subscription', 'personal_discount', 'purchase_discount'] },
          rewardValue: { type: 'number' },
          availability: { type: 'string', enum: ['all', 'new', 'existing', 'invited', 'allowed'] },
          maxUses: { type: 'number' },
          maxUsesPerUser: { type: 'number' },
          startsAt: { type: 'string' },
          expiresAt: { type: 'string' },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                promocode: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    code: { type: 'string' },
                    rewardType: { type: 'string' },
                    isActive: { type: 'boolean' },
                  },
                },
              },
            },
          },
        },
        400: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
        401: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
        403: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
    onRequest: [fastify.authenticate],
    handler: async (request: FastifyRequest<{
      Body: {
        code: string;
        description?: string;
        rewardType: string;
        rewardValue?: number;
        availability?: string;
        maxUses?: number;
        maxUsesPerUser?: number;
        startsAt?: string;
        expiresAt?: string;
      };
    }>, reply: FastifyReply) => {
      if (!isAdmin(request)) {
        return reply.status(403).send({ error: 'Admin access required' });
      }

      try {
        const data = request.body;

        const existing = await repos.promocodes.findByCode(data.code);
        if (existing) {
          return reply.status(400).send({ error: 'Promocode with this code already exists' });
        }

        const promocode = await repos.promocodes.create({
          code: data.code,
          description: data.description,
          rewardType: data.rewardType as any,
          rewardValue: data.rewardValue,
          availability: (data.availability as any) || 'all',
          maxUses: data.maxUses || 100,
          maxUsesPerUser: data.maxUsesPerUser || 1,
          startsAt: data.startsAt ? new Date(data.startsAt) : undefined,
          expiresAt: data.expiresAt ? new Date(data.expiresAt) : undefined,
          isActive: true,
          allowedUserIds: [],
          createdBy: request.user?.userId,
        });

        return reply.status(201).send({ success: true, data: { promocode } });
      } catch (error) {
        logger.error({ error }, 'Failed to create promocode');
        return reply.status(500).send({ error: 'Failed to create promocode' });
      }
    },
  });

  /**
   * PUT /api/admin/promocodes/:id
   * Update promocode
   */
  fastify.put('/:id', {
    schema: {
      description: 'Update promocode',
      tags: ['admin', 'promocodes'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
        },
      },
      body: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          rewardType: { type: 'string', enum: ['duration', 'traffic', 'devices', 'subscription', 'personal_discount', 'purchase_discount'] },
          rewardValue: { type: 'number' },
          availability: { type: 'string', enum: ['all', 'new', 'existing', 'invited', 'allowed'] },
          maxUses: { type: 'number' },
          maxUsesPerUser: { type: 'number' },
          startsAt: { type: 'string' },
          expiresAt: { type: 'string' },
          isActive: { type: 'boolean' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                promocode: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    code: { type: 'string' },
                  },
                },
              },
            },
          },
        },
        401: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
        403: {
          type: 'object',
          properties: {
            error: { type: 'string' },
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
    onRequest: [fastify.authenticate],
    handler: async (request: FastifyRequest<{
      Params: { id: string };
      Body: {
        description?: string;
        rewardType?: string;
        rewardValue?: number;
        availability?: string;
        maxUses?: number;
        maxUsesPerUser?: number;
        startsAt?: string;
        expiresAt?: string;
        isActive?: boolean;
      };
    }>, reply: FastifyReply) => {
      if (!isAdmin(request)) {
        return reply.status(403).send({ error: 'Admin access required' });
      }

      try {
        const { id } = request.params;
        const data = request.body;

        // Build update object with only defined values
        const updateData: Record<string, unknown> = {};
        if (data.description !== undefined) updateData.description = data.description;
        if (data.rewardType !== undefined) updateData.rewardType = data.rewardType;
        if (data.rewardValue !== undefined) updateData.rewardValue = data.rewardValue;
        if (data.availability !== undefined) updateData.availability = data.availability;
        if (data.maxUses !== undefined) updateData.maxUses = data.maxUses;
        if (data.maxUsesPerUser !== undefined) updateData.maxUsesPerUser = data.maxUsesPerUser;
        if (data.startsAt !== undefined) updateData.startsAt = new Date(data.startsAt);
        if (data.expiresAt !== undefined) updateData.expiresAt = new Date(data.expiresAt);
        if (data.isActive !== undefined) updateData.isActive = data.isActive;

        const promocode = await repos.promocodes.update(id, updateData as any);

        if (!promocode) {
          return reply.status(404).send({ error: 'Promocode not found' });
        }

        return { success: true, data: { promocode } };
      } catch (error) {
        logger.error({ error }, 'Failed to update promocode');
        return reply.status(500).send({ error: 'Failed to update promocode' });
      }
    },
  });

  /**
   * POST /api/admin/promocodes/:id/toggle
   * Toggle promocode active status
   */
  fastify.post('/:id/toggle', {
    schema: {
      description: 'Toggle promocode active status',
      tags: ['admin', 'promocodes'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                promocode: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    isActive: { type: 'boolean' },
                  },
                },
              },
            },
          },
        },
        401: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
        403: {
          type: 'object',
          properties: {
            error: { type: 'string' },
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
    onRequest: [fastify.authenticate],
    handler: async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      if (!isAdmin(request)) {
        return reply.status(403).send({ error: 'Admin access required' });
      }

      try {
        const { id } = request.params;
        const promocode = await repos.promocodes.toggleActive(id);

        if (!promocode) {
          return reply.status(404).send({ error: 'Promocode not found' });
        }

        return { success: true, data: { promocode } };
      } catch (error) {
        logger.error({ error }, 'Failed to toggle promocode');
        return reply.status(500).send({ error: 'Failed to toggle promocode' });
      }
    },
  });

  /**
   * DELETE /api/admin/promocodes/:id
   * Delete promocode
   */
  fastify.delete('/:id', {
    schema: {
      description: 'Delete promocode',
      tags: ['admin', 'promocodes'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
          },
        },
        401: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
        403: {
          type: 'object',
          properties: {
            error: { type: 'string' },
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
    onRequest: [fastify.authenticate],
    handler: async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      if (!isAdmin(request)) {
        return reply.status(403).send({ error: 'Admin access required' });
      }

      try {
        const { id } = request.params;
        const promocode = await repos.promocodes.findById(id);

        if (!promocode) {
          return reply.status(404).send({ error: 'Promocode not found' });
        }

        await repos.promocodes.delete(id);
        return { success: true, message: 'Promocode deleted successfully' };
      } catch (error) {
        logger.error({ error }, 'Failed to delete promocode');
        return reply.status(500).send({ error: 'Failed to delete promocode' });
      }
    },
  });

  /**
   * GET /api/admin/promocodes/:id/activations
   * Get promocode activations (usage history)
   */
  fastify.get('/:id/activations', {
    schema: {
      description: 'Get promocode activations',
      tags: ['admin', 'promocodes'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
        },
      },
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'number', default: 1 },
          limit: { type: 'number', default: 10 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                activations: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      userId: { type: 'string' },
                      activatedAt: { type: 'string' },
                      rewardApplied: { type: 'object', nullable: true },
                    },
                  },
                },
                pagination: {
                  type: 'object',
                  properties: {
                    page: { type: 'number' },
                    limit: { type: 'number' },
                    total: { type: 'number' },
                    pages: { type: 'number' },
                  },
                },
              },
            },
          },
        },
        401: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
        403: {
          type: 'object',
          properties: {
            error: { type: 'string' },
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
    onRequest: [fastify.authenticate],
    handler: async (request: FastifyRequest<{
      Params: { id: string };
      Querystring: { page?: number; limit?: number };
    }>, reply: FastifyReply) => {
      if (!isAdmin(request)) {
        return reply.status(403).send({ error: 'Admin access required' });
      }

      try {
        const { id } = request.params;
        const page = request.query.page || 1;
        const limit = request.query.limit || 10;

        const result = await repos.promocodes.getActivations(id, page, limit);

        return {
          success: true,
          data: {
            activations: result.data,
            pagination: {
              page,
              limit,
              total: result.total,
              pages: Math.ceil(result.total / limit),
            },
          },
        };
      } catch (error) {
        logger.error({ error }, 'Failed to get activations');
        return reply.status(500).send({ error: 'Failed to get activations' });
      }
    },
  });
}

export default adminPromocodesRoutes;
