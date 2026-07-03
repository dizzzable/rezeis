import { IsEnum } from 'class-validator';

export const TrafficLimitStrategyValue = {
  NO_RESET: 'NO_RESET',
  DAY: 'DAY',
  WEEK: 'WEEK',
  /** Reset on a fixed calendar day (Remnawave: 1st of each month, 00:00 UTC). */
  MONTH: 'MONTH',
  /**
   * Reset monthly on the anniversary of the profile's creation date rather than
   * a fixed calendar day (Remnawave `MONTH_ROLLING`). Matches "reset from the
   * purchase date" for multi-month subscriptions.
   */
  MONTH_ROLLING: 'MONTH_ROLLING',
} as const;

export type TrafficLimitStrategyValue =
  (typeof TrafficLimitStrategyValue)[keyof typeof TrafficLimitStrategyValue];

export class TrafficLimitStrategyDto {
  @IsEnum(TrafficLimitStrategyValue)
  public trafficLimitStrategy!: TrafficLimitStrategyValue;
}
