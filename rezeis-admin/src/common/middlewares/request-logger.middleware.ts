import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { sanitizePath } from '../filters/filter-utils';

@Injectable()
export class RequestLoggerMiddleware implements NestMiddleware {
  private readonly logger = new Logger(RequestLoggerMiddleware.name);

  use(req: Request, res: Response, next: NextFunction) {
    const start = Date.now();
    const correlationId = req['correlationId'] || 'no-id';

    res.on('finish', () => {
      const duration = Date.now() - start;
      const path = sanitizePath(req.originalUrl ?? req.url ?? '');
      const message = `${req.method} ${path} ${res.statusCode} - ${duration}ms`;

      const meta = {
        correlationId,
        method: req.method,
        url: path,
        statusCode: res.statusCode,
        duration,
        userAgent: req.headers['user-agent'],
        ip: req.ip,
      };

      if (res.statusCode >= 400) {
        this.logger.warn(message, meta);
      } else {
        this.logger.log(message, meta);
      }
    });

    next();
  }
}
