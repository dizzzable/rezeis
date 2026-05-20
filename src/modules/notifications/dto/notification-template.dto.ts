import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

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
  @IsBoolean()
  public readonly isActive?: boolean;
}
