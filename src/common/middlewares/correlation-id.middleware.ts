import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { CORRELATION_ID_HEADER } from '../logger';

@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const correlationId = req.headers[CORRELATION_ID_HEADER] || randomUUID();
    
    req['correlationId'] = correlationId;
    res.setHeader(CORRELATION_ID_HEADER, correlationId);
    
    next();
  }
}
