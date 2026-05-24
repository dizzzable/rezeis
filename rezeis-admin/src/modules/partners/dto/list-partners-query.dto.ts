import { Type } from 'class-transformer';
import {
  IsBooleanString,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { WithdrawalStatus } from '@prisma/client';

const PARTNER_SORTABLE_COLUMNS = [
  'totalEarned',
  'balance',
  'totalWithdrawn',
  'createdAt',
  'updatedAt',
] as const;
type PartnerSortColumn = (typeof PARTNER_SORTABLE_COLUMNS)[number];

export class ListPartnersQueryDto {
  @IsOptional()
  @IsBooleanString()
  public isActive?: 'true' | 'false';

  /** Free-text search over user name / username / telegramId. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  public search?: string;

  @IsOptional()
  @IsIn(PARTNER_SORTABLE_COLUMNS as unknown as readonly string[])
  public sort?: PartnerSortColumn;

  @IsOptional()
  @IsIn(['asc', 'desc'] as const)
  public order?: 'asc' | 'desc';

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

export class ListPartnerWithdrawalsQueryDto {
  @IsOptional()
  @IsString()
  public partnerId?: string;

  @IsOptional()
  @IsEnum(WithdrawalStatus)
  public status?: WithdrawalStatus;

  /** Free-text search over partner user. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  public search?: string;

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
