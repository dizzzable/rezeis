import { Injectable, Scope } from '@nestjs/common';
import { Logger } from 'winston';
import { InjectLogger } from './logger.decorator';

@Injectable({ scope: Scope.TRANSIENT })
export class LoggerService {
  private context: string = '';
  private correlationId: string = '';

  constructor(@InjectLogger() private readonly logger: Logger) {}

  setContext(context: string): void {
    this.context = context;
  }

  setCorrelationId(correlationId: string): void {
    this.correlationId = correlationId;
  }

  private getMeta() {
    return {
      context: this.context,
      correlationId: this.correlationId,
    };
  }

  log(message: string, meta?: Record<string, unknown>): void {
    this.logger.info(message, { ...this.getMeta(), ...meta });
  }

  error(message: string, error?: Error, meta?: Record<string, unknown>): void {
    this.logger.error(message, {
      ...this.getMeta(),
      error: error
        ? {
            message: error.message,
            stack: error.stack,
            name: error.name,
          }
        : undefined,
      ...meta,
    });
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.logger.warn(message, { ...this.getMeta(), ...meta });
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.logger.debug(message, { ...this.getMeta(), ...meta });
  }

  verbose(message: string, meta?: Record<string, unknown>): void {
    this.logger.verbose(message, { ...this.getMeta(), ...meta });
  }
}
