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
