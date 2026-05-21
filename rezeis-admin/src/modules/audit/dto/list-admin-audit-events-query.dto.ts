import { Type } from 'class-transformer';
import { IsInt, IsISO8601, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * Query parameters accepted by `GET /admin/audit/events`.
 */
export class ListAdminAuditEventsQueryDto {
  @IsOptional()
  @IsString()
  public action?: string;

  @IsOptional()
  @IsString()
  public adminUserId?: string;

  @IsOptional()
  @IsISO8601()
  public from?: string;

  @IsOptional()
  @IsISO8601()
  public to?: string;

  @IsOptional()
  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  public limit?: number;

  @IsOptional()
  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(0)
  @Max(10_000)
  public offset?: number;
}
