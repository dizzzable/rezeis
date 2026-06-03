import {
  BeforeApplicationShutdown,
  Injectable,
  Logger,
  OnApplicationShutdown,
} from '@nestjs/common';

const KNOWN_SHUTDOWN_SIGNALS = new Set<string>(['SIGINT', 'SIGTERM', 'SIGBREAK']);

export function normalizeShutdownSignal(signal: unknown): string {
  if (typeof signal !== 'string') return 'UNKNOWN';
  return KNOWN_SHUTDOWN_SIGNALS.has(signal) ? signal : 'UNKNOWN';
}

@Injectable()
export class AppLifecycleLogger implements BeforeApplicationShutdown, OnApplicationShutdown {
  private readonly logger = new Logger(AppLifecycleLogger.name);

  beforeApplicationShutdown(signal?: string): void {
    this.logger.log(`Application shutdown started; signal=${normalizeShutdownSignal(signal)}`);
  }

  onApplicationShutdown(signal?: string): void {
    this.logger.log(`Application shutdown completed; signal=${normalizeShutdownSignal(signal)}`);
  }
}
