import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Request } from 'express';

import { AdminIpAllowlistService } from '../services/admin-ip-allowlist.service';

/**
 * Admin IP Allowlist guard. Wired as `APP_GUARD` so it runs before any
 * controller-level guard. Only matches requests whose URL path starts
 * with `/api/admin/`; the internal API and the user-facing `/api/internal`
 * paths are never subject to the allowlist.
 *
 * Fail-open behavior: on infra errors (DB unavailable etc.) we let the
 * request through. The same trade-off as `BlockedIpGuard` — operators
 * must be reachable during transient outages.
 */
@Injectable()
export class AdminIpAllowlistGuard implements CanActivate {
  public constructor(private readonly allowlistService: AdminIpAllowlistService) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const request: Request = context.switchToHttp().getRequest<Request>();
    const path = request.originalUrl ?? request.url ?? '';
    // Only enforce on admin endpoints.
    if (!path.startsWith('/api/admin/')) return true;

    const ipAddress = extractClientIp(request);
    if (!ipAddress) return true;

    try {
      const allowed = await this.allowlistService.isRequestAllowed(ipAddress);
      if (!allowed) {
        throw new ForbiddenException('Your IP is not allowed to access the admin panel');
      }
      return true;
    } catch (err) {
      if (err instanceof ForbiddenException) throw err;
      // Fail-open on infra errors.
      return true;
    }
  }
}

function extractClientIp(request: Request): string | null {
  if (typeof request.ip === 'string' && request.ip.length > 0) {
    return request.ip.replace(/^::ffff:/, '');
  }
  const remote = request.socket?.remoteAddress;
  if (typeof remote === 'string' && remote.length > 0) {
    return remote.replace(/^::ffff:/, '');
  }
  return null;
}
