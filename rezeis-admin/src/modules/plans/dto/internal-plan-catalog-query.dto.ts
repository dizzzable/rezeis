import { PurchaseChannel } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

export class InternalPlanCatalogQueryDto {
  @IsOptional()
  @IsEnum(PurchaseChannel)
  public channel?: PurchaseChannel;

  /**
   * Caller's rezeis user id (CUID — NOT a UUID). When provided, the catalog
   * is resolved per user context so context-scoped plans (NEW / EXISTING /
   * INVITED / paid TRIAL) are included. Optional — absence yields the
   * anonymous catalog (only `availability=ALL`).
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  public userId?: string;

  /**
   * Telegram id fallback (numeric string). Resolved to the rezeis user id
   * server-side when `userId` is absent — lets the bot/Mini App fetch a
   * context-aware catalog without first resolving the CUID.
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  public telegramId?: string;
}
