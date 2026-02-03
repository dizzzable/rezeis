import type { FastifyRequest, FastifyReply } from 'fastify';
import {
  createGatewayService,
  GatewayNotFoundError,
  GatewayAlreadyExistsError,
  CannotDeleteDefaultGatewayError,
} from './gateway.service.js';
import { logger } from '../../utils/logger.js';
import type { CreateGatewayInput, UpdateGatewayInput, GatewayParams } from './gateway.schemas.js';

/**
 * Handle get all gateways request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleGetGateways(
  _request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  try {
    const gatewayService = createGatewayService(_request.server.pg);
    const gateways = await gatewayService.getAllGateways();

    reply.send({
      success: true,
      data: gateways,
    });
  } catch (error) {
    logger.error({ error }, 'Failed to get gateways');
    reply.status(500).send({
      success: false,
      error: 'Failed to get gateways',
    });
  }
}

/**
 * Handle get active gateways request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleGetActiveGateways(
  _request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  try {
    const gatewayService = createGatewayService(_request.server.pg);
    const gateways = await gatewayService.getActiveGateways();

    reply.send({
      success: true,
      data: gateways,
    });
  } catch (error) {
    logger.error({ error }, 'Failed to get active gateways');
    reply.status(500).send({
      success: false,
      error: 'Failed to get active gateways',
    });
  }
}

/**
 * Handle get default gateway request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleGetDefaultGateway(
  _request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  try {
    const gatewayService = createGatewayService(_request.server.pg);
    const gateway = await gatewayService.getDefaultGateway();

    if (!gateway) {
      reply.status(404).send({
        success: false,
        error: 'No default gateway found',
      });
      return;
    }

    reply.send({
      success: true,
      data: gateway,
    });
  } catch (error) {
    logger.error({ error }, 'Failed to get default gateway');
    reply.status(500).send({
      success: false,
      error: 'Failed to get default gateway',
    });
  }
}

/**
 * Handle get gateway by ID request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleGetGatewayById(
  request: FastifyRequest<{ Params: GatewayParams }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const gatewayService = createGatewayService(request.server.pg);
    const gateway = await gatewayService.getGatewayById(request.params.id);

    if (!gateway) {
      reply.status(404).send({
        success: false,
        error: 'Gateway not found',
      });
      return;
    }

    reply.send({
      success: true,
      data: gateway,
    });
  } catch (error) {
    logger.error({ error, gatewayId: request.params.id }, 'Failed to get gateway');
    reply.status(500).send({
      success: false,
      error: 'Failed to get gateway',
    });
  }
}

/**
 * Handle create gateway request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleCreateGateway(
  request: FastifyRequest<{ Body: CreateGatewayInput }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const gatewayService = createGatewayService(request.server.pg);
    const gateway = await gatewayService.createGateway(request.body);

    reply.status(201).send({
      success: true,
      data: gateway,
      message: 'Gateway created successfully',
    });
  } catch (error) {
    if (error instanceof GatewayAlreadyExistsError) {
      reply.status(409).send({
        success: false,
        error: error.message,
      });
      return;
    }

    logger.error({ error }, 'Failed to create gateway');
    reply.status(500).send({
      success: false,
      error: 'Failed to create gateway',
    });
  }
}

/**
 * Handle update gateway request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleUpdateGateway(
  request: FastifyRequest<{ Params: GatewayParams; Body: UpdateGatewayInput }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const gatewayService = createGatewayService(request.server.pg);
    const gateway = await gatewayService.updateGateway(request.params.id, request.body);

    reply.send({
      success: true,
      data: gateway,
      message: 'Gateway updated successfully',
    });
  } catch (error) {
    if (error instanceof GatewayNotFoundError) {
      reply.status(404).send({
        success: false,
        error: error.message,
      });
      return;
    }

    if (error instanceof GatewayAlreadyExistsError) {
      reply.status(409).send({
        success: false,
        error: error.message,
      });
      return;
    }

    logger.error({ error, gatewayId: request.params.id }, 'Failed to update gateway');
    reply.status(500).send({
      success: false,
      error: 'Failed to update gateway',
    });
  }
}

/**
 * Handle delete gateway request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleDeleteGateway(
  request: FastifyRequest<{ Params: GatewayParams }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const gatewayService = createGatewayService(request.server.pg);
    const deleted = await gatewayService.deleteGateway(request.params.id);

    if (!deleted) {
      reply.status(404).send({
        success: false,
        error: 'Gateway not found',
      });
      return;
    }

    reply.send({
      success: true,
      message: 'Gateway deleted successfully',
    });
  } catch (error) {
    if (error instanceof GatewayNotFoundError) {
      reply.status(404).send({
        success: false,
        error: error.message,
      });
      return;
    }

    if (error instanceof CannotDeleteDefaultGatewayError) {
      reply.status(400).send({
        success: false,
        error: error.message,
      });
      return;
    }

    logger.error({ error, gatewayId: request.params.id }, 'Failed to delete gateway');
    reply.status(500).send({
      success: false,
      error: 'Failed to delete gateway',
    });
  }
}

/**
 * Handle toggle gateway request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleToggleGateway(
  request: FastifyRequest<{ Params: GatewayParams }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const gatewayService = createGatewayService(request.server.pg);
    const gateway = await gatewayService.toggleGateway(request.params.id);

    reply.send({
      success: true,
      data: gateway,
      message: `Gateway ${gateway.isActive ? 'activated' : 'deactivated'} successfully`,
    });
  } catch (error) {
    if (error instanceof GatewayNotFoundError) {
      reply.status(404).send({
        success: false,
        error: error.message,
      });
      return;
    }

    logger.error({ error, gatewayId: request.params.id }, 'Failed to toggle gateway');
    reply.status(500).send({
      success: false,
      error: 'Failed to toggle gateway',
    });
  }
}

/**
 * Handle set default gateway request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleSetDefaultGateway(
  request: FastifyRequest<{ Params: GatewayParams }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const gatewayService = createGatewayService(request.server.pg);
    const gateway = await gatewayService.setDefaultGateway(request.params.id);

    reply.send({
      success: true,
      data: gateway,
      message: 'Gateway set as default successfully',
    });
  } catch (error) {
    if (error instanceof GatewayNotFoundError) {
      reply.status(404).send({
        success: false,
        error: error.message,
      });
      return;
    }

    logger.error({ error, gatewayId: request.params.id }, 'Failed to set default gateway');
    reply.status(500).send({
      success: false,
      error: 'Failed to set default gateway',
    });
  }
}
