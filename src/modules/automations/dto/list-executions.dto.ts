import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';

/**
 * Query DTO for `GET /admin/automations/rules/:id/executions` and the
 * cross-rule equivalent. Cursor pagination keyed by row id ordered by
 * `createdAt DESC, id DESC`.
 */
export class ListExecutionsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @IsString()
  @Length(1, 64)
  cursor?: string;
}
