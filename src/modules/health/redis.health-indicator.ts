import { Injectable } from '@nestjs/common';
import { HealthIndicator, HealthIndicatorResult, HealthCheckError } from '@nestjs/terminus';
import { RawCacheService } from '@/common/cache';

@Injectable()
export class RedisHealthIndicator extends HealthIndicator {
  constructor(private readonly cache: RawCacheService) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    try {
      await this.cache.set('health:ping', 'pong', 5);
      const value = await this.cache.get<string>('health:ping');
      if (value === 'pong') {
        return this.getStatus(key, true);
      }
      throw new Error('Redis ping failed');
    } catch (error) {
      throw new HealthCheckError('Redis check failed', this.getStatus(key, false, { message: (error as Error).message }));
    }
  }
}
