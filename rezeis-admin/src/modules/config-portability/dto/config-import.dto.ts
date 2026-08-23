import { Transform } from 'class-transformer';
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

  /**
   * Keep `webhooks.secret` in the exported file.
   *
   * Off by default. Promoting a config to a fresh environment legitimately
   * needs the receivers to keep validating signatures — that capability is
   * kept — but it was the DEFAULT, so every export of the webhooks section
   * shipped live signing secrets whether or not anyone wanted them, including
   * an export taken only to diff two environments.
   *
   * Query strings carry text, so the flag arrives as `'true'`. Transformed
   * explicitly rather than left to `@Type(() => Boolean)`, which coerces every
   * non-empty string — `'false'` included — to `true`.
   */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  public includeWebhookSecrets?: boolean;
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
