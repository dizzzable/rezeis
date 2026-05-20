import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
} from 'class-validator';

import { ALL_SECTIONS } from '../services/config-export.service';

export class ConfigExportQueryDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  public sections?: string[];
}

export class ConfigImportDto {
  /**
   * The full export payload. Strictly typed on the service side; the
   * DTO only checks that we received an object — the version/shape
   * validation happens inside `ConfigImportService.validatePayload()`.
   */
  @IsObject()
  public payload!: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  public sections?: string[];

  @IsIn(['skip', 'overwrite'])
  public strategy!: 'skip' | 'overwrite';

  @IsBoolean()
  public dryRun!: boolean;
}

/**
 * Whitelist used by the controller to validate the `sections` query
 * parameter. The value flows straight into the service so we keep the
 * canonical list in one place (the export service).
 */
export const ALL_SECTIONS_LITERAL = ALL_SECTIONS;
