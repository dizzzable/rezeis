import type { Pool } from 'pg';
import { PromocodeRepository } from '../../repositories/promocode.repository.js';
import { logger } from '../../utils/logger.js';
import type { CreatePromocodeInput, UpdatePromocodeInput, PromocodeResponse } from './promocode.schemas.js';
import type { Promocode } from '../../entities/promocode.entity.js';

/**
 * Promocode service configuration
 */
interface PromocodeServiceConfig {
  promocodeRepository: PromocodeRepository;
}

/**
 * Promocode not found error
 */
export class PromocodeNotFoundError extends Error {
  constructor(promocodeId: string) {
    super(`Promocode with id ${promocodeId} not found`);
    this.name = 'PromocodeNotFoundError';
  }
}

/**
 * Promocode already exists error
 */
export class PromocodeAlreadyExistsError extends Error {
  constructor(code: string) {
    super(`Promocode with code '${code}' already exists`);
    this.name = 'PromocodeAlreadyExistsError';
  }
}

/**
 * Invalid promocode error
 */
export class InvalidPromocodeError extends Error {
  constructor(code: string) {
    super(`Promocode '${code}' is invalid or expired`);
    this.name = 'InvalidPromocodeError';
  }
}

/**
 * Create promocode service factory
 * @param db - PostgreSQL pool instance
 * @returns Promocode service instance
 */
export function createPromocodeService(db: Pool): PromocodeService {
  const promocodeRepository = new PromocodeRepository(db);
  return new PromocodeService({ promocodeRepository });
}

/**
 * Promocode service class
 * Handles all promocode-related business logic
 */
class PromocodeService {
  private readonly promocodeRepository: PromocodeRepository;

  constructor(config: PromocodeServiceConfig) {
    this.promocodeRepository = config.promocodeRepository;
  }

  /**
   * Map Promocode entity to PromocodeResponse
   * @param promocode - Promocode entity
   * @returns Promocode response object
   */
  private mapPromocodeToResponse(promocode: Promocode): PromocodeResponse {
    return {
      id: promocode.id,
      code: promocode.code,
      description: promocode.description,
      rewardType: promocode.rewardType,
      rewardValue: promocode.rewardValue,
      rewardPlanId: promocode.rewardPlanId,
      availability: promocode.availability,
      allowedUserIds: promocode.allowedUserIds,
      maxUses: promocode.maxUses,
      usedCount: promocode.usedCount,
      maxUsesPerUser: promocode.maxUsesPerUser,
      startsAt: promocode.startsAt?.toISOString(),
      expiresAt: promocode.expiresAt?.toISOString(),
      isActive: promocode.isActive,
      createdBy: promocode.createdBy,
      createdAt: promocode.createdAt.toISOString(),
      updatedAt: promocode.updatedAt.toISOString(),
    };
  }

  /**
   * Get all promocodes
   * @returns Array of all promocodes
   */
  async getAllPromocodes(): Promise<PromocodeResponse[]> {
    const promocodes = await this.promocodeRepository.findAll();
    return promocodes.map((promocode) => this.mapPromocodeToResponse(promocode));
  }

  /**
   * Get active promocodes
   * @returns Array of active promocodes
   */
  async getActivePromocodes(): Promise<PromocodeResponse[]> {
    const promocodes = await this.promocodeRepository.findActive();
    return promocodes.map((promocode) => this.mapPromocodeToResponse(promocode));
  }

  /**
   * Get promocode by ID
   * @param id - Promocode ID
   * @returns Promocode or null
   */
  async getPromocodeById(id: string): Promise<PromocodeResponse | null> {
    const promocode = await this.promocodeRepository.findById(id);
    return promocode ? this.mapPromocodeToResponse(promocode) : null;
  }

  /**
   * Get promocode by code
   * @param code - Promocode code
   * @returns Promocode or null
   */
  async getPromocodeByCode(code: string): Promise<PromocodeResponse | null> {
    const promocode = await this.promocodeRepository.findByCode(code);
    return promocode ? this.mapPromocodeToResponse(promocode) : null;
  }

  /**
   * Create new promocode
   * @param data - Create promocode data
   * @returns Created promocode
   */
  async createPromocode(data: CreatePromocodeInput): Promise<PromocodeResponse> {
    // Check if promocode code already exists
    const existingByCode = await this.promocodeRepository.findByCode(data.code);
    if (existingByCode) {
      throw new PromocodeAlreadyExistsError(data.code);
    }

    const createData = {
      code: data.code,
      description: data.description,
      rewardType: data.rewardType,
      rewardValue: data.rewardValue,
      rewardPlanId: data.rewardPlanId,
      availability: data.availability,
      allowedUserIds: data.allowedUserIds,
      maxUses: data.maxUses,
      maxUsesPerUser: data.maxUsesPerUser,
      startsAt: data.startsAt ? new Date(data.startsAt) : undefined,
      expiresAt: data.expiresAt ? new Date(data.expiresAt) : undefined,
      isActive: data.isActive,
    };

    const promocode = await this.promocodeRepository.create(createData);
    logger.info({ promocodeId: promocode.id }, 'Promocode created successfully');

    return this.mapPromocodeToResponse(promocode);
  }

  /**
   * Update promocode
   * @param id - Promocode ID
   * @param data - Update promocode data
   * @returns Updated promocode
   */
  async updatePromocode(id: string, data: UpdatePromocodeInput): Promise<PromocodeResponse> {
    const existingPromocode = await this.promocodeRepository.findById(id);
    if (!existingPromocode) {
      throw new PromocodeNotFoundError(id);
    }

    // Check if code is being changed and if it already exists
    if (data.code && data.code !== existingPromocode.code) {
      const existingByCode = await this.promocodeRepository.findByCode(data.code);
      if (existingByCode) {
        throw new PromocodeAlreadyExistsError(data.code);
      }
    }

    const updateData = {
      code: data.code,
      description: data.description,
      rewardType: data.rewardType,
      rewardValue: data.rewardValue,
      rewardPlanId: data.rewardPlanId,
      availability: data.availability,
      allowedUserIds: data.allowedUserIds,
      maxUses: data.maxUses,
      maxUsesPerUser: data.maxUsesPerUser,
      startsAt: data.startsAt ? new Date(data.startsAt) : undefined,
      expiresAt: data.expiresAt ? new Date(data.expiresAt) : undefined,
      isActive: data.isActive,
    };

    const promocode = await this.promocodeRepository.update(id, updateData);
    logger.info({ promocodeId: id }, 'Promocode updated successfully');

    return this.mapPromocodeToResponse(promocode);
  }

  /**
   * Delete promocode
   * @param id - Promocode ID
   * @returns True if deleted
   */
  async deletePromocode(id: string): Promise<boolean> {
    const existingPromocode = await this.promocodeRepository.findById(id);
    if (!existingPromocode) {
      throw new PromocodeNotFoundError(id);
    }

    const deleted = await this.promocodeRepository.delete(id);
    if (deleted) {
      logger.info({ promocodeId: id }, 'Promocode deleted successfully');
    }

    return deleted;
  }

  /**
   * Toggle promocode active status
   * @param id - Promocode ID
   * @returns Updated promocode
   */
  async togglePromocode(id: string): Promise<PromocodeResponse> {
    const existingPromocode = await this.promocodeRepository.findById(id);
    if (!existingPromocode) {
      throw new PromocodeNotFoundError(id);
    }

    const promocode = await this.promocodeRepository.toggleActive(id);
    logger.info({ promocodeId: id, isActive: promocode.isActive }, 'Promocode toggled successfully');

    return this.mapPromocodeToResponse(promocode);
  }

  /**
   * Validate promocode
   * @param code - Promocode code
   * @returns Valid promocode or null
   */
  async validatePromocode(code: string): Promise<PromocodeResponse | null> {
    const promocode = await this.promocodeRepository.findValid(code);
    return promocode ? this.mapPromocodeToResponse(promocode) : null;
  }

  /**
   * Apply promocode (increment used count)
   * @param code - Promocode code
   * @returns Updated promocode
   */
  async applyPromocode(code: string): Promise<PromocodeResponse> {
    const promocode = await this.promocodeRepository.findValid(code);
    if (!promocode) {
      throw new InvalidPromocodeError(code);
    }

    const updatedPromocode = await this.promocodeRepository.incrementUsedCount(promocode.id);
    logger.info({ promocodeId: updatedPromocode.id, code }, 'Promocode applied successfully');

    return this.mapPromocodeToResponse(updatedPromocode);
  }
}
