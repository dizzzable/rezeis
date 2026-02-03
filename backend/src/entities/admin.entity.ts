/**
 * Admin role enum
 */
export type AdminRole = 'super_admin' | 'admin';

/**
 * Admin entity interface
 */
export interface Admin {
  id: string;
  telegramId: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  role: AdminRole;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Create admin DTO
 */
export type CreateAdminDTO = Omit<Admin, 'id' | 'createdAt' | 'updatedAt'>;

/**
 * Update admin DTO
 */
export type UpdateAdminDTO = Partial<Omit<Admin, 'id' | 'createdAt' | 'updatedAt'>>;

/**
 * Admin filters for pagination
 */
export interface AdminFilters {
  role?: AdminRole;
  isActive?: boolean;
  search?: string;
}
