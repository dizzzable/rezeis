import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

import { REMNAWAVE_TIME_ZONE_MAX_LENGTH } from './remnawave-time-zone';

/**
 * «Доп. услуги» → «Настройки»: the switches the page sends, only the ones it
 * changes. A JSON body, so a boolean arrives as one; `@IsBoolean()` refuses the
 * string `"false"` outright instead of reading it as true — the trap
 * `@Type(() => Boolean)` sets on query parameters elsewhere in this codebase.
 */
export class UpdateAddOnSwitchesDto {
  /** «Новый учёт докупок» — stages 1 and 2. */
  @IsOptional()
  @IsBoolean()
  public readonly durableAccounting?: boolean;

  /** «Удалять лишние устройства автоматически» — stage 6. */
  @IsOptional()
  @IsBoolean()
  public readonly deviceCleanupAuto?: boolean;

  /** «Докупка трафика до сброса» — stage 4. */
  @IsOptional()
  @IsBoolean()
  public readonly trafficResetExpiry?: boolean;

  /**
   * The operator confirmed what switching OFF does not undo. Required for any
   * switch this request turns from ON to OFF; the page sends it from its dialog.
   */
  @IsOptional()
  @IsBoolean()
  public readonly confirmOff?: boolean;

  /**
   * «Часовой пояс Remnawave»: the IANA name of the zone Remnawave's scheduler
   * runs in (`TZ` in the Remnawave server's `.env`; UTC when it has none). An
   * empty string puts it back to UTC. The shape is checked here; whether this
   * runtime knows the zone, by the service (`ADD_ON_TIME_ZONE_INVALID`).
   */
  @IsOptional()
  @IsString()
  @MaxLength(REMNAWAVE_TIME_ZONE_MAX_LENGTH)
  public readonly remnawaveTimeZone?: string;
}
