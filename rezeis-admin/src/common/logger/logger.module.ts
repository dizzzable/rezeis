import { Global, Module } from '@nestjs/common';
import { WinstonModule } from 'nest-winston';
import * as winston from 'winston';
import { LoggerService } from './logger.service';
import { LOGGER_TOKEN } from './logger.constants';

const { combine, timestamp, json, printf, colorize } = winston.format;

// Console format for development
const consoleFormat = printf(({ level, message, timestamp, context, ...metadata }) => {
  const ctx = context ? `[${context}] ` : '';
  const meta = Object.keys(metadata).length ? JSON.stringify(metadata) : '';
  return `${timestamp} [${level}] ${ctx}${message} ${meta}`;
});

// Factory for logger instance
const loggerFactory = {
  provide: LOGGER_TOKEN,
  useFactory: () => {
    return winston.createLogger({
      transports: [
        // Console transport
        new winston.transports.Console({
          format: combine(
            colorize(),
            timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
            consoleFormat,
          ),
          level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
        }),
        // File transport for production
        ...(process.env.NODE_ENV === 'production'
          ? [
              new winston.transports.File({
                filename: 'logs/error.log',
                level: 'error',
                format: combine(timestamp(), json()),
              }),
              new winston.transports.File({
                filename: 'logs/combined.log',
                format: combine(timestamp(), json()),
              }),
            ]
          : []),
      ],
      defaultMeta: {
        service: 'rezeis-admin',
        environment: process.env.NODE_ENV || 'development',
      },
      exitOnError: false,
    });
  },
};

@Global()
@Module({
  imports: [
    WinstonModule.forRoot({
      transports: [
        new winston.transports.Console({
          format: combine(
            colorize(),
            timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
            consoleFormat,
          ),
          level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
        }),
      ],
      defaultMeta: {
        service: 'rezeis-admin',
        environment: process.env.NODE_ENV || 'development',
      },
      exitOnError: false,
    }),
  ],
  providers: [loggerFactory, LoggerService],
  exports: [LOGGER_TOKEN, LoggerService],
})
export class LoggerModule {}
