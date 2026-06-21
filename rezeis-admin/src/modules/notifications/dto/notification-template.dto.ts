import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

/**
 * One inline button attached to the rendered Telegram message of a
 * notification template. Mirrors `StoredNotificationButton` in
 * `utils/notification-template-locale.util.ts`. The `target` semantics
 * depend on `kind`:
 *   - `webApp`   → Mini App route, e.g. `/renew`
 *   - `url`      → absolute HTTPS URL
 *   - `callback` → callback id understood by the bot (e.g. `menu:main`)
 */
export class NotificationTemplateButtonDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  public readonly labelRu!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  public readonly labelEn?: string | null;

  @IsIn(['webApp', 'url', 'callback'])
  public readonly kind!: 'webApp' | 'url' | 'callback';

  @IsString()
  @MinLength(1)
  @MaxLength(2_000)
  public readonly target!: string;
}

/**
 * The frontend lets operators create new template slots ad-hoc, so we keep
 * the `type` column as a free-form ASCII slug. The regex blocks accidental
 * spaces / unicode and gives consumers a stable lookup key.
 */
export class CreateNotificationTemplateDto {
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  @Matches(/^[a-z0-9._-]+$/i, { message: 'type must be alphanumeric (._- allowed)' })
  public readonly type!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  public readonly title!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(8_000)
  public readonly body!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  public readonly titleEn?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(8_000)
  public readonly bodyEn?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => NotificationTemplateButtonDto)
  public readonly buttons?: NotificationTemplateButtonDto[];

  @IsOptional()
  @IsBoolean()
  public readonly isActive?: boolean;
}

export class UpdateNotificationTemplateDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  public readonly title?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(8_000)
  public readonly body?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  public readonly titleEn?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(8_000)
  public readonly bodyEn?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => NotificationTemplateButtonDto)
  public readonly buttons?: NotificationTemplateButtonDto[];

  @IsOptional()
  @IsBoolean()
  public readonly isActive?: boolean;
}
