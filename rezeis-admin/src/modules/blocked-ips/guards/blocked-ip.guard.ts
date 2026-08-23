import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Request } from 'express';

import { appConfig } from '../../../common/config/app.config';
import { buildTrustedProxyValue } from '../../../common/http/trusted-proxy';
import { BlockedIpService } from '../services/blocked-ip.service';

/**
 * The one call we make into `proxy-addr` — the module Express itself uses to
 * answer `req.ip` (`express/lib/request.js:329`). Typed locally because the
 * package ships no declarations.
 */
type ProxyAddrFn = (
  request: {
    readonly headers: Record<string, unknown>;
    readonly socket: { readonly remoteAddress?: string };
  },
  trust: string | ((address: string, hop: number) => boolean),
) => string | undefined;

/** `proxy-addr` throws on a falsy trust argument; Express passes this instead. */
const TRUST_NO_PROXY = (): boolean => false;

/** The subset of a Socket.IO `Socket` an address can be read from. */
interface WsClientLike {
  readonly handshake?: {
    readonly address?: unknown;
    readonly headers?: unknown;
  };
  readonly conn?: { readonly remoteAddress?: unknown };
}

/**
 * Rejects requests originating from a blocked IP / CIDR. Apply at any
 * entrypoint that wants protection — for the admin panel we wire it as
 * the first guard on `AdminAuthController` so even login attempts are
 * blocked.
 *
 * The guard is allowed to fail-open on transient DB errors: refusing
 * every request when the cache fails to refresh would lock operators out
 * during a Postgres hiccup. The cache layer logs the error.
 *
 * NON-HTTP CONTEXTS. `BlockedIpsModule` is `@Global()` and exports this class
 * so any controller — or gateway — can `@UseGuards(BlockedIpGuard)`, so the
 * guard is handed whatever context that entrypoint runs in. It used to read
 * `request.socket.remoteAddress` unconditionally and OUTSIDE the try, which on
 * anything that is not an Express request is a `TypeError` thrown out of a
 * guard — the request dies, and it dies in a way no fail-open branch catches.
 * Its sibling `AdminIpAllowlistGuard` already used `request.socket?.` at the
 * same line; this file had simply drifted.
 *
 * The fix is to RESOLVE the address from whichever context arrives rather than
 * to allow or deny blind. Allowing blind is how the sibling defect happened —
 * a guard that decides "not my business" about traffic it does in fact guard —
 * and denying blind would make an unrecognised transport unreachable for a
 * blocklist that is empty in most installs. Where a client address exists we
 * derive it and ask honestly; only where the transport carries no client
 * address at all (RPC/microservice patterns) does the existing, documented
 * "no derivable IP" fail-open apply.
 *
 * The WS branch resolves through `proxy-addr` under the same `ADMIN_TRUST_PROXY`
 * value Express is given (`configure-http-runtime.ts`), so the guard's answer
 * does not depend on which surface asked it. Reading the raw peer address there
 * instead would look safe and be inert: behind the reverse proxy this panel
 * normally runs behind, every client would resolve to the proxy and no
 * per-client block would ever match.
 *
 * NOTE, measured: today nothing hands this guard a `ws` context. Nest does not
 * wire `APP_GUARD` into the WebSocket pipeline at all —
 * `SocketModule.getContextCreator()` builds `new GuardsContextCreator(container)`
 * without the `ApplicationConfig` (`@nestjs/websockets@11.1.23`), so
 * `getGlobalMetadata()` returns `[]` and no global guard runs on a gateway. The
 * realtime handshake is therefore gated inside `RealtimeGateway.handleConnection`
 * (`realtime.gateway.ts`), not here. This branch is what makes a future
 * `@UseGuards(BlockedIpGuard)` on a gateway work rather than crash.
 */
@Injectable()
export class BlockedIpGuard implements CanActivate {
  public constructor(
    private readonly blockedIpService: BlockedIpService,
    // @Optional() so the guard keeps working in a container that never loaded
    // `appConfig`; the fallback is `parseTrustedProxyMode`'s own default.
    @Optional()
    @Inject(appConfig.KEY)
    private readonly appConfiguration?: ConfigType<typeof appConfig>,
  ) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const ip = this.extractIp(context);
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

  private extractIp(context: ExecutionContext): string | null {
    const contextType: string = context.getType();
    if (contextType === 'ws') {
      return this.extractWsIp(context.switchToWs().getClient<WsClientLike>());
    }
    if (contextType !== 'http') {
      // No client address exists on this transport — the documented
      // "no derivable IP" fail-open, not a shrug about a context we guard.
      return null;
    }
    return extractHttpIp(context.switchToHttp().getRequest<Request>());
  }

  private extractWsIp(client: WsClientLike | undefined): string | null {
    const peer =
      readString(client?.handshake?.address) ?? readString(client?.conn?.remoteAddress);
    if (peer === null) return null;
    const headers = client?.handshake?.headers;
    const trustMode = buildTrustedProxyValue(this.appConfiguration?.trustProxy);
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const proxyAddr = require('proxy-addr') as ProxyAddrFn;
      const resolved = proxyAddr(
        {
          headers: (headers ?? {}) as Record<string, unknown>,
          socket: { remoteAddress: peer },
        },
        trustMode === false ? TRUST_NO_PROXY : trustMode,
      );
      return normalizeIp(readString(resolved) ?? peer);
    } catch {
      // Never let address resolution be the thing that throws out of a guard.
      return normalizeIp(peer);
    }
  }
}

function extractHttpIp(request: Request | undefined): string | null {
  // `req.ip` already honours `app.set('trust proxy', ...)` if set.
  const forwarded = readString(request?.ip);
  if (forwarded !== null) {
    // Strip IPv4-mapped IPv6 prefix that Node injects for v4 clients
    // (`::ffff:1.2.3.4` → `1.2.3.4`).
    return normalizeIp(forwarded);
  }
  // Optional-chained: an Express-shaped object without a live socket is not a
  // reason to throw out of a guard.
  const remote = readString(request?.socket?.remoteAddress);
  return remote === null ? null : normalizeIp(remote);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function normalizeIp(value: string): string | null {
  const normalized = value.replace(/^::ffff:/, '');
  return normalized.length > 0 ? normalized : null;
}
