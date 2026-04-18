import { Transform } from 'class-transformer';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

import { loginPolicy } from '../utils/login-policy.util';

/**
 * Validates admin login credentials.
 */
export class LoginAdminDto {
  @Transform(({ value }: { readonly value: unknown }): unknown =>
    typeof value === 'string' ? loginPolicy.sanitizeLogin(value) : value,
  )
  @IsString()
  @MinLength(loginPolicy.minLength)
  @MaxLength(loginPolicy.maxLength)
  @Matches(loginPolicy.pattern)
  public login!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  public password!: string;
}
