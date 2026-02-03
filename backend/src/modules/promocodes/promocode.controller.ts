import type { FastifyRequest, FastifyReply } from 'fastify';
import {
  createPromocodeService,
  PromocodeNotFoundError,
  PromocodeAlreadyExistsError,
  InvalidPromocodeError,
} from './promocode.service.js';
import { logger } from '../../utils/logger.js';
import type {
  CreatePromocodeInput,
  UpdatePromocodeInput,
  PromocodeParams,
  ValidatePromocodeInput,
} from './promocode.schemas.js';

/**
 * Handle get all promocodes request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleGetPromocodes(
  _request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  try {
    const promocodeService = createPromocodeService(_request.server.pg);
    const promocodes = await promocodeService.getAllPromocodes();

    reply.send({
      success: true,
      data: promocodes,
    });
  } catch (error) {
    logger.error({ error }, 'Failed to get promocodes');
    reply.status(500).send({
      success: false,
      error: 'Failed to get promocodes',
    });
  }
}

/**
 * Handle get active promocodes request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleGetActivePromocodes(
  _request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  try {
    const promocodeService = createPromocodeService(_request.server.pg);
    const promocodes = await promocodeService.getActivePromocodes();

    reply.send({
      success: true,
      data: promocodes,
    });
  } catch (error) {
    logger.error({ error }, 'Failed to get active promocodes');
    reply.status(500).send({
      success: false,
      error: 'Failed to get active promocodes',
    });
  }
}

/**
 * Handle get promocode by ID request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleGetPromocodeById(
  request: FastifyRequest<{ Params: PromocodeParams }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const promocodeService = createPromocodeService(request.server.pg);
    const promocode = await promocodeService.getPromocodeById(request.params.id);

    if (!promocode) {
      reply.status(404).send({
        success: false,
        error: 'Promocode not found',
      });
      return;
    }

    reply.send({
      success: true,
      data: promocode,
    });
  } catch (error) {
    logger.error({ error, promocodeId: request.params.id }, 'Failed to get promocode');
    reply.status(500).send({
      success: false,
      error: 'Failed to get promocode',
    });
  }
}

/**
 * Handle create promocode request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleCreatePromocode(
  request: FastifyRequest<{ Body: CreatePromocodeInput }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const promocodeService = createPromocodeService(request.server.pg);
    const promocode = await promocodeService.createPromocode(request.body);

    reply.status(201).send({
      success: true,
      data: promocode,
      message: 'Promocode created successfully',
    });
  } catch (error) {
    if (error instanceof PromocodeAlreadyExistsError) {
      reply.status(409).send({
        success: false,
        error: error.message,
      });
      return;
    }

    logger.error({ error }, 'Failed to create promocode');
    reply.status(500).send({
      success: false,
      error: 'Failed to create promocode',
    });
  }
}

/**
 * Handle update promocode request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleUpdatePromocode(
  request: FastifyRequest<{ Params: PromocodeParams; Body: UpdatePromocodeInput }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const promocodeService = createPromocodeService(request.server.pg);
    const promocode = await promocodeService.updatePromocode(request.params.id, request.body);

    reply.send({
      success: true,
      data: promocode,
      message: 'Promocode updated successfully',
    });
  } catch (error) {
    if (error instanceof PromocodeNotFoundError) {
      reply.status(404).send({
        success: false,
        error: error.message,
      });
      return;
    }

    if (error instanceof PromocodeAlreadyExistsError) {
      reply.status(409).send({
        success: false,
        error: error.message,
      });
      return;
    }

    logger.error({ error, promocodeId: request.params.id }, 'Failed to update promocode');
    reply.status(500).send({
      success: false,
      error: 'Failed to update promocode',
    });
  }
}

/**
 * Handle delete promocode request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleDeletePromocode(
  request: FastifyRequest<{ Params: PromocodeParams }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const promocodeService = createPromocodeService(request.server.pg);
    const deleted = await promocodeService.deletePromocode(request.params.id);

    if (!deleted) {
      reply.status(404).send({
        success: false,
        error: 'Promocode not found',
      });
      return;
    }

    reply.send({
      success: true,
      message: 'Promocode deleted successfully',
    });
  } catch (error) {
    if (error instanceof PromocodeNotFoundError) {
      reply.status(404).send({
        success: false,
        error: error.message,
      });
      return;
    }

    logger.error({ error, promocodeId: request.params.id }, 'Failed to delete promocode');
    reply.status(500).send({
      success: false,
      error: 'Failed to delete promocode',
    });
  }
}

/**
 * Handle toggle promocode request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleTogglePromocode(
  request: FastifyRequest<{ Params: PromocodeParams }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const promocodeService = createPromocodeService(request.server.pg);
    const promocode = await promocodeService.togglePromocode(request.params.id);

    reply.send({
      success: true,
      data: promocode,
      message: `Promocode ${promocode.isActive ? 'activated' : 'deactivated'} successfully`,
    });
  } catch (error) {
    if (error instanceof PromocodeNotFoundError) {
      reply.status(404).send({
        success: false,
        error: error.message,
      });
      return;
    }

    logger.error({ error, promocodeId: request.params.id }, 'Failed to toggle promocode');
    reply.status(500).send({
      success: false,
      error: 'Failed to toggle promocode',
    });
  }
}

/**
 * Handle validate promocode request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleValidatePromocode(
  request: FastifyRequest<{ Body: ValidatePromocodeInput }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const promocodeService = createPromocodeService(request.server.pg);
    const promocode = await promocodeService.validatePromocode(request.body.code);

    reply.send({
      success: true,
      data: {
        valid: !!promocode,
        promocode: promocode || undefined,
      },
      message: promocode ? 'Promocode is valid' : 'Promocode is invalid or expired',
    });
  } catch (error) {
    logger.error({ error, code: request.body.code }, 'Failed to validate promocode');
    reply.status(500).send({
      success: false,
      error: 'Failed to validate promocode',
    });
  }
}

/**
 * Handle apply promocode request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleApplyPromocode(
  request: FastifyRequest<{ Body: ValidatePromocodeInput }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const promocodeService = createPromocodeService(request.server.pg);
    const promocode = await promocodeService.applyPromocode(request.body.code);

    reply.send({
      success: true,
      data: promocode,
      message: 'Promocode applied successfully',
    });
  } catch (error) {
    if (error instanceof InvalidPromocodeError) {
      reply.status(400).send({
        success: false,
        error: error.message,
      });
      return;
    }

    logger.error({ error, code: request.body.code }, 'Failed to apply promocode');
    reply.status(500).send({
      success: false,
      error: 'Failed to apply promocode',
    });
  }
}
