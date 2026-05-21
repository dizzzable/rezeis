import { IsOptional, IsString, MaxLength } from 'class-validator';

export class ProcessPartnerWithdrawalDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  public adminComment?: string;
}
