import { Currency } from '@prisma/client';
import { IsEnum, IsString, Matches, MaxLength } from 'class-validator';

export class AdminPlanPriceDto {
  @IsEnum(Currency)
  public currency!: Currency;

  @IsString()
  @MaxLength(32)
  @Matches(/^\d+(?:\.\d{1,8})?$/, {
    message: 'price must be a positive decimal string',
  })
  public price!: string;
}
