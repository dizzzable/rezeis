import type { FastifyRequest, FastifyReply } from 'fastify';
import { MultisubscriptionService, MultisubscriptionServiceError } from './multisubscription.service.js';
import type {
  CreateMultisubscriptionInput,
  UpdateMultisubscriptionInput,
  ToggleMultisubscriptionInput,
  ListMultisubscriptionsQuery,
} from './multisubscription.schemas.js';
import { logger } from '../../utils/logger.js';

/**
 * Multisubscription controller class
 * Handles HTTP requests for multisubscription management
 */
export class MultisubscriptionController {
  constructor(private readonly service: MultisubscriptionService) {}

  /**
   * Handle list multisubscriptions request
   */
  handleListMultisubscriptions = async (
    request: FastifyRequest<{ Querystring: ListMultisubscriptionsQuery }>,
    reply: FastifyReply
  ): Promise<void> => {
    try {
      const { page, limit, userId, isActive, search, sortBy, sortOrder } = request.query;

      const result = await this.service.getMultisubscriptions(
        { userId, isActive, search },
        { page, limit, sortBy, sortOrder }
      );

      reply.send({
        success: true,
        data: result,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to list multisubscriptions');
      reply.status(500).send({
        success: false,
        error: 'Failed to list multisubscriptions',
      });
    }
  };

  /**
   * Handle get multisubscription by ID request
   */
  handleGetMultisubscription = async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply
  ): Promise<void> => {
    try {
      const { id } = request.params;
      const multisubscription = await this.service.getMultisubscriptionById(id);

      if (!multisubscription) {
        reply.status(404).send({
          success: false,
          error: 'Multisubscription not found',
        });
        return;
      }

      reply.send({
        success: true,
        data: multisubscription,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get multisubscription');
      reply.status(500).send({
        success: false,
        error: 'Failed to get multisubscription',
      });
    }
  };

  /**
   * Handle get multisubscriptions by user ID request
   */
  handleGetMultisubscriptionsByUser = async (
    request: FastifyRequest<{ Params: { userId: string } }>,
    reply: FastifyReply
  ): Promise<void> => {
    try {
      const { userId } = request.params;
      const multisubscriptions = await this.service.getMultisubscriptionsByUserId(userId);

      reply.send({
        success: true,
        data: multisubscriptions,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get multisubscriptions by user');
      reply.status(500).send({
        success: false,
        error: 'Failed to get multisubscriptions by user',
      });
    }
  };

  /**
   * Handle create multisubscription request
   */
  handleCreateMultisubscription = async (
    request: FastifyRequest<{ Body: CreateMultisubscriptionInput }>,
    reply: FastifyReply
  ): Promise<void> => {
    try {
      const multisubscription = await this.service.createMultisubscription(request.body);

      reply.status(201).send({
        success: true,
        data: multisubscription,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to create multisubscription');

      if (error instanceof MultisubscriptionServiceError) {
        reply.status(400).send({
          success: false,
          error: error.message,
        });
        return;
      }

      reply.status(500).send({
        success: false,
        error: 'Failed to create multisubscription',
      });
    }
  };

  /**
   * Handle update multisubscription request
   */
  handleUpdateMultisubscription = async (
    request: FastifyRequest<{ Params: { id: string }; Body: UpdateMultisubscriptionInput }>,
    reply: FastifyReply
  ): Promise<void> => {
    try {
      const { id } = request.params;
      const multisubscription = await this.service.updateMultisubscription(id, request.body);

      reply.send({
        success: true,
        data: multisubscription,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to update multisubscription');

      if (error instanceof MultisubscriptionServiceError) {
        const status = error.message.includes('not found') ? 404 : 400;
        reply.status(status).send({
          success: false,
          error: error.message,
        });
        return;
      }

      reply.status(500).send({
        success: false,
        error: 'Failed to update multisubscription',
      });
    }
  };

  /**
   * Handle delete multisubscription request
   */
  handleDeleteMultisubscription = async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply
  ): Promise<void> => {
    try {
      const { id } = request.params;
      await this.service.deleteMultisubscription(id);

      reply.send({
        success: true,
        message: 'Multisubscription deleted successfully',
      });
    } catch (error) {
      logger.error({ error }, 'Failed to delete multisubscription');

      if (error instanceof MultisubscriptionServiceError) {
        const status = error.message.includes('not found') ? 404 : 500;
        reply.status(status).send({
          success: false,
          error: error.message,
        });
        return;
      }

      reply.status(500).send({
        success: false,
        error: 'Failed to delete multisubscription',
      });
    }
  };

  /**
   * Handle toggle multisubscription status request
   */
  handleToggleMultisubscription = async (
    request: FastifyRequest<{ Params: { id: string }; Body: ToggleMultisubscriptionInput }>,
    reply: FastifyReply
  ): Promise<void> => {
    try {
      const { id } = request.params;
      const { isActive } = request.body;
      const multisubscription = await this.service.toggleMultisubscriptionStatus(id, isActive);

      reply.send({
        success: true,
        data: multisubscription,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to toggle multisubscription status');

      if (error instanceof MultisubscriptionServiceError) {
        const status = error.message.includes('not found') ? 404 : 500;
        reply.status(status).send({
          success: false,
          error: error.message,
        });
        return;
      }

      reply.status(500).send({
        success: false,
        error: 'Failed to toggle multisubscription status',
      });
    }
  };

  /**
   * Handle get statistics request
   */
  handleGetStatistics = async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try {
      const stats = await this.service.getStatistics();

      reply.send({
        success: true,
        data: stats,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get multisubscription statistics');
      reply.status(500).send({
        success: false,
        error: 'Failed to get statistics',
      });
    }
  };
}
