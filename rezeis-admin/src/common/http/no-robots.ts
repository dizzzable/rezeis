import type { NextFunction, Request, Response } from 'express';

export const NO_ROBOTS_HEADER = 'X-Robots-Tag';
export const NO_ROBOTS_HEADER_VALUE = 'noindex, nofollow, noarchive';

export function noRobotsMiddleware(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader(NO_ROBOTS_HEADER, NO_ROBOTS_HEADER_VALUE);
  next();
}
