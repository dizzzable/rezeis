/**
 * Daily statistics entity interface
 */
export interface DailyStatistics {
  id: string;
  date: Date;
  newUsers: number;
  activeUsers: number;
  newSubscriptions: number;
  revenue: number;
  createdAt: Date;
}

/**
 * Create daily statistics DTO
 */
export type CreateDailyStatisticsDTO = Omit<DailyStatistics, 'id' | 'createdAt'>;

/**
 * Update daily statistics DTO
 */
export type UpdateDailyStatisticsDTO = Partial<Omit<DailyStatistics, 'id' | 'createdAt'>>;
