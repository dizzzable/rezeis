import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  Validate,
} from 'class-validator';

import { loginPolicy } from '../../auth/utils/login-policy.util';
import { ExactlyOneUserIdentifierValidator } from '../validators/exactly-one-user-identifier.validator';

const EMAIL_LOOKUP_PATTERN: RegExp = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Accepts exactly one user identifier for internal user lookups.
 */
export class InternalUserSessionQueryDto {
  @IsOptional()
  @IsUUID()
  public readonly userId?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d+$/, { message: 'telegramId must be a valid integer string' })
  public readonly telegramId?: string;

  @IsOptional()
  @Transform(({ value }: { readonly value: unknown }) => normalizeLookupEmail(value))
  @IsString()
  @Matches(EMAIL_LOOKUP_PATTERN, { message: 'email must be a valid email address' })
  @MaxLength(320)
  public readonly email?: string;

  @IsOptional()
  @Transform(({ value }: { readonly value: unknown }) => normalizeLookupLogin(value))
  @IsString()
  @MinLength(loginPolicy.minLength)
  @MaxLength(loginPolicy.maxLength)
  @Matches(loginPolicy.pattern, { message: 'login must be a valid web-account login' })
  public readonly login?: string;

  @Validate(ExactlyOneUserIdentifierValidator)
  private readonly hasExactlyOneIdentifier?: boolean;
}

function normalizeLookupEmail(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  const trimmedValue = value.trim();
  return trimmedValue.length > 0 ? trimmedValue : undefined;
}

function normalizeLookupLogin(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  const sanitizedValue: string = loginPolicy.sanitizeLogin(value);
  return sanitizedValue.length > 0 ? sanitizedValue : undefined;
}
