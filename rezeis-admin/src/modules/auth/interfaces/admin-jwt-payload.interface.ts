import { UserRole } from '@prisma/client';

/**
 * Describes the admin JWT payload.
 */
export interface AdminJwtPayloadInterface {
  readonly sub: string;
  readonly login: string;
  readonly role: UserRole;
  readonly tokenVersion: number;
}
