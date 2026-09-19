import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

import { CONNECT_HELP_LOG_MAX_PAGE } from '../connect-help.constants';
import { CONNECT_HELP_LOG_FILTERS, type ConnectHelpLogFilter } from '../connect-help.sql';

/**
 * `GET /admin/connect-help/log?cursor&outcome&limit`. `cursor` is the opaque
 * value the previous page returned; `outcome` one of the recorded outcomes, or
 * `in_flight` for decisions whose ladder has not finished.
 */
export class ConnectHelpLogQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  public readonly cursor?: string;

  @IsOptional()
  @IsIn([...CONNECT_HELP_LOG_FILTERS])
  public readonly outcome?: ConnectHelpLogFilter;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(CONNECT_HELP_LOG_MAX_PAGE)
  public readonly limit?: number;
}
