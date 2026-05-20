import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Public-facing admin login payload accepted from the web client. The DTO uses
 * the field name `username` to match the existing UI without coupling the
 * storage column. The login policy is enforced inside the service so that we
 * can return a single bounded `Invalid username or password` response for any
 * shape of malformed input — preventing format-based enumeration.
 */
export class PublicLoginAdminDto {
  @Transform(({ value }: { readonly value: unknown }): unknown =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  public username!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  public password!: string;

  /**
   * Optional 6-digit TOTP code (or 10-char recovery code) supplied with
   * the login form when the admin has 2FA enabled. Empty / absent values
   * make the service respond with `totp_required` so the UI can show the
   * second-factor screen.
   */
  @IsOptional()
  @IsString()
  @MaxLength(20)
  public totpCode?: string;
}
