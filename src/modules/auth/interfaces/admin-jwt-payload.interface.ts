import { UserRole } from '@prisma/client';

/**
 * Describes the admin JWT payload.
 */
export interface AdminJwtPayloadInterface {
  readonly sub: string;
  readonly login: string;
  readonly role: UserRole;
  readonly tokenVersion: number;
  /**
   * Optional pointer to the custom RBAC role attached to the admin. When
   * `null` the admin still has the implicit permissions tied to the
   * legacy `role` enum (DEV → all, ADMIN → safe-write defaults).
   */
  readonly rbacRoleId?: string | null;
}
