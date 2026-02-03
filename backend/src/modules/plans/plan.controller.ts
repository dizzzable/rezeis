import type { FastifyRequest, FastifyReply } from 'fastify';
import {
  createPlanService,
  PlanNotFoundError,
  PlanAlreadyExistsError,
} from './plan.service.js';
import { logger } from '../../utils/logger.js';
import type { CreatePlanInput, UpdatePlanInput, PlanParams } from './plan.schemas.js';

/**
 * Handle get all plans request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleGetPlans(
  _request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  try {
    const planService = createPlanService(_request.server.pg);
    const plans = await planService.getAllPlans();

    reply.send({
      success: true,
      data: plans,
    });
  } catch (error) {
    logger.error({ error }, 'Failed to get plans');
    reply.status(500).send({
      success: false,
      error: 'Failed to get plans',
    });
  }
}

/**
 * Handle get plan by ID request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleGetPlanById(
  request: FastifyRequest<{ Params: PlanParams }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const planService = createPlanService(request.server.pg);
    const plan = await planService.getPlanById(request.params.id);

    if (!plan) {
      reply.status(404).send({
        success: false,
        error: 'Plan not found',
      });
      return;
    }

    reply.send({
      success: true,
      data: plan,
    });
  } catch (error) {
    logger.error({ error, planId: request.params.id }, 'Failed to get plan');
    reply.status(500).send({
      success: false,
      error: 'Failed to get plan',
    });
  }
}

/**
 * Handle create plan request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleCreatePlan(
  request: FastifyRequest<{ Body: CreatePlanInput }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const planService = createPlanService(request.server.pg);
    const plan = await planService.createPlan(request.body);

    reply.status(201).send({
      success: true,
      data: plan,
      message: 'Plan created successfully',
    });
  } catch (error) {
    if (error instanceof PlanAlreadyExistsError) {
      reply.status(409).send({
        success: false,
        error: error.message,
      });
      return;
    }

    logger.error({ error }, 'Failed to create plan');
    reply.status(500).send({
      success: false,
      error: 'Failed to create plan',
    });
  }
}

/**
 * Handle update plan request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleUpdatePlan(
  request: FastifyRequest<{ Params: PlanParams; Body: UpdatePlanInput }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const planService = createPlanService(request.server.pg);
    const plan = await planService.updatePlan(request.params.id, request.body);

    reply.send({
      success: true,
      data: plan,
      message: 'Plan updated successfully',
    });
  } catch (error) {
    if (error instanceof PlanNotFoundError) {
      reply.status(404).send({
        success: false,
        error: error.message,
      });
      return;
    }

    if (error instanceof PlanAlreadyExistsError) {
      reply.status(409).send({
        success: false,
        error: error.message,
      });
      return;
    }

    logger.error({ error, planId: request.params.id }, 'Failed to update plan');
    reply.status(500).send({
      success: false,
      error: 'Failed to update plan',
    });
  }
}

/**
 * Handle delete plan request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleDeletePlan(
  request: FastifyRequest<{ Params: PlanParams }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const planService = createPlanService(request.server.pg);
    const deleted = await planService.deletePlan(request.params.id);

    if (!deleted) {
      reply.status(404).send({
        success: false,
        error: 'Plan not found',
      });
      return;
    }

    reply.send({
      success: true,
      message: 'Plan deleted successfully',
    });
  } catch (error) {
    if (error instanceof PlanNotFoundError) {
      reply.status(404).send({
        success: false,
        error: error.message,
      });
      return;
    }

    logger.error({ error, planId: request.params.id }, 'Failed to delete plan');
    reply.status(500).send({
      success: false,
      error: 'Failed to delete plan',
    });
  }
}

/**
 * Handle toggle plan request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleTogglePlan(
  request: FastifyRequest<{ Params: PlanParams }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const planService = createPlanService(request.server.pg);
    const plan = await planService.togglePlan(request.params.id);

    reply.send({
      success: true,
      data: plan,
      message: `Plan ${plan.isActive ? 'activated' : 'deactivated'} successfully`,
    });
  } catch (error) {
    if (error instanceof PlanNotFoundError) {
      reply.status(404).send({
        success: false,
        error: error.message,
      });
      return;
    }

    logger.error({ error, planId: request.params.id }, 'Failed to toggle plan');
    reply.status(500).send({
      success: false,
      error: 'Failed to toggle plan',
    });
  }
}
