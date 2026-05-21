import { Transform } from 'class-transformer';
import { IsEmail, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

import { loginPolicy } from '../utils/login-policy.util';

/**
 * Validates the public-facing first-admin registration payload. The endpoint
 * only accepts this payload when the admin table is still empty; subsequent
 * admins must be created through authenticated routes.
 *
 * Accepts `username` as an alias for `login` so the existing web client can
 * keep using its own field name without coupling to the storage column.
 */
export class RegisterAdminDto {
  @Transform(({ value }: { readonly value: unknown }): unknown =>
    typeof value === 'string' ? loginPolicy.sanitizeLogin(value) : value,
  )
  @IsString()
  @MinLength(loginPolicy.minLength)
  @MaxLength(loginPolicy.maxLength)
  @Matches(loginPolicy.pattern)
  public username!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  public password!: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  public email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  public name?: string;
}
