import type { FastifyRequest, FastifyReply } from 'fastify';
import {
  createBannerService,
  BannerNotFoundError,
  PermissionDeniedError,
  InvalidBannerDataError,
} from './banner.service.js';
import { logger } from '../../utils/logger.js';
import type {
  CreateBannerInput,
  UpdateBannerInput,
  GetBannersQuery,
  GetActiveBannersByPositionQuery,
  BannerParams,
} from './banner.schemas.js';

/**
 * Handle get banners request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleGetBanners(
  request: FastifyRequest<{ Querystring: GetBannersQuery }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const bannerService = createBannerService(request.server.pg);
    const userRole = request.user?.role || '';
    const result = await bannerService.getBanners(request.query, userRole);

    reply.send({
      success: true,
      data: result,
    });
  } catch (error) {
    if (error instanceof PermissionDeniedError) {
      reply.status(403).send({
        success: false,
        error: error.message,
      });
      return;
    }

    logger.error({ error }, 'Failed to get banners');
    reply.status(500).send({
      success: false,
      error: 'Failed to get banners',
    });
  }
}

/**
 * Handle get banner by ID request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleGetBannerById(
  request: FastifyRequest<{ Params: BannerParams }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const bannerService = createBannerService(request.server.pg);
    const userRole = request.user?.role || '';
    const result = await bannerService.getBannerById(request.params.id, userRole);

    if (!result) {
      reply.status(404).send({
        success: false,
        error: 'Banner not found',
      });
      return;
    }

    reply.send({
      success: true,
      data: result,
    });
  } catch (error) {
    if (error instanceof PermissionDeniedError) {
      reply.status(403).send({
        success: false,
        error: error.message,
      });
      return;
    }

    logger.error({ error, bannerId: request.params.id }, 'Failed to get banner');
    reply.status(500).send({
      success: false,
      error: 'Failed to get banner',
    });
  }
}

/**
 * Handle get active banners by position request (public endpoint)
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleGetActiveBannersByPosition(
  request: FastifyRequest<{ Querystring: GetActiveBannersByPositionQuery }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const bannerService = createBannerService(request.server.pg);
    const result = await bannerService.getActiveBannersByPosition(request.query.position);

    reply.send({
      success: true,
      data: result,
    });
  } catch (error) {
    logger.error({ error, position: request.query.position }, 'Failed to get active banners by position');
    reply.status(500).send({
      success: false,
      error: 'Failed to get active banners',
    });
  }
}

/**
 * Handle get all active banners request (public endpoint)
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleGetAllActiveBanners(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  try {
    const bannerService = createBannerService(request.server.pg);
    const result = await bannerService.getAllActiveBanners();

    reply.send({
      success: true,
      data: result,
    });
  } catch (error) {
    logger.error({ error }, 'Failed to get active banners');
    reply.status(500).send({
      success: false,
      error: 'Failed to get active banners',
    });
  }
}

/**
 * Handle create banner request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleCreateBanner(
  request: FastifyRequest<{ Body: CreateBannerInput }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const bannerService = createBannerService(request.server.pg);
    const userRole = request.user?.role || '';
    const result = await bannerService.createBanner(request.body, userRole);

    reply.status(201).send({
      success: true,
      data: result,
      message: 'Banner created successfully',
    });
  } catch (error) {
    if (error instanceof PermissionDeniedError) {
      reply.status(403).send({
        success: false,
        error: error.message,
      });
      return;
    }

    if (error instanceof InvalidBannerDataError) {
      reply.status(400).send({
        success: false,
        error: error.message,
      });
      return;
    }

    logger.error({ error }, 'Failed to create banner');
    reply.status(500).send({
      success: false,
      error: 'Failed to create banner',
    });
  }
}

/**
 * Handle update banner request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleUpdateBanner(
  request: FastifyRequest<{ Params: BannerParams; Body: UpdateBannerInput }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const bannerService = createBannerService(request.server.pg);
    const userRole = request.user?.role || '';
    const result = await bannerService.updateBanner(request.params.id, request.body, userRole);

    reply.send({
      success: true,
      data: result,
      message: 'Banner updated successfully',
    });
  } catch (error) {
    if (error instanceof PermissionDeniedError) {
      reply.status(403).send({
        success: false,
        error: error.message,
      });
      return;
    }

    if (error instanceof BannerNotFoundError) {
      reply.status(404).send({
        success: false,
        error: error.message,
      });
      return;
    }

    if (error instanceof InvalidBannerDataError) {
      reply.status(400).send({
        success: false,
        error: error.message,
      });
      return;
    }

    logger.error({ error, bannerId: request.params.id }, 'Failed to update banner');
    reply.status(500).send({
      success: false,
      error: 'Failed to update banner',
    });
  }
}

/**
 * Handle delete banner request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleDeleteBanner(
  request: FastifyRequest<{ Params: BannerParams }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const bannerService = createBannerService(request.server.pg);
    const userRole = request.user?.role || '';
    await bannerService.deleteBanner(request.params.id, userRole);

    reply.send({
      success: true,
      message: 'Banner deleted successfully',
    });
  } catch (error) {
    if (error instanceof PermissionDeniedError) {
      reply.status(403).send({
        success: false,
        error: error.message,
      });
      return;
    }

    if (error instanceof BannerNotFoundError) {
      reply.status(404).send({
        success: false,
        error: error.message,
      });
      return;
    }

    logger.error({ error, bannerId: request.params.id }, 'Failed to delete banner');
    reply.status(500).send({
      success: false,
      error: 'Failed to delete banner',
    });
  }
}

/**
 * Handle track banner click request (public endpoint)
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleTrackBannerClick(
  request: FastifyRequest<{ Params: BannerParams }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const bannerService = createBannerService(request.server.pg);
    const result = await bannerService.incrementClicks(request.params.id);

    reply.send({
      success: true,
      data: result,
      message: 'Click tracked successfully',
    });
  } catch (error) {
    if (error instanceof BannerNotFoundError) {
      reply.status(404).send({
        success: false,
        error: 'Banner not found',
      });
      return;
    }

    logger.error({ error, bannerId: request.params.id }, 'Failed to track banner click');
    reply.status(500).send({
      success: false,
      error: 'Failed to track click',
    });
  }
}

/**
 * Handle track banner impression request (public endpoint)
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleTrackBannerImpression(
  request: FastifyRequest<{ Params: BannerParams }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const bannerService = createBannerService(request.server.pg);
    const result = await bannerService.incrementImpressions(request.params.id);

    reply.send({
      success: true,
      data: result,
      message: 'Impression tracked successfully',
    });
  } catch (error) {
    if (error instanceof BannerNotFoundError) {
      reply.status(404).send({
        success: false,
        error: 'Banner not found',
      });
      return;
    }

    logger.error({ error, bannerId: request.params.id }, 'Failed to track banner impression');
    reply.status(500).send({
      success: false,
      error: 'Failed to track impression',
    });
  }
}

/**
 * Handle get banner statistics request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleGetBannerStatistics(
  request: FastifyRequest<{ Params: BannerParams }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const bannerService = createBannerService(request.server.pg);
    const userRole = request.user?.role || '';
    const result = await bannerService.getBannerStatistics(request.params.id, userRole);

    reply.send({
      success: true,
      data: result,
    });
  } catch (error) {
    if (error instanceof PermissionDeniedError) {
      reply.status(403).send({
        success: false,
        error: error.message,
      });
      return;
    }

    if (error instanceof BannerNotFoundError) {
      reply.status(404).send({
        success: false,
        error: error.message,
      });
      return;
    }

    logger.error({ error, bannerId: request.params.id }, 'Failed to get banner statistics');
    reply.status(500).send({
      success: false,
      error: 'Failed to get banner statistics',
    });
  }
}
