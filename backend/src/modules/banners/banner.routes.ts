import type { FastifyInstance } from 'fastify';
import {
  handleGetBanners,
  handleGetBannerById,
  handleGetActiveBannersByPosition,
  handleGetAllActiveBanners,
  handleCreateBanner,
  handleUpdateBanner,
  handleDeleteBanner,
  handleTrackBannerClick,
  handleTrackBannerImpression,
  handleGetBannerStatistics,
} from './banner.controller.js';

/**
 * Register banner management routes
 * @param fastify - Fastify instance
 */
export async function bannerRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /api/banners
   * Get banners list with pagination (admin only)
   */
  fastify.get('/', {
    schema: {
      description: 'Get banners list',
      tags: ['banners'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'number', default: 1 },
          limit: { type: 'number', default: 20 },
          position: { type: 'string', enum: ['home_top', 'home_bottom', 'plans_page', 'sidebar'] },
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
                data: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      title: { type: 'string' },
                      subtitle: { type: 'string' },
                      imageUrl: { type: 'string' },
                      linkUrl: { type: 'string' },
                      position: { type: 'string' },
                      displayOrder: { type: 'number' },
                      isActive: { type: 'boolean' },
                      startsAt: { type: 'string' },
                      endsAt: { type: 'string' },
                      clickCount: { type: 'number' },
                      impressionCount: { type: 'number' },
                      backgroundColor: { type: 'string' },
                      textColor: { type: 'string' },
                      createdAt: { type: 'string' },
                      updatedAt: { type: 'string' },
                    },
                  },
                },
                total: { type: 'number' },
                page: { type: 'number' },
                limit: { type: 'number' },
                totalPages: { type: 'number' },
              },
            },
          },
        },
        403: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            error: { type: 'string' },
          },
        },
        401: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
    onRequest: [fastify.authenticate],
    handler: handleGetBanners,
  });

  /**
   * GET /api/banners/active
   * Get all active banners (public endpoint)
   */
  fastify.get('/active', {
    schema: {
      description: 'Get all active banners',
      tags: ['banners'],
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  title: { type: 'string' },
                  subtitle: { type: 'string' },
                  imageUrl: { type: 'string' },
                  linkUrl: { type: 'string' },
                  position: { type: 'string' },
                  displayOrder: { type: 'number' },
                  isActive: { type: 'boolean' },
                  startsAt: { type: 'string' },
                  endsAt: { type: 'string' },
                  clickCount: { type: 'number' },
                  impressionCount: { type: 'number' },
                  backgroundColor: { type: 'string' },
                  textColor: { type: 'string' },
                  createdAt: { type: 'string' },
                  updatedAt: { type: 'string' },
                },
              },
            },
          },
        },
        500: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            error: { type: 'string' },
          },
        },
      },
    },
    handler: handleGetAllActiveBanners,
  });

  /**
   * GET /api/banners/by-position
   * Get active banners by position (public endpoint)
   */
  fastify.get('/by-position', {
    schema: {
      description: 'Get active banners by position',
      tags: ['banners'],
      querystring: {
        type: 'object',
        required: ['position'],
        properties: {
          position: { type: 'string', enum: ['home_top', 'home_bottom', 'plans_page', 'sidebar'] },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  title: { type: 'string' },
                  subtitle: { type: 'string' },
                  imageUrl: { type: 'string' },
                  linkUrl: { type: 'string' },
                  position: { type: 'string' },
                  displayOrder: { type: 'number' },
                  isActive: { type: 'boolean' },
                  startsAt: { type: 'string' },
                  endsAt: { type: 'string' },
                  clickCount: { type: 'number' },
                  impressionCount: { type: 'number' },
                  backgroundColor: { type: 'string' },
                  textColor: { type: 'string' },
                  createdAt: { type: 'string' },
                  updatedAt: { type: 'string' },
                },
              },
            },
          },
        },
        500: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            error: { type: 'string' },
          },
        },
      },
    },
    handler: handleGetActiveBannersByPosition,
  });

  /**
   * POST /api/banners
   * Create new banner (admin only)
   */
  fastify.post('/', {
    schema: {
      description: 'Create new banner',
      tags: ['banners'],
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['title', 'imageUrl', 'position'],
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 255 },
          subtitle: { type: 'string', maxLength: 500 },
          imageUrl: { type: 'string', format: 'uri', maxLength: 1000 },
          linkUrl: { type: 'string', format: 'uri', maxLength: 1000 },
          position: { type: 'string', enum: ['home_top', 'home_bottom', 'plans_page', 'sidebar'] },
          displayOrder: { type: 'integer', minimum: 0, default: 0 },
          isActive: { type: 'boolean', default: true },
          startsAt: { type: 'string', format: 'date-time' },
          endsAt: { type: 'string', format: 'date-time' },
          backgroundColor: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' },
          textColor: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' },
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
                id: { type: 'string' },
                title: { type: 'string' },
                subtitle: { type: 'string' },
                imageUrl: { type: 'string' },
                linkUrl: { type: 'string' },
                position: { type: 'string' },
                displayOrder: { type: 'number' },
                isActive: { type: 'boolean' },
                startsAt: { type: 'string' },
                endsAt: { type: 'string' },
                clickCount: { type: 'number' },
                impressionCount: { type: 'number' },
                backgroundColor: { type: 'string' },
                textColor: { type: 'string' },
                createdAt: { type: 'string' },
                updatedAt: { type: 'string' },
              },
            },
            message: { type: 'string' },
          },
        },
        400: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            error: { type: 'string' },
          },
        },
        403: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            error: { type: 'string' },
          },
        },
        401: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
    onRequest: [fastify.authenticate],
    handler: handleCreateBanner,
  });

  /**
   * GET /api/banners/:id
   * Get banner by ID (admin only)
   */
  fastify.get('/:id', {
    schema: {
      description: 'Get banner by ID',
      tags: ['banners'],
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
                id: { type: 'string' },
                title: { type: 'string' },
                subtitle: { type: 'string' },
                imageUrl: { type: 'string' },
                linkUrl: { type: 'string' },
                position: { type: 'string' },
                displayOrder: { type: 'number' },
                isActive: { type: 'boolean' },
                startsAt: { type: 'string' },
                endsAt: { type: 'string' },
                clickCount: { type: 'number' },
                impressionCount: { type: 'number' },
                backgroundColor: { type: 'string' },
                textColor: { type: 'string' },
                createdAt: { type: 'string' },
                updatedAt: { type: 'string' },
              },
            },
          },
        },
        404: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            error: { type: 'string' },
          },
        },
        403: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            error: { type: 'string' },
          },
        },
        401: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
    onRequest: [fastify.authenticate],
    handler: handleGetBannerById,
  });

  /**
   * PATCH /api/banners/:id
   * Update banner (admin only)
   */
  fastify.patch('/:id', {
    schema: {
      description: 'Update banner',
      tags: ['banners'],
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
          title: { type: 'string', minLength: 1, maxLength: 255 },
          subtitle: { type: 'string', maxLength: 500 },
          imageUrl: { type: 'string', format: 'uri', maxLength: 1000 },
          linkUrl: { type: 'string', format: 'uri', maxLength: 1000 },
          position: { type: 'string', enum: ['home_top', 'home_bottom', 'plans_page', 'sidebar'] },
          displayOrder: { type: 'integer', minimum: 0 },
          isActive: { type: 'boolean' },
          startsAt: { type: 'string', format: 'date-time' },
          endsAt: { type: 'string', format: 'date-time' },
          backgroundColor: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' },
          textColor: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' },
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
                id: { type: 'string' },
                title: { type: 'string' },
                subtitle: { type: 'string' },
                imageUrl: { type: 'string' },
                linkUrl: { type: 'string' },
                position: { type: 'string' },
                displayOrder: { type: 'number' },
                isActive: { type: 'boolean' },
                startsAt: { type: 'string' },
                endsAt: { type: 'string' },
                clickCount: { type: 'number' },
                impressionCount: { type: 'number' },
                backgroundColor: { type: 'string' },
                textColor: { type: 'string' },
                createdAt: { type: 'string' },
                updatedAt: { type: 'string' },
              },
            },
            message: { type: 'string' },
          },
        },
        400: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            error: { type: 'string' },
          },
        },
        404: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            error: { type: 'string' },
          },
        },
        403: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            error: { type: 'string' },
          },
        },
        401: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
    onRequest: [fastify.authenticate],
    handler: handleUpdateBanner,
  });

  /**
   * DELETE /api/banners/:id
   * Delete banner (admin only)
   */
  fastify.delete('/:id', {
    schema: {
      description: 'Delete banner',
      tags: ['banners'],
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
        404: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            error: { type: 'string' },
          },
        },
        403: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            error: { type: 'string' },
          },
        },
        401: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
    onRequest: [fastify.authenticate],
    handler: handleDeleteBanner,
  });

  /**
   * POST /api/banners/:id/click
   * Track banner click (public endpoint)
   */
  fastify.post('/:id/click', {
    schema: {
      description: 'Track banner click',
      tags: ['banners'],
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
                bannerId: { type: 'string' },
                clickCount: { type: 'number' },
                impressionCount: { type: 'number' },
              },
            },
            message: { type: 'string' },
          },
        },
        404: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            error: { type: 'string' },
          },
        },
        500: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            error: { type: 'string' },
          },
        },
      },
    },
    handler: handleTrackBannerClick,
  });

  /**
   * POST /api/banners/:id/impression
   * Track banner impression (public endpoint)
   */
  fastify.post('/:id/impression', {
    schema: {
      description: 'Track banner impression',
      tags: ['banners'],
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
                bannerId: { type: 'string' },
                clickCount: { type: 'number' },
                impressionCount: { type: 'number' },
              },
            },
            message: { type: 'string' },
          },
        },
        404: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            error: { type: 'string' },
          },
        },
        500: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            error: { type: 'string' },
          },
        },
      },
    },
    handler: handleTrackBannerImpression,
  });

  /**
   * GET /api/banners/:id/statistics
   * Get banner statistics (admin only)
   */
  fastify.get('/:id/statistics', {
    schema: {
      description: 'Get banner statistics',
      tags: ['banners'],
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
                bannerId: { type: 'string' },
                clickCount: { type: 'number' },
                impressionCount: { type: 'number' },
                ctr: { type: 'number' },
              },
            },
          },
        },
        404: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            error: { type: 'string' },
          },
        },
        403: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            error: { type: 'string' },
          },
        },
        401: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
    onRequest: [fastify.authenticate],
    handler: handleGetBannerStatistics,
  });
}
