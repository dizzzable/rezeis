import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { BroadcastAudience } from '@prisma/client';

/**
 * «Подключение VPN»: people VERIFIED not connected, in ONE bucket — the two
 * are never mixed (the owner's «чтобы не смешивать»). Its own nested class so
 * the global `forbidNonWhitelisted` pipe refuses an unknown key inside it too.
 */
export class ConnectAudienceFilterDto {
  /** «Оплатил и не подключился» (`paid`) or «Пробный период или подарок — не подключился» (`trial`). */
  @IsIn(['paid', 'trial'])
  public bucket!: 'paid' | 'trial';

  /** «За последние, дней». */
  @IsInt()
  @Min(1)
  @Max(30)
  public withinDays!: number;

  /** «Не слать тем, кому уже помогли»; on when omitted. */
  @IsOptional()
  @IsBoolean()
  public excludeHelped?: boolean;
}

/**
 * Structured, multi-select audience filter. Every field is optional; unknown
 * values are dropped server-side by `normalizeAudienceFilter`, so validation
 * stays lenient (arrays of strings / a positive int). When present, this
 * supersedes the `audience` enum preset.
 */
export class AudienceFilterDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  public subscription?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  public planIds?: string[];

  @IsOptional()
  @IsInt()
  @Min(1)
  public inactiveDays?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  public platforms?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  public contact?: string[];

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type((): typeof ConnectAudienceFilterDto => ConnectAudienceFilterDto)
  public connect?: ConnectAudienceFilterDto;
}

export class BroadcastPayloadDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  public title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4096)
  public text?: string;

  @IsOptional()
  @IsIn(['none', 'photo', 'video'])
  public mediaType?: 'none' | 'photo' | 'video';

  @IsOptional()
  @IsString()
  @MaxLength(256)
  public mediaFileId?: string;

  @IsOptional()
  @IsIn(['HTML', 'MarkdownV2'])
  public parseMode?: 'HTML' | 'MarkdownV2';

  /**
   * Additive delivery channel: also email each resolved recipient who has an
   * email on file (best-effort; the app fanout — cabinet feed + web-push +
   * Telegram DM — always runs regardless).
   */
  @IsOptional()
  @IsBoolean()
  public emailEnabled?: boolean;

  /**
   * Additive delivery channel: also post the broadcast ONCE to this Telegram
   * channel/group (chat id like `-100…` or `@username`; the bot must already
   * be a member/admin). Empty/omitted → no channel post.
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  public telegramChannelChatId?: string;
}

export class CreateBroadcastDraftDto {
  @IsEnum(BroadcastAudience)
  public audience!: BroadcastAudience;

  @IsOptional()
  @IsString()
  public audiencePlanId?: string;

  /** Structured multi-select filter; supersedes `audience` when present. */
  @IsOptional()
  @ValidateNested()
  @Type((): typeof AudienceFilterDto => AudienceFilterDto)
  public audienceFilter?: AudienceFilterDto;

  /** Optional promo-code tag. Validated (exists + usable) on save. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  public promoCode?: string;

  @IsOptional()
  @ValidateNested()
  @Type((): typeof BroadcastPayloadDto => BroadcastPayloadDto)
  public payload?: BroadcastPayloadDto;
}

export class UpdateBroadcastDraftDto {
  @IsOptional()
  @IsEnum(BroadcastAudience)
  public audience?: BroadcastAudience;

  @IsOptional()
  @IsString()
  public audiencePlanId?: string;

  /** Structured multi-select filter; supersedes `audience` when present. */
  @IsOptional()
  @ValidateNested()
  @Type((): typeof AudienceFilterDto => AudienceFilterDto)
  public audienceFilter?: AudienceFilterDto;

  /**
   * Optional promo-code tag. An empty string clears the tag; a non-empty
   * value is validated (exists + usable) on save.
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  public promoCode?: string;

  @IsOptional()
  @ValidateNested()
  @Type((): typeof BroadcastPayloadDto => BroadcastPayloadDto)
  public payload?: BroadcastPayloadDto;
}

export class SendBroadcastDto {
  /** Optional delay in minutes for scheduled sends. */
  @IsOptional()
  @IsInt()
  @Min(1)
  public delayMinutes?: number;
}

export class EditBroadcastDto {
  @IsString()
  @MaxLength(4096)
  public text!: string;

  @IsOptional()
  @IsIn(['HTML', 'MarkdownV2'])
  public parseMode?: 'HTML' | 'MarkdownV2' | null;
}
