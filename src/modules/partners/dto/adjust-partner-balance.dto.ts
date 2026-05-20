import { IsInt, IsOptional, IsString, MaxLength, NotEquals } from 'class-validator';

/**
 * DTO for manual partner balance adjustment.
 *
 * `amount` is signed:
 *   - positive → credit (add to balance)
 *   - negative → debit (subtract from balance)
 *   - zero is rejected
 */
export class AdjustPartnerBalanceDto {
  @IsInt()
  @NotEquals(0, { message: 'Amount must not be zero' })
  public amount!: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  public reason?: string;
}
