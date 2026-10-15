import { Type } from 'class-transformer';
import { IsIn, IsInt } from 'class-validator';

import { DASHBOARD_PERIOD_MONTHS, type DashboardPeriodMonths } from '../interfaces/dashboard-summary.interface';

/**
 * `?months=` of `/admin/dashboard/period`: one of the dashboard's windows.
 * Anything else is a 400 — a free number would be a free scan of the tables.
 */
export class DashboardPeriodQueryDto {
  @Type(() => Number)
  @IsInt()
  @IsIn([...DASHBOARD_PERIOD_MONTHS])
  months!: DashboardPeriodMonths;
}
