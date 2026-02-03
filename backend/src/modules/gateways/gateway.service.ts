import type { Pool } from 'pg';
import { GatewayRepository } from '../../repositories/gateway.repository.js';
import { logger } from '../../utils/logger.js';
import type { CreateGatewayInput, UpdateGatewayInput, GatewayResponse } from './gateway.schemas.js';
import type { Gateway } from '../../entities/gateway.entity.js';

/**
 * Gateway service configuration
 */
interface GatewayServiceConfig {
  gatewayRepository: GatewayRepository;
}

/**
 * Gateway not found error
 */
export class GatewayNotFoundError extends Error {
  constructor(gatewayId: string) {
    super(`Gateway with id ${gatewayId} not found`);
    this.name = 'GatewayNotFoundError';
  }
}

/**
 * Gateway already exists error
 */
export class GatewayAlreadyExistsError extends Error {
  constructor(name: string) {
    super(`Gateway with name '${name}' already exists`);
    this.name = 'GatewayAlreadyExistsError';
  }
}

/**
 * Cannot delete default gateway error
 */
export class CannotDeleteDefaultGatewayError extends Error {
  constructor() {
    super('Cannot delete the default gateway. Set another gateway as default first.');
    this.name = 'CannotDeleteDefaultGatewayError';
  }
}

/**
 * Create gateway service factory
 * @param db - PostgreSQL pool instance
 * @returns Gateway service instance
 */
export function createGatewayService(db: Pool): GatewayService {
  const gatewayRepository = new GatewayRepository(db);
  return new GatewayService({ gatewayRepository });
}

/**
 * Gateway service class
 * Handles all gateway-related business logic
 */
class GatewayService {
  private readonly gatewayRepository: GatewayRepository;

  constructor(config: GatewayServiceConfig) {
    this.gatewayRepository = config.gatewayRepository;
  }

  /**
   * Map Gateway entity to GatewayResponse
   * @param gateway - Gateway entity
   * @returns Gateway response object
   */
  private mapGatewayToResponse(gateway: Gateway): GatewayResponse {
    return {
      id: gateway.id,
      name: gateway.name,
      type: gateway.type,
      isActive: gateway.isActive,
      isDefault: gateway.isDefault,
      config: gateway.config,
      displayOrder: gateway.displayOrder,
      iconUrl: gateway.iconUrl,
      description: gateway.description,
      supportedCurrencies: gateway.supportedCurrencies,
      minAmount: gateway.minAmount,
      maxAmount: gateway.maxAmount,
      feePercent: gateway.feePercent,
      feeFixed: gateway.feeFixed,
      createdAt: gateway.createdAt.toISOString(),
      updatedAt: gateway.updatedAt.toISOString(),
    };
  }

  /**
   * Get all gateways
   * @returns Array of all gateways
   */
  async getAllGateways(): Promise<GatewayResponse[]> {
    const gateways = await this.gatewayRepository.findAll();
    return gateways.map((gateway) => this.mapGatewayToResponse(gateway));
  }

  /**
   * Get active gateways
   * @returns Array of active gateways
   */
  async getActiveGateways(): Promise<GatewayResponse[]> {
    const gateways = await this.gatewayRepository.findActive();
    return gateways.map((gateway) => this.mapGatewayToResponse(gateway));
  }

  /**
   * Get default gateway
   * @returns Default gateway or null
   */
  async getDefaultGateway(): Promise<GatewayResponse | null> {
    const gateway = await this.gatewayRepository.findDefault();
    return gateway ? this.mapGatewayToResponse(gateway) : null;
  }

  /**
   * Get gateway by ID
   * @param id - Gateway ID
   * @returns Gateway or null
   */
  async getGatewayById(id: string): Promise<GatewayResponse | null> {
    const gateway = await this.gatewayRepository.findById(id);
    return gateway ? this.mapGatewayToResponse(gateway) : null;
  }

  /**
   * Create new gateway
   * @param data - Create gateway data
   * @returns Created gateway
   */
  async createGateway(data: CreateGatewayInput): Promise<GatewayResponse> {
    // Check if gateway name already exists
    const existingByName = await this.gatewayRepository.findByName(data.name);
    if (existingByName) {
      throw new GatewayAlreadyExistsError(data.name);
    }

    // If setting as default, clear existing default first
    if (data.isDefault) {
      await this.gatewayRepository.clearDefault();
    }

    const createData = {
      name: data.name,
      type: data.type,
      isActive: data.isActive,
      isDefault: data.isDefault,
      config: data.config,
      displayOrder: data.displayOrder,
      iconUrl: data.iconUrl,
      description: data.description,
      supportedCurrencies: data.supportedCurrencies,
      minAmount: data.minAmount,
      maxAmount: data.maxAmount,
      feePercent: data.feePercent,
      feeFixed: data.feeFixed,
    };

    const gateway = await this.gatewayRepository.create(createData);
    logger.info({ gatewayId: gateway.id }, 'Gateway created successfully');

    return this.mapGatewayToResponse(gateway);
  }

  /**
   * Update gateway
   * @param id - Gateway ID
   * @param data - Update gateway data
   * @returns Updated gateway
   */
  async updateGateway(id: string, data: UpdateGatewayInput): Promise<GatewayResponse> {
    const existingGateway = await this.gatewayRepository.findById(id);
    if (!existingGateway) {
      throw new GatewayNotFoundError(id);
    }

    // Check if name is being changed and if it already exists
    if (data.name && data.name !== existingGateway.name) {
      const existingByName = await this.gatewayRepository.findByName(data.name);
      if (existingByName) {
        throw new GatewayAlreadyExistsError(data.name);
      }
    }

    // If setting as default, clear existing default first
    if (data.isDefault === true && !existingGateway.isDefault) {
      await this.gatewayRepository.clearDefault();
    }

    const updateData = {
      name: data.name,
      type: data.type,
      isActive: data.isActive,
      isDefault: data.isDefault,
      config: data.config,
      displayOrder: data.displayOrder,
      iconUrl: data.iconUrl,
      description: data.description,
      supportedCurrencies: data.supportedCurrencies,
      minAmount: data.minAmount,
      maxAmount: data.maxAmount,
      feePercent: data.feePercent,
      feeFixed: data.feeFixed,
    };

    const gateway = await this.gatewayRepository.update(id, updateData);
    logger.info({ gatewayId: id }, 'Gateway updated successfully');

    return this.mapGatewayToResponse(gateway);
  }

  /**
   * Delete gateway
   * @param id - Gateway ID
   * @returns True if deleted
   */
  async deleteGateway(id: string): Promise<boolean> {
    const existingGateway = await this.gatewayRepository.findById(id);
    if (!existingGateway) {
      throw new GatewayNotFoundError(id);
    }

    // Prevent deletion of default gateway
    if (existingGateway.isDefault) {
      throw new CannotDeleteDefaultGatewayError();
    }

    const deleted = await this.gatewayRepository.delete(id);
    if (deleted) {
      logger.info({ gatewayId: id }, 'Gateway deleted successfully');
    }

    return deleted;
  }

  /**
   * Toggle gateway active status
   * @param id - Gateway ID
   * @returns Updated gateway
   */
  async toggleGateway(id: string): Promise<GatewayResponse> {
    const existingGateway = await this.gatewayRepository.findById(id);
    if (!existingGateway) {
      throw new GatewayNotFoundError(id);
    }

    const gateway = await this.gatewayRepository.toggleActive(id);
    logger.info({ gatewayId: id, isActive: gateway.isActive }, 'Gateway toggled successfully');

    return this.mapGatewayToResponse(gateway);
  }

  /**
   * Set gateway as default
   * @param id - Gateway ID
   * @returns Updated gateway
   */
  async setDefaultGateway(id: string): Promise<GatewayResponse> {
    const existingGateway = await this.gatewayRepository.findById(id);
    if (!existingGateway) {
      throw new GatewayNotFoundError(id);
    }

    // Clear existing default first
    await this.gatewayRepository.clearDefault();

    // Set new default
    const gateway = await this.gatewayRepository.setDefault(id);
    logger.info({ gatewayId: id }, 'Gateway set as default successfully');

    return this.mapGatewayToResponse(gateway);
  }

  /**
   * Get gateways by type
   * @param type - Gateway type
   * @returns Array of gateways
   */
  async getGatewaysByType(type: Gateway['type']): Promise<GatewayResponse[]> {
    const gateways = await this.gatewayRepository.findByType(type);
    return gateways.map((gateway) => this.mapGatewayToResponse(gateway));
  }
}
