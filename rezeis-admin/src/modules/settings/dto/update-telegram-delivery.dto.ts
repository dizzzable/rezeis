import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';

/** Error-report generation modes (see ErrorReportsConfig). */
export const ERROR_REPORT_MODES = ['off', 'manual', 'auto'] as const;
export type ErrorReportMode = (typeof ERROR_REPORT_MODES)[number];

/** Event-selection delivery modes (which events reach Telegram). */
export const TELEGRAM_EVENTS_MODES = ['all', 'selected'] as const;
export type TelegramEventsMode = (typeof TELEGRAM_EVENTS_MODES)[number];

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
   * Optional forum topic that ALL ERROR-severity events route to, regardless
   * of their category. Lets error logs land in one dedicated thread. `null`
   * clears it (errors then follow normal category routing).
   */
  @IsOptional()
  @ValidateIf((_dto, value) => value !== null)
  @IsInt()
  public readonly errorTopicId?: number | null;

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

  /**
   * Error-report generation mode (independent of delivery routing):
   *   - `off`    — only the on-demand bulk export exists.
   *   - `manual` — per-error `.txt` is downloadable from the Events page.
   *   - `auto`   — the server also writes a `.txt` artifact for every new
   *                ERROR event into the on-disk archive.
   */
  @IsOptional()
  @IsIn(ERROR_REPORT_MODES)
  public readonly errorReportMode?: ErrorReportMode;

  /**
   * When true, ERROR events delivered to Telegram (operator chat, dev DM, or
   * dev-fallback) carry the formatted `.txt` report as an attached document.
   */
  @IsOptional()
  @IsBoolean()
  public readonly errorReportTelegramTxt?: boolean;

  /**
   * Event-selection mode. `all` (default) delivers every event to Telegram;
   * `selected` delivers only the event types listed in `events` — anything
   * else goes nowhere on Telegram (the panel still records it).
   */
  @IsOptional()
  @IsIn(TELEGRAM_EVENTS_MODES)
  public readonly eventsMode?: TelegramEventsMode;

  /**
   * Allow-list of event types delivered to Telegram when `eventsMode` is
   * `selected`. Ignored in `all` mode. Replaces the stored list wholesale.
   */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(128, { each: true })
  public readonly events?: string[];
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

  /**
   * Optional event category to test routing for (e.g. `FRAUD`, `SYSTEM`).
   * The test card is delivered to that category's topic so the operator can
   * verify a specific route. Defaults to `SYSTEM`.
   */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  public readonly category?: string;
}
