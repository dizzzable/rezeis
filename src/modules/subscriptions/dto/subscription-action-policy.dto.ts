import { PurchaseChannel } from '@prisma/client';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';

export class SubscriptionActionPolicyDto {
  @IsUUID('4')
  public userId!: string;

  @IsOptional()
  @IsUUID('4')
  public subscriptionId?: string;

  @IsOptional()
  @IsEnum(PurchaseChannel)
  public channel?: PurchaseChannel;
}
