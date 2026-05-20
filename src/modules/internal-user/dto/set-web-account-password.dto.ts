import { Transform } from 'class-transformer';
import { IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';

import { loginPolicy } from '../../auth/utils/login-policy.util';

/**
 * Accepts the canonical user identifier and replacement password for the internal web-account password handoff write path.
 */
export class SetWebAccountPasswordDto {
  @IsUUID()
  public readonly userId!: string;

  @Transform(({ value }: { readonly value: unknown }): unknown =>
    typeof value === 'string' ? loginPolicy.sanitizeLogin(value) : value,
  )
  @IsString()
  @MinLength(loginPolicy.minLength)
  @MaxLength(loginPolicy.maxLength)
  @Matches(loginPolicy.pattern)
  public readonly login!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  public readonly password!: string;
}
