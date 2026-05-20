import { PurchaseChannel } from '@prisma/client';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';

export class InternalPlanCatalogQueryDto {
  @IsOptional()
  @IsEnum(PurchaseChannel)
  public channel?: PurchaseChannel;

  @IsOptional()
  @IsUUID('4')
  public userId?: string;
}
