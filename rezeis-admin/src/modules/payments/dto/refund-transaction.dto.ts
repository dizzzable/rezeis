import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/**
 * Operator-issued refund. Both fields optional: omitting `amount` refunds
 * everything still refundable, which is the common case (the panel pre-fills
 * the full amount and the operator just confirms).
 */
export class RefundTransactionDto {
  /**
   * Decimal amount as a string (e.g. `"499.00"`). Kept as a string so the value
   * is passed to the provider exactly as typed — floats would round.
   */
  @IsOptional()
  @IsString()
  @Matches(/^\d{1,10}(\.\d{1,2})?$/, {
    message: 'amount must be a positive decimal with up to 2 fraction digits',
  })
  public readonly amount?: string;

  /** Free-text note; forwarded to the provider and stored in the audit log. */
  @IsOptional()
  @IsString()
  @MaxLength(250)
  public readonly reason?: string;
}
