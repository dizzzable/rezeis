import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Body for `POST /admin/notifications/channels`.
 *
 * `chatId` accepts the format Telegram exposes via `getChat` — a
 * negative integer for groups / supergroups (`-100xxxxxxxxx` for
 * channels), positive for users / bots. We store it as a string so
 * it round-trips cleanly through JSON without bigint precision
 * concerns.
 *
 * `kindFilter` is a flat list of event-type slugs (`subscription.expired`,
 * `partner.earning`, ...). Empty means "deliver every kind". `name` is
 * operator-facing label, never sent to Telegram.
 */
export class CreateBotNotificationChannelDto {
  @IsString()
  @Length(1, 120)
  public readonly name!: string;

  @IsString()
  @Matches(/^-?\d{1,32}$/, { message: 'chatId must be a positive or negative integer string' })
  public readonly chatId!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  public readonly topicThreadId?: number | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(64)
  @IsString({ each: true })
  public readonly kindFilter?: string[];

  @IsOptional()
  @IsBoolean()
  public readonly isActive?: boolean;
}

export class UpdateBotNotificationChannelDto {
  @IsOptional()
  @IsString()
  @Length(1, 120)
  public readonly name?: string;

  @IsOptional()
  @IsString()
  @Matches(/^-?\d{1,32}$/, { message: 'chatId must be a positive or negative integer string' })
  public readonly chatId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  public readonly topicThreadId?: number | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(64)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  public readonly kindFilter?: string[];

  @IsOptional()
  @IsBoolean()
  public readonly isActive?: boolean;
}
