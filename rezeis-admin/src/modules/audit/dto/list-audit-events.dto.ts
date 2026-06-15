import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';

/**
 * Query DTO for `GET /admin/audit` (Audit v2).
 *
 * Cursor pagination keyed by row `id`. Sort order is fixed at
 * `(createdAt DESC, id DESC)` to keep the seek stable.
 */
export class ListAuditEventsV2QueryDto {
  /** Free-text search across `action`, `adminUsername`, `metadata` (JSON cast). */
  @IsOptional()
  @IsString()
  @Length(1, 128)
  q?: string;

  /** Filter by audit `kind` (`action` column). */
  @IsOptional()
  @IsString()
  @Length(1, 128)
  kind?: string;

  /** Filter by actor — either AdminUser id (cuid) or `system`. */
  @IsOptional()
  @IsString()
  @Length(1, 64)
  actorId?: string;

  /** Filter by target type stored in `metadata.targetType`. */
  @IsOptional()
  @IsString()
  @Length(1, 64)
  targetType?: string;

  /**
   * When `'true'`, restrict the result to system-event rows (those whose
   * `action` starts with `event.`) — i.e. the `SystemEventsService` feed,
   * as opposed to admin-action audit entries. Powers the "Системные
   * события" page.
   */
  @IsOptional()
  @IsString()
  @Length(1, 8)
  systemOnly?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  /** Cursor: `id` of the last seen row from the previous page. */
  @IsOptional()
  @IsString()
  @Length(1, 64)
  cursor?: string;
}
