import { IsEnum } from 'class-validator';

export const TrafficLimitStrategyValue = {
  NO_RESET: 'NO_RESET',
  DAY: 'DAY',
  WEEK: 'WEEK',
  MONTH: 'MONTH',
} as const;

export type TrafficLimitStrategyValue =
  (typeof TrafficLimitStrategyValue)[keyof typeof TrafficLimitStrategyValue];

export class TrafficLimitStrategyDto {
  @IsEnum(TrafficLimitStrategyValue)
  public trafficLimitStrategy!: TrafficLimitStrategyValue;
}
