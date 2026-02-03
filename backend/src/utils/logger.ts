import { pino } from 'pino';
import { getEnv } from '../config/env.js';

/**
 * Create Pino logger instance
 * @returns Pino logger
 */
function createLogger() {
  const env = getEnv();
  const isDevelopment = env.NODE_ENV === 'development';

  return pino({
    level: isDevelopment ? 'debug' : 'info',
    transport: isDevelopment
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss Z',
            ignore: 'pid,hostname',
          },
        }
      : undefined,
  });
}

/**
 * Logger instance
 */
export const logger = createLogger();
