import type { Pool } from 'pg';
import { StatisticsRepository } from '../../repositories/statistics.repository.js';
import { UserRepository } from '../../repositories/user.repository.js';
import { SubscriptionRepository } from '../../repositories/subscription.repository.js';

import type {
  DashboardStats,
  RevenueStats,
  UserStats,
  SubscriptionStats,
  DailyStatisticsResponse,
  DateRangeQuery,
} from './statistics.schemas.js';
import type { DailyStatistics } from '../../entities/statistics.entity.js';

/**
 * Statistics service configuration
 */
interface StatisticsServiceConfig {
  statisticsRepository: StatisticsRepository;
  userRepository: UserRepository;
  subscriptionRepository: SubscriptionRepository;
}

/**
 * Create statistics service factory
 * @param db - PostgreSQL pool instance
 * @returns Statistics service instance
 */
export function createStatisticsService(db: Pool): StatisticsService {
  const statisticsRepository = new StatisticsRepository(db);
  const userRepository = new UserRepository(db);
  const subscriptionRepository = new SubscriptionRepository(db);
  return new StatisticsService({ statisticsRepository, userRepository, subscriptionRepository });
}

/**
 * Statistics service class
 * Handles all statistics-related business logic
 */
class StatisticsService {
  private readonly statisticsRepository: StatisticsRepository;
  private readonly userRepository: UserRepository;
  private readonly subscriptionRepository: SubscriptionRepository;

  constructor(config: StatisticsServiceConfig) {
    this.statisticsRepository = config.statisticsRepository;
    this.userRepository = config.userRepository;
    this.subscriptionRepository = config.subscriptionRepository;
  }

  /**
   * Map DailyStatistics entity to DailyStatisticsResponse
   * @param stats - DailyStatistics entity
   * @returns DailyStatistics response object
   */
  private mapDailyStatsToResponse(stats: DailyStatistics): DailyStatisticsResponse {
    return {
      id: stats.id,
      date: stats.date.toISOString(),
      newUsers: stats.newUsers,
      activeUsers: stats.activeUsers,
      newSubscriptions: stats.newSubscriptions,
      revenue: stats.revenue,
      createdAt: stats.createdAt.toISOString(),
    };
  }

  /**
   * Get dashboard statistics
   * @returns Dashboard stats
   */
  async getDashboardStats(): Promise<DashboardStats> {
    const summary = await this.statisticsRepository.getDashboardSummary();
    return summary;
  }

  /**
   * Get revenue statistics
   * @param params - Date range query
   * @returns Revenue stats
   */
  async getRevenueStats(params: DateRangeQuery): Promise<RevenueStats> {
    const endDate = params.endDate ? new Date(params.endDate) : new Date();
    const startDate = params.startDate
      ? new Date(params.startDate)
      : new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000); // 30 days ago

    const totalRevenue = await this.statisticsRepository.getTotalRevenue();
    const periodRevenue = await this.subscriptionRepository.getRevenueByPeriod(startDate, endDate);

    // Calculate period days
    const periodDays = Math.max(1, Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)));
    const averageDailyRevenue = periodRevenue / periodDays;

    // Get previous period for growth rate calculation
    const previousPeriodStart = new Date(startDate.getTime() - (endDate.getTime() - startDate.getTime()));
    const previousPeriodRevenue = await this.subscriptionRepository.getRevenueByPeriod(previousPeriodStart, startDate);

    const growthRate = previousPeriodRevenue > 0
      ? ((periodRevenue - previousPeriodRevenue) / previousPeriodRevenue) * 100
      : 0;

    return {
      totalRevenue,
      periodRevenue,
      averageDailyRevenue,
      growthRate,
    };
  }

  /**
   * Get user statistics
   * @returns User stats
   */
  async getUserStats(): Promise<UserStats> {
    const totalUsers = await this.userRepository.count();
    const activeUsers = await this.userRepository.count({ isActive: true });
    const blockedUsers = await this.userRepository.count({ isActive: false });
    const newUsersThisMonth = await this.statisticsRepository.getNewUsersCount(30);

    // Calculate growth rate (compare with previous month)
    const newUsersPreviousMonth = await this.statisticsRepository.getNewUsersCount(60)
      - newUsersThisMonth;
    const growthRate = newUsersPreviousMonth > 0
      ? ((newUsersThisMonth - newUsersPreviousMonth) / newUsersPreviousMonth) * 100
      : 0;

    return {
      totalUsers,
      activeUsers,
      blockedUsers,
      newUsersThisMonth,
      growthRate,
    };
  }

  /**
   * Get subscription statistics
   * @returns Subscription stats
   */
  async getSubscriptionStats(): Promise<SubscriptionStats> {
    const totalSubscriptions = await this.subscriptionRepository.count();
    const activeSubscriptions = await this.subscriptionRepository.countByStatus('active');
    const expiredSubscriptions = await this.subscriptionRepository.countByStatus('expired');
    const cancelledSubscriptions = await this.subscriptionRepository.countByStatus('cancelled');
    const expiringSoon = (await this.subscriptionRepository.findExpiringSoon(7)).length;

    return {
      totalSubscriptions,
      activeSubscriptions,
      expiredSubscriptions,
      cancelledSubscriptions,
      expiringSoon,
    };
  }

  /**
   * Get daily statistics for a date range
   * @param params - Date range query
   * @returns Array of daily statistics
   */
  async getDailyStatistics(params: DateRangeQuery): Promise<DailyStatisticsResponse[]> {
    const endDate = params.endDate ? new Date(params.endDate) : new Date();
    const startDate = params.startDate
      ? new Date(params.startDate)
      : new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000); // 30 days ago

    const stats = await this.statisticsRepository.getStatsByPeriod(startDate, endDate);
    return stats.map((stat) => this.mapDailyStatsToResponse(stat));
  }
}
