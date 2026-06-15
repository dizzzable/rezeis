import {
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';

/**
 * Patch payload for `PATCH /admin/settings/system-notifications/telegram`.
 *
 * Routes operator alerts to a single Telegram supergroup (or a private DM
 * with the bot). The optional `topics` map lets a workspace fan out events
 * by category (`USER`, `PAYMENT`, …) into different forum topics inside the
 * same chat. Setting a topic to `null` clears the routing for that
 * category.
 */
export class UpdateTelegramDeliveryDto {
  @IsOptional()
  @IsBoolean()
  public readonly enabled?: boolean;

  /** Telegram chat id — accepts negative IDs for groups; sent as a string. */
  @IsOptional()
  @ValidateIf((_dto, value) => value !== null)
  @IsString()
  @MaxLength(64)
  public readonly chatId?: string | null;

  /** Default forum topic id for events without a per-category override. */
  @IsOptional()
  @ValidateIf((_dto, value) => value !== null)
  @IsInt()
  public readonly topicId?: number | null;

  /**
   * Map of category → topic id. Categories not present in the patch keep
   * their existing values.
   */
  @IsOptional()
  @IsObject()
  public readonly topics?: Record<string, number | null>;

  /**
   * When true, user-facing notifications (subscription expiry, referral
   * rewards, partner earnings, …) are ALSO mirrored into this same chat
   * so the operator sees the exact pings users receive. Independent of
   * the per-user delivery — toggling this never changes what the user
   * gets in their DM / cabinet, only whether the operator chat gets a
   * copy.
   */
  @IsOptional()
  @IsBoolean()
  public readonly mirrorUserNotifications?: boolean;

  /**
   * Developer/operator personal chat id used as a fallback delivery target
   * when the primary delivery is disabled or has no `chatId`. Lets system
   * events still reach the operator's bot DM instead of being dropped.
   * Empty string / null clears it. Sent as a string (accepts negative IDs).
   */
  @IsOptional()
  @ValidateIf((_dto, value) => value !== null)
  @IsString()
  @MaxLength(64)
  public readonly devChatId?: string | null;
}

/**
 * Optional body for the `/test` endpoint — lets operators add a custom note
 * to the test alert that will land in the configured chat.
 */
export class SendTelegramDeliveryTestDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  public readonly note?: string;
}
