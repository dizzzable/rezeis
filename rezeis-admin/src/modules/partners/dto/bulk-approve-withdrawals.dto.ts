import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * Body payload for `POST /admin/partners/withdrawals/bulk-approve`.
 *
 * Bounded list of withdrawal cuids that should be approved in one operator
 * action. Each id is processed independently — failures don't halt the
 * batch.
 */
export class BulkApproveWithdrawalsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsString({ each: true })
  public withdrawalIds!: string[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  public adminComment?: string;
}
