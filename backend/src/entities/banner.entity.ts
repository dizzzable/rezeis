/**
 * Banner position enum
 */
export type BannerPosition = 'home_top' | 'home_bottom' | 'plans_page' | 'sidebar';

/**
 * Banner entity interface
 */
export interface Banner {
  id: string;
  title: string;
  subtitle?: string;
  imageUrl: string;
  linkUrl?: string;
  position: BannerPosition;
  displayOrder: number;
  isActive: boolean;
  startsAt?: Date;
  endsAt?: Date;
  clickCount: number;
  impressionCount: number;
  backgroundColor?: string;
  textColor?: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Create banner DTO
 */
export type CreateBannerDTO = Omit<
  Banner,
  'id' | 'createdAt' | 'updatedAt' | 'clickCount' | 'impressionCount'
>;

/**
 * Update banner DTO
 */
export type UpdateBannerDTO = Partial<Omit<Banner, 'id' | 'createdAt' | 'updatedAt'>>;

/**
 * Banner filters for pagination
 */
export interface BannerFilters {
  position?: BannerPosition;
  isActive?: boolean;
  startDate?: Date;
  endDate?: Date;
}

/**
 * Banner statistics
 */
export interface BannerStatistics {
  bannerId: string;
  clickCount: number;
  impressionCount: number;
  ctr: number; // Click-through rate
}
