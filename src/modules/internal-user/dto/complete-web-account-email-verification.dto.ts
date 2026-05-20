import { IsString, IsUUID, Matches } from 'class-validator';

const EMAIL_VERIFICATION_CODE_PATTERN: RegExp = /^\d{6}$/;

/**
 * Accepts the canonical user identifier and email verification code for the internal completion write path.
 */
export class CompleteWebAccountEmailVerificationDto {
  @IsUUID()
  public readonly userId!: string;

  @IsString()
  @Matches(EMAIL_VERIFICATION_CODE_PATTERN, {
    message: 'code must be a 6-digit numeric string',
  })
  public readonly code!: string;
}
