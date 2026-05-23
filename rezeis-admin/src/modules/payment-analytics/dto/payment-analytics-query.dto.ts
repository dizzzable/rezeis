import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Time window selector for the payment-analytics endpoints. Mirrors the
 * `AnalyticsWindowQueryDto` used by business-analytics so the URLs feel
 * consistent across the admin tools.
 */
export class PaymentAnalyticsWindowQueryDto {
  /**
   * Number of days to include in the window (defaults applied per
   * endpoint). Clamped server-side to [1, 365] to keep aggregate queries
   * bounded.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  public days?: number;
}
