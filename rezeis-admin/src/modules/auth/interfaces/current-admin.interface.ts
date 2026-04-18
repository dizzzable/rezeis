import { UserRole } from '@prisma/client';

/**
 * Describes the authenticated admin profile exposed to controllers.
 */
export interface CurrentAdminInterface {
  readonly id: string;
  readonly login: string;
  readonly email: string | null;
  readonly name: string | null;
  readonly role: UserRole;
  readonly isActive: boolean;
  readonly tokenVersion: number;
  readonly createdAt: Date;
  readonly lastLoginAt: Date | null;
  readonly lastLoginIp: string | null;
}
