import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { CORRELATION_ID_HEADER } from '../logger';
import { isSafeRequestId } from '../filters/filter-utils';

@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const incomingHeader = req.headers[CORRELATION_ID_HEADER];
    const incomingCorrelationId = Array.isArray(incomingHeader) ? incomingHeader[0] : incomingHeader;
    const correlationId = isSafeRequestId(incomingCorrelationId) ? incomingCorrelationId : randomUUID();

    req['correlationId'] = correlationId;
    res.setHeader(CORRELATION_ID_HEADER, correlationId);

    next();
  }
}
