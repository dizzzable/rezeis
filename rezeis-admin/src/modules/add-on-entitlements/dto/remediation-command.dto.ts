import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Body for a mutating remediation command (T-013). Every command carries a
 * mandatory human reason (audit) and a client command idempotency key so a
 * replayed request resolves to the same effect.
 */
export class RemediationCommandDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  public reason!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  public commandKey!: string;
}
