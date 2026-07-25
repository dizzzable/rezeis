import { IsInt, IsOptional, IsString, MaxLength, NotEquals } from 'class-validator';

/**
 * Signed partner-balance adjustment (minor units). `@IsInt` rejects
 * NaN / Infinity / non-integer / string payloads that would otherwise reach a
 * Prisma write and corrupt the stored balance (NaN slips past a naive `< 0`
 * guard). Zero is rejected as a no-op.
 */
export class AdjustUserPartnerBalanceDto {
  @IsInt({ message: 'amount must be an integer' })
  @NotEquals(0, { message: 'amount must not be zero' })
  public amount!: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  public reason?: string;
}
