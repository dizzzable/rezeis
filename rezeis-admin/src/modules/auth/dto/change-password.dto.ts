import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Body for `POST /admin/auth/password`. Used by the standard "change my
 * password" flow inside the panel and by the force-password-change screen
 * shown when `mustChangePassword=true` on the authenticated admin.
 */
export class ChangeAdminPasswordDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  public currentPassword!: string;

  /**
   * New password. The string is checked against a basic length policy
   * here; richer entropy rules (mixed case, digits, etc.) live in
   * `LoginPolicyUtil` and are applied by the service.
   */
  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  @MaxLength(128)
  public newPassword!: string;
}
