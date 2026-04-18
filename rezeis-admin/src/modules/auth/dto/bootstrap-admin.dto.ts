import { Transform } from 'class-transformer';
import { IsEmail, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

import { loginPolicy } from '../utils/login-policy.util';

/**
 * Validates the initial DEV admin bootstrap payload.
 */
export class BootstrapAdminDto {
  @Transform(({ value }: { readonly value: unknown }): unknown =>
    typeof value === 'string' ? loginPolicy.sanitizeLogin(value) : value,
  )
  @IsString()
  @MinLength(loginPolicy.minLength)
  @MaxLength(loginPolicy.maxLength)
  @Matches(loginPolicy.pattern)
  public login!: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  public email?: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  public password!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  public name?: string;
}
