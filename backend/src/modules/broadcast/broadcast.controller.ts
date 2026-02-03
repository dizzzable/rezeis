import type { FastifyRequest, FastifyReply } from 'fastify';
import {
  createBroadcastService,
  BroadcastNotFoundError,
  PermissionDeniedError,
  InvalidBroadcastStateError,
  TelegramApiError,
} from './broadcast.service.js';
import { logger } from '../../utils/logger.js';
import { getEnv } from '../../config/env.js';
import type {
  CreateBroadcastInput,
  UpdateBroadcastInput,
  GetBroadcastsQuery,
  BroadcastParams,
  GetAudienceQuery,
  PreviewBroadcastRequest,
} from './broadcast.schemas.js';

/**
 * Handle get broadcasts request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleGetBroadcasts(
  request: FastifyRequest<{ Querystring: GetBroadcastsQuery }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const env = getEnv();
    const broadcastService = createBroadcastService(request.server.pg, env.TELEGRAM_BOT_TOKEN);
    const userRole = request.user?.role || '';
    const result = await broadcastService.getBroadcasts(request.query, userRole);

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

    logger.error({ error }, 'Failed to get broadcasts');
    reply.status(500).send({
      success: false,
      error: 'Failed to get broadcasts',
    });
  }
}

/**
 * Handle get broadcast by ID request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleGetBroadcastById(
  request: FastifyRequest<{ Params: BroadcastParams }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const env = getEnv();
    const broadcastService = createBroadcastService(request.server.pg, env.TELEGRAM_BOT_TOKEN);
    const userRole = request.user?.role || '';
    const result = await broadcastService.getBroadcastById(request.params.id, userRole);

    if (!result) {
      reply.status(404).send({
        success: false,
        error: 'Broadcast not found',
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

    logger.error({ error, broadcastId: request.params.id }, 'Failed to get broadcast');
    reply.status(500).send({
      success: false,
      error: 'Failed to get broadcast',
    });
  }
}

/**
 * Handle create broadcast request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleCreateBroadcast(
  request: FastifyRequest<{ Body: CreateBroadcastInput }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const env = getEnv();
    const broadcastService = createBroadcastService(request.server.pg, env.TELEGRAM_BOT_TOKEN);
    const userId = request.user?.userId || '';
    const userRole = request.user?.role || '';
    const result = await broadcastService.createBroadcast(request.body, userId, userRole);

    reply.status(201).send({
      success: true,
      data: result,
      message: 'Broadcast created successfully',
    });
  } catch (error) {
    if (error instanceof PermissionDeniedError) {
      reply.status(403).send({
        success: false,
        error: error.message,
      });
      return;
    }

    if (error instanceof InvalidBroadcastStateError) {
      reply.status(400).send({
        success: false,
        error: error.message,
      });
      return;
    }

    logger.error({ error }, 'Failed to create broadcast');
    reply.status(500).send({
      success: false,
      error: 'Failed to create broadcast',
    });
  }
}

/**
 * Handle update broadcast request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleUpdateBroadcast(
  request: FastifyRequest<{ Params: BroadcastParams; Body: UpdateBroadcastInput }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const env = getEnv();
    const broadcastService = createBroadcastService(request.server.pg, env.TELEGRAM_BOT_TOKEN);
    const userRole = request.user?.role || '';
    const result = await broadcastService.updateBroadcast(request.params.id, request.body, userRole);

    reply.send({
      success: true,
      data: result,
      message: 'Broadcast updated successfully',
    });
  } catch (error) {
    if (error instanceof PermissionDeniedError) {
      reply.status(403).send({
        success: false,
        error: error.message,
      });
      return;
    }

    if (error instanceof BroadcastNotFoundError) {
      reply.status(404).send({
        success: false,
        error: error.message,
      });
      return;
    }

    if (error instanceof InvalidBroadcastStateError) {
      reply.status(400).send({
        success: false,
        error: error.message,
      });
      return;
    }

    logger.error({ error, broadcastId: request.params.id }, 'Failed to update broadcast');
    reply.status(500).send({
      success: false,
      error: 'Failed to update broadcast',
    });
  }
}

/**
 * Handle delete broadcast request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleDeleteBroadcast(
  request: FastifyRequest<{ Params: BroadcastParams }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const env = getEnv();
    const broadcastService = createBroadcastService(request.server.pg, env.TELEGRAM_BOT_TOKEN);
    const userRole = request.user?.role || '';
    await broadcastService.deleteBroadcast(request.params.id, userRole);

    reply.send({
      success: true,
      message: 'Broadcast deleted successfully',
    });
  } catch (error) {
    if (error instanceof PermissionDeniedError) {
      reply.status(403).send({
        success: false,
        error: error.message,
      });
      return;
    }

    if (error instanceof BroadcastNotFoundError) {
      reply.status(404).send({
        success: false,
        error: error.message,
      });
      return;
    }

    if (error instanceof InvalidBroadcastStateError) {
      reply.status(400).send({
        success: false,
        error: error.message,
      });
      return;
    }

    logger.error({ error, broadcastId: request.params.id }, 'Failed to delete broadcast');
    reply.status(500).send({
      success: false,
      error: 'Failed to delete broadcast',
    });
  }
}

/**
 * Handle get audience count request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleGetAudience(
  request: FastifyRequest<{ Querystring: GetAudienceQuery }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const env = getEnv();
    const broadcastService = createBroadcastService(request.server.pg, env.TELEGRAM_BOT_TOKEN);
    const userRole = request.user?.role || '';
    const result = await broadcastService.getAudienceCount(
      request.query.audience,
      request.query.planId,
      userRole
    );

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

    if (error instanceof InvalidBroadcastStateError) {
      reply.status(400).send({
        success: false,
        error: error.message,
      });
      return;
    }

    logger.error({ error }, 'Failed to get audience count');
    reply.status(500).send({
      success: false,
      error: 'Failed to get audience count',
    });
  }
}

/**
 * Handle send broadcast request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleSendBroadcast(
  request: FastifyRequest<{ Params: BroadcastParams }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const env = getEnv();
    const broadcastService = createBroadcastService(request.server.pg, env.TELEGRAM_BOT_TOKEN);
    const userRole = request.user?.role || '';
    const result = await broadcastService.sendBroadcast(request.params.id, userRole);

    reply.send({
      success: true,
      data: result,
      message: result.message,
    });
  } catch (error) {
    if (error instanceof PermissionDeniedError) {
      reply.status(403).send({
        success: false,
        error: error.message,
      });
      return;
    }

    if (error instanceof BroadcastNotFoundError) {
      reply.status(404).send({
        success: false,
        error: error.message,
      });
      return;
    }

    if (error instanceof InvalidBroadcastStateError) {
      reply.status(400).send({
        success: false,
        error: error.message,
      });
      return;
    }

    if (error instanceof TelegramApiError) {
      reply.status(502).send({
        success: false,
        error: error.message,
      });
      return;
    }

    logger.error({ error, broadcastId: request.params.id }, 'Failed to send broadcast');
    reply.status(500).send({
      success: false,
      error: 'Failed to send broadcast',
    });
  }
}

/**
 * Handle preview broadcast request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handlePreviewBroadcast(
  request: FastifyRequest<{ Params: BroadcastParams; Body: PreviewBroadcastRequest }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const env = getEnv();
    const broadcastService = createBroadcastService(request.server.pg, env.TELEGRAM_BOT_TOKEN);
    const userRole = request.user?.role || '';
    await broadcastService.previewBroadcast(request.params.id, request.body.telegramId, userRole);

    reply.send({
      success: true,
      message: 'Preview sent successfully',
    });
  } catch (error) {
    if (error instanceof PermissionDeniedError) {
      reply.status(403).send({
        success: false,
        error: error.message,
      });
      return;
    }

    if (error instanceof BroadcastNotFoundError) {
      reply.status(404).send({
        success: false,
        error: error.message,
      });
      return;
    }

    if (error instanceof TelegramApiError) {
      reply.status(502).send({
        success: false,
        error: error.message,
      });
      return;
    }

    logger.error({ error, broadcastId: request.params.id }, 'Failed to send preview');
    reply.status(500).send({
      success: false,
      error: 'Failed to send preview',
    });
  }
}
