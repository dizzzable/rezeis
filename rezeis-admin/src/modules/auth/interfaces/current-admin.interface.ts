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
  /** Optional pointer to the custom RBAC role assigned to this admin. */
  readonly rbacRoleId: string | null;
  /**
   * `true` when the admin must rotate their password before any other
   * write operation. Login still issues a token, but every protected
   * endpoint behind the FPC guard will return 423 until the password is
   * rotated through `POST /admin/auth/password`.
   */
  readonly mustChangePassword: boolean;
}
