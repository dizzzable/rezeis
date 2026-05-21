import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Request } from 'express';

import { BlockedIpService } from '../services/blocked-ip.service';

/**
 * Rejects requests originating from a blocked IP / CIDR. Apply at any
 * entrypoint that wants protection — for the admin panel we wire it as
 * the first guard on `AdminAuthController` so even login attempts are
 * blocked.
 *
 * The guard is allowed to fail-open on transient DB errors: refusing
 * every request when the cache fails to refresh would lock operators out
 * during a Postgres hiccup. The cache layer logs the error.
 */
@Injectable()
export class BlockedIpGuard implements CanActivate {
  public constructor(private readonly blockedIpService: BlockedIpService) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const ip = extractIp(request);
    if (ip === null) return true;
    try {
      const result = await this.blockedIpService.isBlocked(ip);
      if (result.blocked) {
        throw new ForbiddenException('Access denied for your IP');
      }
      return true;
    } catch (err) {
      if (err instanceof ForbiddenException) throw err;
      // Fail-open on infra failures — a Postgres hiccup must never lock
      // every operator out of the panel.
      return true;
    }
  }
}

function extractIp(request: Request): string | null {
  // `req.ip` already honours `app.set('trust proxy', ...)` if set.
  if (typeof request.ip === 'string' && request.ip.length > 0) {
    // Strip IPv4-mapped IPv6 prefix that Node injects for v4 clients
    // (`::ffff:1.2.3.4` → `1.2.3.4`).
    return request.ip.replace(/^::ffff:/, '');
  }
  const remote = request.socket.remoteAddress;
  if (typeof remote === 'string') return remote.replace(/^::ffff:/, '');
  return null;
}
