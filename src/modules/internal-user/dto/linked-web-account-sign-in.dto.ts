import { Transform } from 'class-transformer';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

import { loginPolicy } from '../../auth/utils/login-policy.util';

/**
 * Validates the internal linked web-account sign-in payload.
 */
export class LinkedWebAccountSignInDto {
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
