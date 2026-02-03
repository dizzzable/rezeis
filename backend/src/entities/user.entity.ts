/**
 * User role enum
 */
export type UserRole = 'admin' | 'user';

/**
 * User entity interface
 */
export interface User {
  id: string;
  username: string;
  passwordHash?: string;
  telegramId?: string;
  firstName?: string;
  lastName?: string;
  photoUrl?: string;
  role: UserRole;
  isActive: boolean;
  lastLoginAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Create user DTO
 */
export type CreateUserDTO = Omit<User, 'id' | 'createdAt' | 'updatedAt'>;

/**
 * Update user DTO
 */
export type UpdateUserDTO = Partial<Omit<User, 'id' | 'createdAt' | 'updatedAt'>>;

/**
 * User filters for pagination
 */
export interface UserFilters {
  role?: UserRole;
  isActive?: boolean;
  search?: string;
}
