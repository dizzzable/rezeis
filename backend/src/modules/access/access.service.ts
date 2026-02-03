import type { Pool } from 'pg';
import { AdminRepository } from '../../repositories/admin.repository.js';
import { logger } from '../../utils/logger.js';
import type {
  CreateAdminInput,
  UpdateAdminRoleInput,
  GetAdminsQuery,
  AdminResponse,
} from './access.schemas.js';
import type { Admin, AdminFilters } from '../../entities/admin.entity.js';
import type { PaginatedResult } from '../../repositories/base.repository.js';

/**
 * Access service configuration
 */
interface AccessServiceConfig {
  adminRepository: AdminRepository;
}

/**
 * Admin not found error
 */
export class AdminNotFoundError extends Error {
  constructor(adminId: string) {
    super(`Admin with id ${adminId} not found`);
    this.name = 'AdminNotFoundError';
  }
}

/**
 * Admin already exists error
 */
export class AdminAlreadyExistsError extends Error {
  constructor(field: string, value: string) {
    super(`Admin with ${field} '${value}' already exists`);
    this.name = 'AdminAlreadyExistsError';
  }
}

/**
 * Cannot delete super admin error
 */
export class CannotDeleteSuperAdminError extends Error {
  constructor() {
    super('Cannot delete the last super admin');
    this.name = 'CannotDeleteSuperAdminError';
  }
}

/**
 * Permission denied error
 */
export class PermissionDeniedError extends Error {
  constructor() {
    super('Only super admin can manage administrators');
    this.name = 'PermissionDeniedError';
  }
}

/**
 * Create access service factory
 * @param db - PostgreSQL pool instance
 * @returns Access service instance
 */
export function createAccessService(db: Pool): AccessService {
  const adminRepository = new AdminRepository(db);
  return new AccessService({ adminRepository });
}

/**
 * Access service class
 * Handles all access management-related business logic
 */
class AccessService {
  private readonly adminRepository: AdminRepository;

  constructor(config: AccessServiceConfig) {
    this.adminRepository = config.adminRepository;
  }

  /**
   * Map Admin entity to AdminResponse
   * @param admin - Admin entity
   * @returns Admin response object
   */
  private mapAdminToResponse(admin: Admin): AdminResponse {
    return {
      id: admin.id,
      telegramId: admin.telegramId,
      username: admin.username,
      firstName: admin.firstName,
      lastName: admin.lastName,
      role: admin.role,
      isActive: admin.isActive,
      createdAt: admin.createdAt.toISOString(),
      updatedAt: admin.updatedAt.toISOString(),
    };
  }

  /**
   * Check if user is super admin
   * @param userRole - User role from JWT
   * @returns True if super admin
   */
  private isSuperAdmin(userRole: string): boolean {
    return userRole === 'super_admin';
  }

  /**
   * Verify super admin permission
   * @param userRole - User role from JWT
   * @throws PermissionDeniedError if not super admin
   */
  private verifySuperAdmin(userRole: string): void {
    if (!this.isSuperAdmin(userRole)) {
      throw new PermissionDeniedError();
    }
  }

  /**
   * Get admins with pagination and filters
   * @param params - Query parameters
   * @param userRole - Current user role for authorization
   * @returns Paginated admins
   */
  async getAdmins(
    params: GetAdminsQuery,
    userRole: string
  ): Promise<PaginatedResult<AdminResponse>> {
    this.verifySuperAdmin(userRole);

    const filters: AdminFilters = {};

    if (params.role) {
      filters.role = params.role;
    }

    if (params.isActive !== undefined) {
      filters.isActive = params.isActive;
    }

    if (params.search) {
      filters.search = params.search;
    }

    const result = await this.adminRepository.getAdminsWithPagination(
      params.page,
      params.limit,
      Object.keys(filters).length > 0 ? filters : undefined
    );

    return {
      data: result.data.map((admin) => this.mapAdminToResponse(admin)),
      total: result.total,
      page: result.page,
      limit: result.limit,
      totalPages: result.totalPages,
    };
  }

  /**
   * Get admin by ID
   * @param id - Admin ID
   * @param userRole - Current user role for authorization
   * @returns Admin or null
   */
  async getAdminById(id: string, userRole: string): Promise<AdminResponse | null> {
    this.verifySuperAdmin(userRole);

    const admin = await this.adminRepository.findById(id);
    return admin ? this.mapAdminToResponse(admin) : null;
  }

  /**
   * Create new admin
   * @param data - Create admin data
   * @param userRole - Current user role for authorization
   * @returns Created admin
   */
  async createAdmin(data: CreateAdminInput, userRole: string): Promise<AdminResponse> {
    this.verifySuperAdmin(userRole);

    // Check if telegramId already exists
    const existingByTelegram = await this.adminRepository.findByTelegramId(data.telegramId);
    if (existingByTelegram) {
      throw new AdminAlreadyExistsError('telegramId', data.telegramId);
    }

    const createData = {
      telegramId: data.telegramId,
      username: data.username,
      firstName: data.firstName,
      lastName: data.lastName,
      role: data.role,
      isActive: data.isActive,
    };

    const admin = await this.adminRepository.create(createData);
    logger.info({ adminId: admin.id }, 'Admin created successfully');

    return this.mapAdminToResponse(admin);
  }

  /**
   * Update admin role
   * @param id - Admin ID
   * @param data - Update role data
   * @param userRole - Current user role for authorization
   * @returns Updated admin
   */
  async updateAdminRole(
    id: string,
    data: UpdateAdminRoleInput,
    userRole: string
  ): Promise<AdminResponse> {
    this.verifySuperAdmin(userRole);

    const existingAdmin = await this.adminRepository.findById(id);
    if (!existingAdmin) {
      throw new AdminNotFoundError(id);
    }

    // Prevent demoting the last super admin
    if (existingAdmin.role === 'super_admin' && data.role === 'admin') {
      const superAdminCount = await this.adminRepository.countByRole('super_admin');
      if (superAdminCount <= 1) {
        throw new CannotDeleteSuperAdminError();
      }
    }

    const admin = await this.adminRepository.updateRole(id, data.role);
    logger.info({ adminId: id, newRole: data.role }, 'Admin role updated successfully');

    return this.mapAdminToResponse(admin);
  }

  /**
   * Delete admin
   * @param id - Admin ID
   * @param userRole - Current user role for authorization
   * @returns True if deleted
   */
  async deleteAdmin(id: string, userRole: string): Promise<boolean> {
    this.verifySuperAdmin(userRole);

    const existingAdmin = await this.adminRepository.findById(id);
    if (!existingAdmin) {
      throw new AdminNotFoundError(id);
    }

    // Prevent deleting the last super admin
    if (existingAdmin.role === 'super_admin') {
      const superAdminCount = await this.adminRepository.countByRole('super_admin');
      if (superAdminCount <= 1) {
        throw new CannotDeleteSuperAdminError();
      }
    }

    const deleted = await this.adminRepository.delete(id);
    if (deleted) {
      logger.info({ adminId: id }, 'Admin deleted successfully');
    }

    return deleted;
  }

  /**
   * Find admin by Telegram ID
   * @param telegramId - Telegram user ID
   * @returns Admin or null
   */
  async findByTelegramId(telegramId: string): Promise<AdminResponse | null> {
    const admin = await this.adminRepository.findByTelegramId(telegramId);
    return admin ? this.mapAdminToResponse(admin) : null;
  }
}
