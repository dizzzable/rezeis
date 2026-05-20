import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { BotButtonStyle } from '@prisma/client';

const BUTTON_STYLES: ReadonlyArray<BotButtonStyle> = [
  BotButtonStyle.PRIMARY,
  BotButtonStyle.SUCCESS,
  BotButtonStyle.DANGER,
  BotButtonStyle.DEFAULT,
];

/**
 * The frontend sends button styles in lower case (`primary`, `success`, …)
 * for friendliness. The DTO accepts either case and the controller upcases
 * before persisting.
 */
export class CreateBotButtonDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  public readonly buttonId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  public readonly label!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  public readonly style?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  public readonly iconCustomEmojiId?: string | null;

  @IsOptional()
  @IsBoolean()
  public readonly visible?: boolean;

  @IsOptional()
  @IsBoolean()
  public readonly onePerRow?: boolean;

  @IsOptional()
  @IsInt()
  public readonly orderIndex?: number;
}

export class UpdateBotButtonDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  public readonly label?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  public readonly style?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  public readonly iconCustomEmojiId?: string | null;

  @IsOptional()
  @IsBoolean()
  public readonly visible?: boolean;

  @IsOptional()
  @IsBoolean()
  public readonly onePerRow?: boolean;

  @IsOptional()
  @IsInt()
  public readonly orderIndex?: number;
}

export function parseBotButtonStyle(value: unknown): BotButtonStyle | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const normalised = value.toUpperCase();
  return BUTTON_STYLES.find((style) => style === normalised);
}

export class CreateBotEmojiDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  public readonly key!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(16)
  public readonly unicode!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  public readonly tgEmojiId?: string | null;
}

export class UpdateBotEmojiDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  public readonly key?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  public readonly unicode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  public readonly tgEmojiId?: string | null;
}

export class CreateBotTextDto {
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  public readonly key!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(8_000)
  public readonly value!: string;

  @IsOptional()
  @IsBoolean()
  public readonly visible?: boolean;
}

export class UpdateBotTextDto {
  @IsOptional()
  @IsString()
  @MaxLength(160)
  public readonly key?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8_000)
  public readonly value?: string;

  @IsOptional()
  @IsBoolean()
  public readonly visible?: boolean;
}
