/**
 * Performance monitoring module
 * Tracks metrics for requests, cache, database queries, and system health
 */

import { getValkey } from '../config/redis.js';
import { getPool } from '../config/database.js';
import { logger } from '../utils/logger.js';

/**
 * Performance metrics data structure
 */
export interface PerformanceMetrics {
  /** Request duration histogram data */
  requestDurations: number[];
  /** Cache hit rate (0-1) */
  cacheHitRate: number;
  /** Active connections count */
  activeConnections: number;
  /** Database query times */
  databaseQueryTimes: number[];
  /** Error count */
  errorCount: number;
  /** Request count */
  requestCount: number;
}

/**
 * Health status for services
 */
export interface HealthStatus {
  status: 'healthy' | 'unhealthy' | 'degraded';
  timestamp: string;
  version: string;
  uptime: number;
  services: {
    database: 'connected' | 'disconnected';
    valkey: 'connected' | 'disconnected';
  };
  metrics: {
    memoryUsage: NodeJS.MemoryUsage;
    cpuUsage: NodeJS.CpuUsage;
    activeConnections: number;
    cacheHitRate: number;
  };
}



/**
 * Performance monitor class
 * Tracks and exposes performance metrics
 */
export class PerformanceMonitor {
  private readonly metrics: {
    requestCount: Map<string, number>;
    requestDuration: Map<string, number[]>;
    cacheHits: number;
    cacheMisses: number;
    dbQueryTimes: number[];
    errors: Map<string, number>;
    startTime: number;
  };

  private readonly maxSamples: number;

  constructor(maxSamples = 1000) {
    this.maxSamples = maxSamples;
    this.metrics = {
      requestCount: new Map(),
      requestDuration: new Map(),
      cacheHits: 0,
      cacheMisses: 0,
      dbQueryTimes: [],
      errors: new Map(),
      startTime: Date.now(),
    };
  }

  /**
   * Record a request
   * @param duration - Request duration in milliseconds
   * @param path - Request path
   * @param status - HTTP status code
   */
  recordRequest(duration: number, path: string, status: number): void {
    const statusCategory = `${Math.floor(status / 100)}xx`;
    const key = `${path}:${statusCategory}`;

    // Count requests
    const currentCount = this.metrics.requestCount.get(key) || 0;
    this.metrics.requestCount.set(key, currentCount + 1);

    // Track durations
    const durations = this.metrics.requestDuration.get(path) || [];
    durations.push(duration);
    if (durations.length > this.maxSamples) {
      durations.shift();
    }
    this.metrics.requestDuration.set(path, durations);

    // Track errors
    if (status >= 400) {
      const errorKey = `${status}`;
      const currentErrors = this.metrics.errors.get(errorKey) || 0;
      this.metrics.errors.set(errorKey, currentErrors + 1);
    }

    // Log slow requests
    if (duration > 1000) {
      logger.warn({ path, duration, status }, 'Slow request detected');
    }
  }

  /**
   * Record a cache hit
   */
  recordCacheHit(): void {
    this.metrics.cacheHits++;
  }

  /**
   * Record a cache miss
   */
  recordCacheMiss(): void {
    this.metrics.cacheMisses++;
  }

  /**
   * Record database query time
   * @param query - Query string or identifier
   * @param duration - Query duration in milliseconds
   */
  recordDBQuery(query: string, duration: number): void {
    this.metrics.dbQueryTimes.push(duration);
    if (this.metrics.dbQueryTimes.length > this.maxSamples) {
      this.metrics.dbQueryTimes.shift();
    }

    // Log slow queries
    if (duration > 500) {
      logger.warn({ query: query.substring(0, 100), duration }, 'Slow query detected');
    }
  }

  /**
   * Get current metrics
   * @returns Performance metrics
   */
  getMetrics(): PerformanceMetrics {
    const totalCache = this.metrics.cacheHits + this.metrics.cacheMisses;
    const cacheHitRate = totalCache > 0 ? this.metrics.cacheHits / totalCache : 0;

    const allDurations: number[] = [];
    for (const durations of this.metrics.requestDuration.values()) {
      allDurations.push(...durations);
    }

    let errorCount = 0;
    for (const count of this.metrics.errors.values()) {
      errorCount += count;
    }

    return {
      requestDurations: allDurations,
      cacheHitRate,
      activeConnections: this.getActiveConnections(),
      databaseQueryTimes: [...this.metrics.dbQueryTimes],
      errorCount,
      requestCount: this.getTotalRequestCount(),
    };
  }

  /**
   * Get active connections (approximate)
   * @returns Number of active connections
   */
  private getActiveConnections(): number {
    // This is a placeholder - in production you'd track actual connections
    return 0;
  }

  /**
   * Get total request count
   * @returns Total number of requests
   */
  private getTotalRequestCount(): number {
    let total = 0;
    for (const count of this.metrics.requestCount.values()) {
      total += count;
    }
    return total;
  }

  /**
   * Get health status
   * @returns Health status object
   */
  async getHealth(): Promise<HealthStatus> {
    const [dbHealthy, valkeyHealthy] = await Promise.all([
      this.checkDatabase(),
      this.checkValkey(),
    ]);

    const isHealthy = dbHealthy && valkeyHealthy;
    const metrics = this.getMetrics();

    return {
      status: isHealthy ? 'healthy' : 'unhealthy',
      timestamp: new Date().toISOString(),
      version: process.env.npm_package_version || '1.0.0',
      uptime: Date.now() - this.metrics.startTime,
      services: {
        database: dbHealthy ? 'connected' : 'disconnected',
        valkey: valkeyHealthy ? 'connected' : 'disconnected',
      },
      metrics: {
        memoryUsage: process.memoryUsage(),
        cpuUsage: process.cpuUsage(),
        activeConnections: metrics.activeConnections,
        cacheHitRate: metrics.cacheHitRate,
      },
    };
  }

  /**
   * Check database connection
   * @returns True if connected
   */
  private async checkDatabase(): Promise<boolean> {
    try {
      const pool = getPool();
      await pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check Valkey connection
   * @returns True if connected
   */
  private async checkValkey(): Promise<boolean> {
    try {
      const valkey = getValkey();
      // Use get on a test key to verify connection (ping not available in Valkey-Glide BaseClient)
      await valkey.get('__health_check__');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get Prometheus-formatted metrics
   * @returns Prometheus metrics string
   */
  async getPrometheusMetrics(): Promise<string> {
    const metrics = this.getMetrics();
    const lines: string[] = [];

    // Request count
    lines.push('# HELP http_requests_total Total HTTP requests');
    lines.push('# TYPE http_requests_total counter');
    for (const [key, count] of this.metrics.requestCount.entries()) {
      const [path, status] = key.split(':');
      lines.push(`http_requests_total{path="${path}",status="${status}"} ${count}`);
    }

    // Request duration histogram
    lines.push('# HELP http_request_duration_seconds HTTP request duration');
    lines.push('# TYPE http_request_duration_seconds histogram');
    const durations = metrics.requestDurations;
    const buckets = [0.1, 0.25, 0.5, 1, 2.5, 5, 10];
    for (const bucket of buckets) {
      const count = durations.filter(d => d <= bucket * 1000).length;
      lines.push(`http_request_duration_seconds_bucket{le="${bucket}"} ${count}`);
    }
    lines.push(`http_request_duration_seconds_sum ${durations.reduce((a, b) => a + b, 0) / 1000}`);
    lines.push(`http_request_duration_seconds_count ${durations.length}`);

    // Cache hit rate
    lines.push('# HELP cache_hit_rate Cache hit rate (0-1)');
    lines.push('# TYPE cache_hit_rate gauge');
    lines.push(`cache_hit_rate ${metrics.cacheHitRate}`);

    // Cache hits
    lines.push('# HELP cache_hits_total Total cache hits');
    lines.push('# TYPE cache_hits_total counter');
    lines.push(`cache_hits_total ${this.metrics.cacheHits}`);

    // Cache misses
    lines.push('# HELP cache_misses_total Total cache misses');
    lines.push('# TYPE cache_misses_total counter');
    lines.push(`cache_misses_total ${this.metrics.cacheMisses}`);

    // Database query time
    lines.push('# HELP db_query_duration_seconds Database query duration');
    lines.push('# TYPE db_query_duration_seconds histogram');
    const dbTimes = metrics.databaseQueryTimes;
    for (const bucket of buckets) {
      const count = dbTimes.filter(t => t <= bucket * 1000).length;
      lines.push(`db_query_duration_seconds_bucket{le="${bucket}"} ${count}`);
    }
    lines.push(`db_query_duration_seconds_sum ${dbTimes.reduce((a, b) => a + b, 0) / 1000}`);
    lines.push(`db_query_duration_seconds_count ${dbTimes.length}`);

    // Error count
    lines.push('# HELP http_errors_total Total HTTP errors');
    lines.push('# TYPE http_errors_total counter');
    for (const [code, count] of this.metrics.errors.entries()) {
      lines.push(`http_errors_total{code="${code}"} ${count}`);
    }

    // Memory usage
    const memUsage = process.memoryUsage();
    lines.push('# HELP process_memory_bytes Process memory usage in bytes');
    lines.push('# TYPE process_memory_bytes gauge');
    lines.push(`process_memory_bytes{type="rss"} ${memUsage.rss}`);
    lines.push(`process_memory_bytes{type="heapTotal"} ${memUsage.heapTotal}`);
    lines.push(`process_memory_bytes{type="heapUsed"} ${memUsage.heapUsed}`);
    lines.push(`process_memory_bytes{type="external"} ${memUsage.external}`);

    // Uptime
    lines.push('# HELP process_uptime_seconds Process uptime in seconds');
    lines.push('# TYPE process_uptime_seconds gauge');
    lines.push(`process_uptime_seconds ${(Date.now() - this.metrics.startTime) / 1000}`);

    return lines.join('\n') + '\n';
  }

  /**
   * Reset all metrics
   */
  reset(): void {
    this.metrics.requestCount.clear();
    this.metrics.requestDuration.clear();
    this.metrics.cacheHits = 0;
    this.metrics.cacheMisses = 0;
    this.metrics.dbQueryTimes = [];
    this.metrics.errors.clear();
    this.metrics.startTime = Date.now();
  }

  /**
   * Get request statistics for a path
   * @param path - Request path
   * @returns Statistics or null if no data
   */
  getPathStats(path: string): {
    count: number;
    avgDuration: number;
    p95Duration: number;
    p99Duration: number;
  } | null {
    const durations = this.metrics.requestDuration.get(path);
    if (!durations || durations.length === 0) {
      return null;
    }

    const sorted = [...durations].sort((a, b) => a - b);
    const count = sorted.length;
    const avgDuration = sorted.reduce((a, b) => a + b, 0) / count;
    const p95Duration = sorted[Math.floor(count * 0.95)];
    const p99Duration = sorted[Math.floor(count * 0.99)];

    return {
      count,
      avgDuration,
      p95Duration,
      p99Duration,
    };
  }
}

/**
 * Singleton performance monitor instance
 */
let monitorInstance: PerformanceMonitor | null = null;

/**
 * Get or create performance monitor instance
 * @returns PerformanceMonitor instance
 */
export function getPerformanceMonitor(): PerformanceMonitor {
  if (!monitorInstance) {
    monitorInstance = new PerformanceMonitor();
  }
  return monitorInstance;
}

/**
 * Reset performance monitor instance
 */
export function resetPerformanceMonitor(): void {
  monitorInstance = null;
}

/**
 * Middleware to track request metrics
 * @param monitor - Performance monitor instance
 * @returns Fastify preHandler hook
 */
export function createMetricsMiddleware(monitor: PerformanceMonitor) {
  return async (request: { url: string; method: string }, reply: { statusCode: number }): Promise<void> => {
    const startTime = Date.now();

    // Hook into response to capture timing
    reply.statusCode = reply.statusCode || 200;
    const duration = Date.now() - startTime;

    monitor.recordRequest(duration, request.url, reply.statusCode);
  };
}
