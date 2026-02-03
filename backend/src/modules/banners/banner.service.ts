import type { Pool } from 'pg';
import { BannerRepository } from '../../repositories/banner.repository.js';
import type { PaginatedResult } from '../../repositories/base.repository.js';
import { logger } from '../../utils/logger.js';
import type { Banner, CreateBannerDTO, UpdateBannerDTO, BannerFilters } from '../../entities/banner.entity.js';
import type { CreateBannerInput, UpdateBannerInput, BannerResponse } from './banner.schemas.js';

/**
 * Banner not found error
 */
export class BannerNotFoundError extends Error {
  constructor(bannerId: string) {
    super(`Banner with id ${bannerId} not found`);
    this.name = 'BannerNotFoundError';
  }
}

/**
 * Permission denied error
 */
export class PermissionDeniedError extends Error {
  constructor() {
    super('Only super admin or admin can manage banners');
    this.name = 'PermissionDeniedError';
  }
}

/**
 * Invalid banner data error
 */
export class InvalidBannerDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidBannerDataError';
  }
}

/**
 * Banner service configuration
 */
interface BannerServiceConfig {
  bannerRepository: BannerRepository;
}

/**
 * Create banner service factory
 * @param db - PostgreSQL pool instance
 * @returns Banner service instance
 */
export function createBannerService(db: Pool): BannerService {
  const bannerRepository = new BannerRepository(db);
  return new BannerService({ bannerRepository });
}

/**
 * Banner service class
 * Handles all banner-related business logic
 */
class BannerService {
  private readonly bannerRepository: BannerRepository;

  constructor(config: BannerServiceConfig) {
    this.bannerRepository = config.bannerRepository;
  }

  /**
   * Check if user is admin or super_admin
   * @param userRole - User role from JWT
   * @returns True if admin
   */
  private isAdmin(userRole: string): boolean {
    return userRole === 'super_admin' || userRole === 'admin';
  }

  /**
   * Verify admin permission
   * @param userRole - User role from JWT
   * @throws PermissionDeniedError if not admin
   */
  private verifyAdmin(userRole: string): void {
    if (!this.isAdmin(userRole)) {
      throw new PermissionDeniedError();
    }
  }

  /**
   * Map Banner entity to BannerResponse
   * @param banner - Banner entity
   * @returns Banner response object
   */
  private mapBannerToResponse(banner: Banner): BannerResponse {
    return {
      id: banner.id,
      title: banner.title,
      subtitle: banner.subtitle,
      imageUrl: banner.imageUrl,
      linkUrl: banner.linkUrl,
      position: banner.position,
      displayOrder: banner.displayOrder,
      isActive: banner.isActive,
      startsAt: banner.startsAt?.toISOString(),
      endsAt: banner.endsAt?.toISOString(),
      clickCount: banner.clickCount,
      impressionCount: banner.impressionCount,
      backgroundColor: banner.backgroundColor,
      textColor: banner.textColor,
      createdAt: banner.createdAt.toISOString(),
      updatedAt: banner.updatedAt.toISOString(),
    };
  }

  /**
   * Validate schedule dates
   * @param startsAt - Start date
   * @param endsAt - End date
   * @throws InvalidBannerDataError if dates are invalid
   */
  private validateScheduleDates(startsAt?: string, endsAt?: string): void {
    if (startsAt && endsAt) {
      const start = new Date(startsAt);
      const end = new Date(endsAt);
      if (start >= end) {
        throw new InvalidBannerDataError('Start date must be before end date');
      }
    }
  }

  /**
   * Get banners with pagination and filters
   * @param params - Query parameters
   * @param userRole - Current user role for authorization
   * @returns Paginated banners
   */
  async getBanners(
    params: { page: number; limit: number; position?: Banner['position']; isActive?: boolean },
    userRole: string
  ): Promise<PaginatedResult<BannerResponse>> {
    this.verifyAdmin(userRole);

    const filters: BannerFilters = {};
    if (params.position) {
      filters.position = params.position;
    }
    if (params.isActive !== undefined) {
      filters.isActive = params.isActive;
    }

    const result = await this.bannerRepository.getBannersWithPagination(
      params.page,
      params.limit,
      Object.keys(filters).length > 0 ? filters : undefined
    );

    return {
      data: result.data.map((banner) => this.mapBannerToResponse(banner)),
      total: result.total,
      page: result.page,
      limit: result.limit,
      totalPages: result.totalPages,
    };
  }

  /**
   * Get banner by ID
   * @param id - Banner ID
   * @param userRole - Current user role for authorization
   * @returns Banner or null
   */
  async getBannerById(id: string, userRole: string): Promise<BannerResponse | null> {
    this.verifyAdmin(userRole);

    const banner = await this.bannerRepository.findById(id);
    if (!banner) {
      return null;
    }

    return this.mapBannerToResponse(banner);
  }

  /**
   * Get active banners by position
   * Handles scheduling (starts_at, ends_at) in the repository query
   * @param position - Banner position
   * @returns Array of active banners
   */
  async getActiveBannersByPosition(position: Banner['position']): Promise<BannerResponse[]> {
    const banners = await this.bannerRepository.findActiveByPosition(position);
    return banners.map((banner) => this.mapBannerToResponse(banner));
  }

  /**
   * Get all active banners
   * Handles scheduling (starts_at, ends_at) in the repository query
   * @returns Array of active banners
   */
  async getAllActiveBanners(): Promise<BannerResponse[]> {
    const banners = await this.bannerRepository.findActive();
    return banners.map((banner) => this.mapBannerToResponse(banner));
  }

  /**
   * Create banner
   * @param data - Create banner data
   * @param userRole - Current user role for authorization
   * @returns Created banner
   */
  async createBanner(data: CreateBannerInput, userRole: string): Promise<BannerResponse> {
    this.verifyAdmin(userRole);

    // Validate schedule dates
    this.validateScheduleDates(data.startsAt, data.endsAt);

    const createData: CreateBannerDTO = {
      title: data.title,
      subtitle: data.subtitle,
      imageUrl: data.imageUrl,
      linkUrl: data.linkUrl,
      position: data.position,
      displayOrder: data.displayOrder,
      isActive: data.isActive,
      startsAt: data.startsAt ? new Date(data.startsAt) : undefined,
      endsAt: data.endsAt ? new Date(data.endsAt) : undefined,
      backgroundColor: data.backgroundColor,
      textColor: data.textColor,
    };

    const banner = await this.bannerRepository.create(createData);

    logger.info({ bannerId: banner.id }, 'Banner created successfully');

    return this.mapBannerToResponse(banner);
  }

  /**
   * Update banner
   * @param id - Banner ID
   * @param data - Update banner data
   * @param userRole - Current user role for authorization
   * @returns Updated banner
   */
  async updateBanner(id: string, data: UpdateBannerInput, userRole: string): Promise<BannerResponse> {
    this.verifyAdmin(userRole);

    const existing = await this.bannerRepository.findById(id);
    if (!existing) {
      throw new BannerNotFoundError(id);
    }

    // Validate schedule dates
    const startsAt = data.startsAt ?? existing.startsAt?.toISOString();
    const endsAt = data.endsAt ?? existing.endsAt?.toISOString();
    this.validateScheduleDates(startsAt, endsAt);

    const updateData: UpdateBannerDTO = {};
    if (data.title !== undefined) updateData.title = data.title;
    if (data.subtitle !== undefined) updateData.subtitle = data.subtitle;
    if (data.imageUrl !== undefined) updateData.imageUrl = data.imageUrl;
    if (data.linkUrl !== undefined) updateData.linkUrl = data.linkUrl;
    if (data.position !== undefined) updateData.position = data.position;
    if (data.displayOrder !== undefined) updateData.displayOrder = data.displayOrder;
    if (data.isActive !== undefined) updateData.isActive = data.isActive;
    if (data.startsAt !== undefined) updateData.startsAt = data.startsAt ? new Date(data.startsAt) : undefined;
    if (data.endsAt !== undefined) updateData.endsAt = data.endsAt ? new Date(data.endsAt) : undefined;
    if (data.backgroundColor !== undefined) updateData.backgroundColor = data.backgroundColor;
    if (data.textColor !== undefined) updateData.textColor = data.textColor;

    const banner = await this.bannerRepository.update(id, updateData);

    logger.info({ bannerId: id }, 'Banner updated successfully');

    return this.mapBannerToResponse(banner);
  }

  /**
   * Delete banner
   * @param id - Banner ID
   * @param userRole - Current user role for authorization
   */
  async deleteBanner(id: string, userRole: string): Promise<void> {
    this.verifyAdmin(userRole);

    const existing = await this.bannerRepository.findById(id);
    if (!existing) {
      throw new BannerNotFoundError(id);
    }

    await this.bannerRepository.delete(id);
    logger.info({ bannerId: id }, 'Banner deleted successfully');
  }

  /**
   * Increment banner click count
   * @param id - Banner ID
   * @returns Updated banner stats
   */
  async incrementClicks(id: string): Promise<{ bannerId: string; clickCount: number; impressionCount: number }> {
    const banner = await this.bannerRepository.incrementClicks(id);
    return {
      bannerId: banner.id,
      clickCount: banner.clickCount,
      impressionCount: banner.impressionCount,
    };
  }

  /**
   * Increment banner impression count
   * @param id - Banner ID
   * @returns Updated banner stats
   */
  async incrementImpressions(id: string): Promise<{ bannerId: string; clickCount: number; impressionCount: number }> {
    const banner = await this.bannerRepository.incrementImpressions(id);
    return {
      bannerId: banner.id,
      clickCount: banner.clickCount,
      impressionCount: banner.impressionCount,
    };
  }

  /**
   * Get banner statistics
   * @param id - Banner ID
   * @param userRole - Current user role for authorization
   * @returns Banner statistics
   */
  async getBannerStatistics(
    id: string,
    userRole: string
  ): Promise<{ bannerId: string; clickCount: number; impressionCount: number; ctr: number }> {
    this.verifyAdmin(userRole);

    const banner = await this.bannerRepository.findById(id);
    if (!banner) {
      throw new BannerNotFoundError(id);
    }

    const ctr = banner.impressionCount > 0 ? (banner.clickCount / banner.impressionCount) * 100 : 0;

    return {
      bannerId: banner.id,
      clickCount: banner.clickCount,
      impressionCount: banner.impressionCount,
      ctr: Math.round(ctr * 100) / 100,
    };
  }
}
