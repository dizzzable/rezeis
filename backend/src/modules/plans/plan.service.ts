import type { Pool } from 'pg';
import { PlanRepository } from '../../repositories/plan.repository.js';
import { logger } from '../../utils/logger.js';
import type { CreatePlanInput, UpdatePlanInput, PlanResponse } from './plan.schemas.js';
import type { Plan } from '../../entities/plan.entity.js';

/**
 * Plan service configuration
 */
interface PlanServiceConfig {
  planRepository: PlanRepository;
}

/**
 * Plan not found error
 */
export class PlanNotFoundError extends Error {
  constructor(planId: string) {
    super(`Plan with id ${planId} not found`);
    this.name = 'PlanNotFoundError';
  }
}

/**
 * Plan already exists error
 */
export class PlanAlreadyExistsError extends Error {
  constructor(name: string) {
    super(`Plan with name '${name}' already exists`);
    this.name = 'PlanAlreadyExistsError';
  }
}

/**
 * Create plan service factory
 * @param db - PostgreSQL pool instance
 * @returns Plan service instance
 */
export function createPlanService(db: Pool): PlanService {
  const planRepository = new PlanRepository(db);
  return new PlanService({ planRepository });
}

/**
 * Plan service class
 * Handles all plan-related business logic
 */
class PlanService {
  private readonly planRepository: PlanRepository;

  constructor(config: PlanServiceConfig) {
    this.planRepository = config.planRepository;
  }

  /**
   * Map Plan entity to PlanResponse
   * @param plan - Plan entity
   * @returns Plan response object
   */
  private mapPlanToResponse(plan: Plan): PlanResponse {
    return {
      id: plan.id,
      name: plan.name,
      description: plan.description,
      price: plan.price,
      durationDays: plan.durationDays,
      trafficLimit: plan.trafficLimit,
      isActive: plan.isActive,
      createdAt: plan.createdAt.toISOString(),
      updatedAt: plan.updatedAt.toISOString(),
    };
  }

  /**
   * Get all plans
   * @returns Array of all plans
   */
  async getAllPlans(): Promise<PlanResponse[]> {
    const plans = await this.planRepository.findAll();
    return plans.map((plan) => this.mapPlanToResponse(plan));
  }

  /**
   * Get active plans
   * @returns Array of active plans
   */
  async getActivePlans(): Promise<PlanResponse[]> {
    const plans = await this.planRepository.findActive();
    return plans.map((plan) => this.mapPlanToResponse(plan));
  }

  /**
   * Get plan by ID
   * @param id - Plan ID
   * @returns Plan or null
   */
  async getPlanById(id: string): Promise<PlanResponse | null> {
    const plan = await this.planRepository.findById(id);
    return plan ? this.mapPlanToResponse(plan) : null;
  }

  /**
   * Create new plan
   * @param data - Create plan data
   * @returns Created plan
   */
  async createPlan(data: CreatePlanInput): Promise<PlanResponse> {
    // Check if plan name already exists
    const existingByName = await this.planRepository.findByName(data.name);
    if (existingByName) {
      throw new PlanAlreadyExistsError(data.name);
    }

    const createData = {
      name: data.name,
      description: data.description,
      price: data.price,
      durationDays: data.durationDays,
      trafficLimit: data.trafficLimit,
      isActive: data.isActive,
    };

    const plan = await this.planRepository.create(createData);
    logger.info({ planId: plan.id }, 'Plan created successfully');

    return this.mapPlanToResponse(plan);
  }

  /**
   * Update plan
   * @param id - Plan ID
   * @param data - Update plan data
   * @returns Updated plan
   */
  async updatePlan(id: string, data: UpdatePlanInput): Promise<PlanResponse> {
    const existingPlan = await this.planRepository.findById(id);
    if (!existingPlan) {
      throw new PlanNotFoundError(id);
    }

    // Check if name is being changed and if it already exists
    if (data.name && data.name !== existingPlan.name) {
      const existingByName = await this.planRepository.findByName(data.name);
      if (existingByName) {
        throw new PlanAlreadyExistsError(data.name);
      }
    }

    const updateData = {
      name: data.name,
      description: data.description,
      price: data.price,
      durationDays: data.durationDays,
      trafficLimit: data.trafficLimit,
      isActive: data.isActive,
    };

    const plan = await this.planRepository.update(id, updateData);
    logger.info({ planId: id }, 'Plan updated successfully');

    return this.mapPlanToResponse(plan);
  }

  /**
   * Delete plan
   * @param id - Plan ID
   * @returns True if deleted
   */
  async deletePlan(id: string): Promise<boolean> {
    const existingPlan = await this.planRepository.findById(id);
    if (!existingPlan) {
      throw new PlanNotFoundError(id);
    }

    const deleted = await this.planRepository.delete(id);
    if (deleted) {
      logger.info({ planId: id }, 'Plan deleted successfully');
    }

    return deleted;
  }

  /**
   * Toggle plan active status
   * @param id - Plan ID
   * @returns Updated plan
   */
  async togglePlan(id: string): Promise<PlanResponse> {
    const existingPlan = await this.planRepository.findById(id);
    if (!existingPlan) {
      throw new PlanNotFoundError(id);
    }

    const plan = await this.planRepository.toggleActive(id);
    logger.info({ planId: id, isActive: plan.isActive }, 'Plan toggled successfully');

    return this.mapPlanToResponse(plan);
  }
}
