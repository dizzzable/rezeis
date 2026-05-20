import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/**
 * Snapshot of the appearance state captured by the frontend Zustand
 * store: preset id, custom CSS block, per-token overrides for light
 * and dark, and the radius slider value.
 *
 * Stored verbatim in the JSON column — the FE knows how to apply the
 * shape, so the backend just validates lightly and persists it.
 */
export class ThemeDataDto {
  @IsString()
  public readonly presetId!: string;

  @IsString()
  public readonly customCss!: string;

  @IsOptional()
  @IsObject()
  public readonly overridesLight?: Record<string, string>;

  @IsOptional()
  @IsObject()
  public readonly overridesDark?: Record<string, string>;

  @IsOptional()
  public readonly radius?: number;
}

export class SaveThemePresetDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  public readonly name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(280)
  public readonly description?: string;

  @IsOptional()
  @IsBoolean()
  public readonly isShared?: boolean;

  @ValidateNested()
  @Type(() => ThemeDataDto)
  public readonly themeData!: ThemeDataDto;
}

export class UpdateThemePresetDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  public readonly name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(280)
  public readonly description?: string;

  @IsOptional()
  @IsBoolean()
  public readonly isShared?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => ThemeDataDto)
  public readonly themeData?: ThemeDataDto;
}
