import { Type } from 'class-transformer';
import { IsBooleanString, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class ListReferralsQueryDto {
  @IsOptional()
  @IsString()
  public referrerId?: string;

  @IsOptional()
  @IsString()
  public referredId?: string;

  @IsOptional()
  @IsBooleanString()
  public qualified?: 'true' | 'false';

  @IsOptional()
  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  public limit?: number;

  @IsOptional()
  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(0)
  @Max(10_000)
  public offset?: number;
}

export class ListReferralInvitesQueryDto {
  @IsOptional()
  @IsString()
  public inviterId?: string;

  @IsOptional()
  @IsBooleanString()
  public consumed?: 'true' | 'false';

  @IsOptional()
  @IsBooleanString()
  public revoked?: 'true' | 'false';

  @IsOptional()
  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  public limit?: number;

  @IsOptional()
  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(0)
  @Max(10_000)
  public offset?: number;
}
