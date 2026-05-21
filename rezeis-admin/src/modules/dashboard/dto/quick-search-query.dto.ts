import { IsInt, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Validates input for the global admin Cmd+K quick-search overlay.
 *
 * The query is intentionally short: the frontend debounces user input and
 * we want to keep the database-side LIKE scans bounded. Limit is capped at
 * 25 to avoid runaway responses on broad queries like "a".
 */
export class QuickSearchQueryDto {
  @IsString()
  @MinLength(2, { message: 'Query must be at least 2 characters' })
  q!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(25)
  limit?: number;
}
