import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

@Injectable()
export class ProxyCheckMiddleware implements NestMiddleware {
  private readonly logger = new Logger(ProxyCheckMiddleware.name);

  use(req: Request, res: Response, next: NextFunction): void {
    const isProd = process.env.NODE_ENV === 'production';
    if (!isProd) {
      next();
      return;
    }

    const isProxy = Boolean(req.headers['x-forwarded-for']);
    const isHttps = req.headers['x-forwarded-proto'] === 'https';

    if (!isProxy || !isHttps) {
      this.logger.error(
        `Direct connection rejected: x-forwarded-for=${req.headers['x-forwarded-for']}, proto=${req.headers['x-forwarded-proto']}`,
      );
      res.socket?.destroy();
      return;
    }

    next();
  }
}
