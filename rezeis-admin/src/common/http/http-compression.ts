import type { NextFunction, Request, Response } from 'express';

export const HTTP_COMPRESSION_THRESHOLD_BYTES = 1024;

export interface HttpCompressionOptions {
  readonly threshold: typeof HTTP_COMPRESSION_THRESHOLD_BYTES;
}

export function buildHttpCompressionOptions(): HttpCompressionOptions {
  return { threshold: HTTP_COMPRESSION_THRESHOLD_BYTES };
}

export function createHttpCompressionMiddleware(): (req: Request, res: Response, next: NextFunction) => void {
  return function httpCompressionMiddleware(_req: Request, _res: Response, next: NextFunction): void {
    next();
  };
}
