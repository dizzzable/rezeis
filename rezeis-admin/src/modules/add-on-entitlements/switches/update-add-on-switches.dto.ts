import { IsBoolean, IsOptional } from 'class-validator';

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
}
