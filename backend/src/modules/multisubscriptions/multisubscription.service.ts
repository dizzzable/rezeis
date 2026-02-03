import type { MultisubscriptionRepository } from '../../repositories/multisubscription.repository.js';
import type { Multisubscription, CreateMultisubscriptionDto, UpdateMultisubscriptionDto, MultisubscriptionFilters } from '../../entities/multisubscription.entity.js';
import type { PaginationOptions, PaginatedResult } from '../../repositories/base.repository.js';
import { logger } from '../../utils/logger.js';

/**
 * Multisubscription service error class
 */
export class MultisubscriptionServiceError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'MultisubscriptionServiceError';
  }
}

/**
 * Multisubscription service class
 * Handles business logic for multisubscription management
 */
export class MultisubscriptionService {
  constructor(private readonly repository: MultisubscriptionRepository) {}

  /**
   * Get all multisubscriptions with pagination and filters
   */
  async getMultisubscriptions(
    filters: MultisubscriptionFilters,
    options: PaginationOptions
  ): Promise<PaginatedResult<Multisubscription>> {
    try {
      return await this.repository.findWithFilters(filters, options);
    } catch (error) {
      logger.error({ error, filters }, 'Failed to get multisubscriptions');
      throw new MultisubscriptionServiceError('Failed to get multisubscriptions', error);
    }
  }

  /**
   * Get multisubscription by ID
   */
  async getMultisubscriptionById(id: string): Promise<Multisubscription | null> {
    try {
      return await this.repository.findById(id);
    } catch (error) {
      logger.error({ error, id }, 'Failed to get multisubscription by ID');
      throw new MultisubscriptionServiceError('Failed to get multisubscription by ID', error);
    }
  }

  /**
   * Get multisubscriptions by user ID
   */
  async getMultisubscriptionsByUserId(userId: string): Promise<Multisubscription[]> {
    try {
      return await this.repository.findByUserId(userId);
    } catch (error) {
      logger.error({ error, userId }, 'Failed to get multisubscriptions by user ID');
      throw new MultisubscriptionServiceError('Failed to get multisubscriptions by user ID', error);
    }
  }

  /**
   * Create new multisubscription
   */
  async createMultisubscription(data: CreateMultisubscriptionDto): Promise<Multisubscription> {
    try {
      // Validate that subscriptionIds are unique
      const uniqueIds = [...new Set(data.subscriptionIds)];
      if (uniqueIds.length !== data.subscriptionIds.length) {
        throw new MultisubscriptionServiceError('Duplicate subscription IDs are not allowed');
      }

      return await this.repository.create({
        ...data,
        subscriptionIds: uniqueIds,
      });
    } catch (error) {
      logger.error({ error, data }, 'Failed to create multisubscription');
      throw new MultisubscriptionServiceError('Failed to create multisubscription', error);
    }
  }

  /**
   * Update multisubscription
   */
  async updateMultisubscription(id: string, data: UpdateMultisubscriptionDto): Promise<Multisubscription> {
    try {
      const existing = await this.repository.findById(id);
      if (!existing) {
        throw new MultisubscriptionServiceError('Multisubscription not found');
      }

      // Validate that subscriptionIds are unique if provided
      if (data.subscriptionIds) {
        const uniqueIds = [...new Set(data.subscriptionIds)];
        if (uniqueIds.length !== data.subscriptionIds.length) {
          throw new MultisubscriptionServiceError('Duplicate subscription IDs are not allowed');
        }
        data.subscriptionIds = uniqueIds;
      }

      return await this.repository.update(id, data);
    } catch (error) {
      logger.error({ error, id, data }, 'Failed to update multisubscription');
      throw new MultisubscriptionServiceError('Failed to update multisubscription', error);
    }
  }

  /**
   * Delete multisubscription
   */
  async deleteMultisubscription(id: string): Promise<void> {
    try {
      const existing = await this.repository.findById(id);
      if (!existing) {
        throw new MultisubscriptionServiceError('Multisubscription not found');
      }

      const deleted = await this.repository.delete(id);
      if (!deleted) {
        throw new MultisubscriptionServiceError('Failed to delete multisubscription');
      }
    } catch (error) {
      logger.error({ error, id }, 'Failed to delete multisubscription');
      throw new MultisubscriptionServiceError('Failed to delete multisubscription', error);
    }
  }

  /**
   * Toggle multisubscription active status
   */
  async toggleMultisubscriptionStatus(id: string, isActive: boolean): Promise<Multisubscription> {
    try {
      const existing = await this.repository.findById(id);
      if (!existing) {
        throw new MultisubscriptionServiceError('Multisubscription not found');
      }

      return await this.repository.update(id, { isActive });
    } catch (error) {
      logger.error({ error, id, isActive }, 'Failed to toggle multisubscription status');
      throw new MultisubscriptionServiceError('Failed to toggle multisubscription status', error);
    }
  }

  /**
   * Get multisubscription statistics
   */
  async getStatistics(): Promise<{ total: number; active: number; inactive: number }> {
    try {
      const total = await this.repository.count();
      const active = await this.repository.countActive();
      return {
        total,
        active,
        inactive: total - active,
      };
    } catch (error) {
      logger.error({ error }, 'Failed to get multisubscription statistics');
      throw new MultisubscriptionServiceError('Failed to get multisubscription statistics', error);
    }
  }
}
