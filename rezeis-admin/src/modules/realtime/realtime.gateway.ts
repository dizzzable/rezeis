import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';

import type { UserRole } from '@prisma/client';

import { appConfig } from '../../common/config/app.config';
import { authConfig } from '../../common/config/auth.config';
import { buildTrustedProxyValue } from '../../common/http/trusted-proxy';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AdminJwtPayloadInterface } from '../auth/interfaces/admin-jwt-payload.interface';
import { RbacService } from '../rbac/services/rbac.service';
import {
  REALTIME_CLOSE,
  REALTIME_EVENT,
  REALTIME_HEARTBEAT_INTERVAL_MS,
  REALTIME_NAMESPACE,
  REALTIME_READY,
  REALTIME_SUBSCRIBE,
  REALTIME_UNSUBSCRIBE,
} from './realtime.constants';
import {
  REALTIME_TOPICS,
  REALTIME_TOPIC_PERMISSION,
  RealtimeEventInterface,
  RealtimeTopic,
} from './interfaces/realtime-event.interface';

type BlockedIpServiceLike =
  import('../blocked-ips/services/blocked-ip.service').BlockedIpService;
type AdminIpAllowlistServiceLike =
  import('../two-factor/services/admin-ip-allowlist.service').AdminIpAllowlistService;

/**
 * The one call we make into `proxy-addr` — the module Express itself uses to
 * answer `req.ip` (`express/lib/request.js:329`). Typed locally because the
 * package ships no declarations; borrowed rather than reimplemented so the
 * handshake and the HTTP guards cannot disagree about who the client is.
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

interface AuthenticatedSocket extends Socket {
  data: {
    adminId: string;
    login: string;
    tokenVersion: number;
    /** Topics the client has explicitly subscribed to (⊆ allowedTopics). */
    topics: Set<RealtimeTopic>;
    /** Topics this admin is permitted to receive, resolved from RBAC at connect. */
    allowedTopics: Set<RealtimeTopic>;
  };
}

/**
 * Authenticated Socket.IO gateway for admin realtime updates.
 *
 * Authentication
 *   The client must present an admin JWT either via the `Authorization`
 *   header (`Bearer <token>`) or — preferred for browser clients — the
 *   `auth.token` field on the Socket.IO handshake.
 *
 *   We validate the JWT signature, check the admin still exists, is active
 *   and has the expected `tokenVersion`. Mismatches close the socket with
 *   typed application-level close codes (4001-4003) so the frontend can
 *   decide whether to refresh its token or fall back to a hard logout.
 *
 * Subscription model
 *   On connect, the client receives a `ready` packet listing the available
 *   topics. The client then sends `subscribe` with a list of topic names
 *   to opt-in. Events are pushed only to sockets that have subscribed.
 *
 *   This is intentionally simpler than the remnawave variant: we do not
 *   need per-resource scoping yet (RBAC scope-policies arrive in Phase 2).
 *
 * Connection model
 *   One process keeps an in-memory map of authenticated sockets. The
 *   gateway is also exposed via `broadcast()` so `SystemEventsService` can
 *   push without coupling to the gateway constructor surface.
 */
@Injectable()
@WebSocketGateway({
  namespace: REALTIME_NAMESPACE,
  // The frontend connects to `/api/socket.io` because the rest of the
  // SPA hits `/api/*` for everything (Nest's `setGlobalPrefix('api')`
  // applies to HTTP routes but NOT to Socket.IO's transport path).
  // Aligning the path here lets the same reverse proxy (and the
  // built-in dev server) route both REST and WebSocket traffic through
  // a single `/api` prefix.
  path: '/api/socket.io',
  // CORS is applied centrally by `AdminIoAdapter` (main.ts) from the
  // validated `ADMIN_CORS_ORIGINS` allowlist — the same trusted origins as
  // the HTTP server. Do not hardcode `origin: true` here (would reopen the
  // gateway to all origins).
})
export class RealtimeGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  @WebSocketServer()
  private server!: Server;

  private readonly logger = new Logger(RealtimeGateway.name);

  /** Socket.id → adminId for fast lookups when broadcasting. */
  private readonly sockets = new Map<string, AuthenticatedSocket>();

  /** Heartbeat timer; cleaned up on shutdown. */
  private heartbeatTimer: NodeJS.Timeout | null = null;

  public constructor(
    private readonly jwtService: JwtService,
    private readonly prismaService: PrismaService,
    @Inject(authConfig.KEY)
    private readonly authConfiguration: ConfigType<typeof authConfig>,
    private readonly rbacService: RbacService,
    // Both trailing dependencies are @Optional() on purpose. The gateway is
    // constructed directly in specs with four arguments, and it must keep
    // working in a container where the app config or the IP stores are absent
    // (worker runtime) rather than refusing to start.
    @Optional()
    @Inject(appConfig.KEY)
    private readonly appConfiguration?: ConfigType<typeof appConfig>,
    @Optional()
    private readonly moduleRef?: ModuleRef,
  ) {}

  /** Lazily-resolved IP stores; see `resolveIpStores()` for why. */
  private blockedIpService: BlockedIpServiceLike | null = null;
  private allowlistService: AdminIpAllowlistServiceLike | null = null;
  private ipStoresResolved = false;

  // ── Lifecycle ──────────────────────────────────────────────────────────

  public afterInit(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      const count = this.sockets.size;
      if (count > 0) {
        this.logger.debug(`Realtime heartbeat: ${count} connected admin(s)`);
      }
    }, REALTIME_HEARTBEAT_INTERVAL_MS);
  }

  public onModuleDestroy(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ── Connection ─────────────────────────────────────────────────────────

  public async handleConnection(client: Socket): Promise<void> {
    // Address gate BEFORE the token, mirroring the ordering the HTTP side
    // already chose for the same two lists (`app.module.ts`: the allowlist
    // guard "sits BEFORE the JWT guard so we never even consult the auth
    // store for off-list traffic").
    const refusal = await this.refuseByAddress(client);
    if (refusal) {
      this.deny(client, REALTIME_CLOSE.AUTH_FAILURE, refusal);
      return;
    }

    const token = this.extractToken(client);
    if (!token) {
      this.deny(client, REALTIME_CLOSE.AUTH_FAILURE, 'missing_token');
      return;
    }

    let payload: AdminJwtPayloadInterface;
    try {
      payload = await this.jwtService.verifyAsync<AdminJwtPayloadInterface>(token, {
        secret: this.authConfiguration.jwtSecret,
      });
    } catch {
      this.deny(client, REALTIME_CLOSE.AUTH_FAILURE, 'invalid_token');
      return;
    }

    const admin = await this.prismaService.adminUser.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        login: true,
        isActive: true,
        tokenVersion: true,
        role: true,
        rbacRoleId: true,
      },
    });
    if (!admin) {
      this.deny(client, REALTIME_CLOSE.AUTH_FAILURE, 'admin_not_found');
      return;
    }
    if (!admin.isActive) {
      this.deny(client, REALTIME_CLOSE.ADMIN_INACTIVE, 'admin_inactive');
      return;
    }
    if (admin.tokenVersion !== payload.tokenVersion) {
      this.deny(
        client,
        REALTIME_CLOSE.TOKEN_VERSION_MISMATCH,
        'token_version_mismatch',
      );
      return;
    }

    const allowedTopics = await this.resolveAllowedTopics({
      id: admin.id,
      role: admin.role,
      rbacRoleId: admin.rbacRoleId,
    });

    const authed = client as AuthenticatedSocket;
    authed.data = {
      adminId: admin.id,
      login: admin.login,
      tokenVersion: admin.tokenVersion,
      topics: new Set<RealtimeTopic>(),
      allowedTopics,
    };
    this.sockets.set(authed.id, authed);

    // Advertise only the topics this admin may actually receive so the SPA
    // never renders subscribe controls for events it will never be sent.
    authed.emit(REALTIME_READY, {
      adminId: admin.id,
      topics: Array.from(allowedTopics),
    });

    this.logger.debug(
      `Realtime connect: admin=${admin.login} (${admin.id}) socket=${authed.id}`,
    );
  }

  public handleDisconnect(client: Socket): void {
    const removed = this.sockets.delete(client.id);
    if (removed) {
      this.logger.debug(`Realtime disconnect: socket=${client.id}`);
    }
  }

  // ── Subscriptions ──────────────────────────────────────────────────────

  @SubscribeMessage(REALTIME_SUBSCRIBE)
  public handleSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: unknown,
  ): { ok: boolean; topics: RealtimeTopic[] } {
    const authed = this.sockets.get(client.id);
    if (!authed) return { ok: false, topics: [] };
    const requested = this.parseTopics(payload);
    // RBAC gate: silently drop topics the admin isn't permitted to receive so
    // a crafted `subscribe` frame can't opt a restricted operator into
    // money/fraud/partner streams they can't view in the panel.
    requested
      .filter((t) => authed.data.allowedTopics.has(t))
      .forEach((t) => authed.data.topics.add(t));
    return { ok: true, topics: Array.from(authed.data.topics) };
  }

  @SubscribeMessage(REALTIME_UNSUBSCRIBE)
  public handleUnsubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: unknown,
  ): { ok: boolean; topics: RealtimeTopic[] } {
    const authed = this.sockets.get(client.id);
    if (!authed) return { ok: false, topics: [] };
    const requested = this.parseTopics(payload);
    requested.forEach((t) => authed.data.topics.delete(t));
    return { ok: true, topics: Array.from(authed.data.topics) };
  }

  // ── Broadcasting (called by SystemEventsService) ───────────────────────

  /**
   * Push a single event to every socket whose subscription set covers the
   * event's category. Sockets with an empty subscription set receive
   * everything — this is the "subscribe-to-all" default chosen because the
   * admin panel currently shows global counters that benefit from any
   * change.
   */
  public broadcast(event: RealtimeEventInterface): void {
    if (this.sockets.size === 0) return;
    const category = event.category as RealtimeTopic;
    for (const socket of this.sockets.values()) {
      const { topics, allowedTopics } = socket.data;
      // Hard RBAC gate first: never emit a category the admin cannot view,
      // regardless of what they (or a spoofed subscribe) asked for.
      if (!allowedTopics.has(category)) {
        continue;
      }
      // Empty explicit subscription = "all topics I'm allowed to see" (the
      // panel's default global-counter view), otherwise honour the opt-in set.
      if (topics.size === 0 || topics.has(category)) {
        socket.emit(REALTIME_EVENT, event);
      }
    }
  }

  /**
   * Forcefully drop every socket bound to an admin.
   *
   * WHAT THIS ACTUALLY COSTS THE OPERATOR — measured in the SPA, because this
   * docblock used to claim something else. It said "the frontend reconnects with
   * the latest token, at which point handshake validation either succeeds or
   * kicks the user out cleanly". Neither half happens:
   *
   *   - `deny()` closes with `REALTIME_CLOSE.TOKEN_VERSION_MISMATCH` (4003) for
   *     every reason string, and `web/src/lib/realtime/use-realtime-updates.ts`
   *     treats 4001/4002/4003 alike: `forceEndAdminSession(queryClient)`, which
   *     clears client session state and hard-navigates to `/sign-in`
   *     (`web/src/lib/admin-session.ts:52-59`). So this is a FORCED SIGN-OUT in
   *     every tab that admin has open, not a reconnect.
   *   - even without the error frame it would not reconnect: a server-side
   *     `socket.disconnect()` surfaces to the client as `io server disconnect`,
   *     which Socket.IO deliberately does not retry.
   *
   * Treat every call as "sign this admin out", and weigh it as that. There is no
   * close code for "re-resolve your permissions, stay signed in" — adding one
   * means a new value in `realtime.constants.ts` AND a branch in the SPA handler
   * above, neither of which is in this file.
   *
   * The callers, named because this method spent a long time having none at all
   * while this docblock described what it was for:
   *   - `admin-auth.service.ts`  `changePassword`  -> password_changed
   *   - `passkey.service.ts`     `deletePasskey`   -> passkey_removed
   *   - `admin-admins.controller.ts` `update`      -> admin_role_changed /
   *     admin_deactivated / admin_password_reset
   *   - `admin-admins.controller.ts` `delete`      -> admin_deleted
   *   - `rbac.service.ts` `updateRole` -> role_permissions_narrowed (fan-out:
   *     every holder of the edited role, via `disconnectAdmins`)
   */
  public disconnectAdmin(adminId: string, reason = 'admin_session_revoked'): number {
    return this.disconnectAdmins([adminId], reason);
  }

  /**
   * The same revocation for many admins at once, in ONE pass over the socket
   * map rather than one pass per admin — this is the shape a role-matrix edit
   * needs, where the holder list can be every operator in the company.
   *
   * Unbounded on purpose. Staggering the drops would leave the admins in the
   * later batches holding the stale `allowedTopics` snapshot for the duration of
   * the stagger, which is the leak this exists to close, deliberately held open
   * for longer. The reconnect load is spread by the CLIENT instead: the SPA sets
   * `reconnectionDelay: 1000` and leaves `randomizationFactor` at its 0.5
   * default (`use-realtime-updates.ts:141-143`), so retries land across roughly
   * a one-second window rather than all at t=0 — and after a 4003 the SPA does
   * not retry at all, it signs out. See `disconnectAdmin` for what that means.
   */
  public disconnectAdmins(
    adminIds: Iterable<string>,
    reason = 'admin_session_revoked',
  ): number {
    const targets = new Set(adminIds);
    if (targets.size === 0) return 0;
    let dropped = 0;
    // Snapshot the values first: `deny()` disconnects, and the transport calls
    // `handleDisconnect` back into `this.sockets` while we are iterating it.
    for (const socket of Array.from(this.sockets.values())) {
      if (targets.has(socket.data.adminId)) {
        this.deny(socket, REALTIME_CLOSE.TOKEN_VERSION_MISMATCH, reason);
        dropped++;
      }
    }
    return dropped;
  }

  /** Number of currently authenticated sockets. Useful for dashboard widgets. */
  public connectedCount(): number {
    return this.sockets.size;
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  /**
   * Refuses a handshake from an address the operator has excluded. Returns a
   * close reason, or `null` to let the handshake proceed.
   *
   * Why this lives in the gateway rather than in a guard. Nest never wires
   * `APP_GUARD` into the WebSocket pipeline at all:
   * `SocketModule.getContextCreator()` builds `new GuardsContextCreator(
   * container)` WITHOUT the `ApplicationConfig`
   * (`@nestjs/websockets@11.1.23/socket-module.js`), so `getGlobalMetadata()`
   * reads an undefined config and returns `[]`. Measured against this app with
   * an `APP_GUARD` that records every context it is handed: it logged the HTTP
   * probe and never once saw a `ws` context, while in the same run a blocked
   * address got `403` from `/api/admin/*` and a full `ready` packet — every
   * topic its RBAC role allows — from the socket. Neither the path prefix nor
   * `AdminIoAdapter` attaching engine.io ahead of Express is the reason on its
   * own; even a gateway mounted under `/api/admin` would be unguarded.
   *
   * Fail-open is inherited deliberately, not by omission. `BlockedIpGuard` and
   * `AdminIpAllowlistGuard` both let a request through on an infra error and on
   * an underivable client IP, because refusing every operator during a Postgres
   * hiccup is the worse failure. A handshake gate that failed CLOSED would be
   * strictly harsher than the HTTP surface it is meant to match, and would take
   * realtime down for everyone the first time the DB blinked.
   */
  private async refuseByAddress(client: Socket): Promise<string | null> {
    const address = this.resolveClientAddress(client);
    // Fourth documented fail-open case, same as both guards: no derivable IP.
    if (address === null) return null;

    const { blocked, allowlist } = this.resolveIpStores();
    if (blocked) {
      try {
        if ((await blocked.isBlocked(address)).blocked) return 'ip_blocked';
      } catch {
        // Fail-open on infra failures — see the method docblock.
      }
    }
    if (allowlist) {
      try {
        if (!(await allowlist.isRequestAllowed(address))) return 'ip_not_allowed';
      } catch {
        // Fail-open on infra failures — see the method docblock.
      }
    }
    return null;
  }

  /**
   * The client address, resolved with the SAME trust-proxy rule Express applies
   * to `req.ip`.
   *
   * This is the load-bearing half of the gate. `handshake.address` is the raw
   * TCP peer (`socket.io/dist/socket.js:135` -> `conn.remoteAddress`), which
   * behind the reverse proxy this panel normally runs behind is the PROXY, not
   * the operator. Testing the allowlist against that address would refuse every
   * handshake the moment an operator adds their first entry — realtime would
   * die panel-wide for a list nobody is actually off. So we hand the upgrade
   * request's headers and peer to `proxy-addr` under the same
   * `ADMIN_TRUST_PROXY` value `configureHttpRuntimeMiddleware` gives Express,
   * and the two surfaces agree by construction instead of by inspection.
   */
  private resolveClientAddress(client: Socket): string | null {
    const trustMode = buildTrustedProxyValue(this.appConfiguration?.trustProxy);
    let resolved: string | undefined;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const proxyAddr = require('proxy-addr') as ProxyAddrFn;
      resolved = proxyAddr(
        {
          headers: client.handshake.headers as unknown as Record<string, unknown>,
          socket: { remoteAddress: client.handshake.address },
        },
        trustMode === false ? TRUST_NO_PROXY : trustMode,
      );
    } catch (err) {
      this.logger.warn(
        `Realtime handshake address resolution failed: ${(err as Error).message}`,
      );
      resolved = client.handshake.address;
    }
    if (typeof resolved !== 'string' || resolved.length === 0) return null;
    // Strip the IPv4-mapped IPv6 prefix, exactly as both guards do, so the
    // stored CIDRs match the same way on both surfaces.
    const normalized = resolved.replace(/^::ffff:/, '');
    return normalized.length > 0 ? normalized : null;
  }

  /**
   * Resolves the two IP stores through `ModuleRef` on first use — the same
   * escape hatch `SystemEventsService` uses to reach this gateway
   * (its private `resolveRealtimeGateway()`). Declaring them as constructor
   * dependencies would make `RealtimeModule` import `BlockedIpsModule` and
   * `TwoFactorModule`, and `TwoFactorModule` already imports `AuthModule`,
   * which `RealtimeModule` imports too. A `null` store means the container has
   * no such provider — the same runtime in which the HTTP guards are absent as
   * well — so the handshake proceeds.
   */
  private resolveIpStores(): {
    readonly blocked: BlockedIpServiceLike | null;
    readonly allowlist: AdminIpAllowlistServiceLike | null;
  } {
    if (this.ipStoresResolved) {
      return { blocked: this.blockedIpService, allowlist: this.allowlistService };
    }
    this.ipStoresResolved = true;
    if (this.moduleRef) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { BlockedIpService } = require('../blocked-ips/services/blocked-ip.service');
        this.blockedIpService = this.moduleRef.get(BlockedIpService, { strict: false });
      } catch {
        this.blockedIpService = null;
      }
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const allowlistModule = require('../two-factor/services/admin-ip-allowlist.service');
        this.allowlistService = this.moduleRef.get(allowlistModule.AdminIpAllowlistService, {
          strict: false,
        });
      } catch {
        this.allowlistService = null;
      }
    }
    if (!this.blockedIpService && !this.allowlistService) {
      this.logger.warn(
        'Realtime handshake IP gate inactive: neither IP store is in this container',
      );
    }
    return { blocked: this.blockedIpService, allowlist: this.allowlistService };
  }

  private extractToken(client: Socket): string | null {
    // 1. Socket.IO handshake auth payload — preferred for browser clients
    const fromHandshake = (client.handshake.auth as Record<string, unknown> | undefined)?.['token'];
    if (typeof fromHandshake === 'string' && fromHandshake.length > 0) {
      return fromHandshake;
    }
    // 2. Authorization header (server-to-server clients, curl tests)
    const header = client.handshake.headers.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      return header.slice(7);
    }
    // 3. ?token= query — last resort, keeps debugging trivial
    const query = client.handshake.query['token'];
    if (typeof query === 'string' && query.length > 0) {
      return query;
    }
    return null;
  }

  private parseTopics(payload: unknown): RealtimeTopic[] {
    if (!Array.isArray(payload)) return [];
    const allowed = new Set<string>(REALTIME_TOPICS);
    return payload.filter((p): p is RealtimeTopic => typeof p === 'string' && allowed.has(p));
  }

  /**
   * Resolves the set of topics an admin may receive from their RBAC
   * permissions. A topic is allowed only when the admin holds the mapped
   * `resource:view` permission (DEV / superadmin get everything via
   * `hasPermission`).
   *
   * RESOLVED ONCE, AT CONNECT. The result is stored on the socket and
   * `broadcast()` tests that snapshot; nothing refreshes it in place. Whether an
   * admin's live stream reflects a permission change therefore depends entirely
   * on whether that change drops the socket:
   *
   *   RE-RUNS (the socket is dropped and the client reconnects)
   *     - `admin-admins.controller.ts` `update`, when `role` or `rbacRoleId`
   *       actually changes, when the account is deactivated, or when its
   *       password is reset;
   *     - `admin-admins.controller.ts` `delete`;
   *     - `RbacService.updateRole`, when the edited role's permission matrix
   *       LOSES a token — every admin holding that role, in one pass.
   *
   *   DOES NOT RE-RUN, deliberately
   *     - `RbacService.updateRole` when the matrix only GAINS tokens, or when
   *       only the display metadata changed. The snapshot is equally stale after
   *       a widening, but harmlessly so — the admin under-receives until they
   *       reconnect. Dropping them is not the cheap correction it looks like:
   *       see `disconnectAdmin`, it signs them out. Paying a company-wide
   *       sign-out to deliver a topic sooner is the wrong trade; paying it to
   *       stop delivering one is the right one.
   *     - `createRole` (no holders yet) and `seedSystemRoles` (only ever
   *       `createMany({ skipDuplicates: true })`, never deletes — so it cannot
   *       narrow). `deleteRole` refuses while any admin holds the role, so it
   *       cannot strand a holder either.
   *
   * This comment previously said role changes force a reconnect, full stop. They
   * did not - `disconnectAdmin` had no callers whatsoever. Do not shorten it back
   * to the general claim: the split above is the behaviour, and the widening half
   * is a decision rather than an omission.
   */
  private async resolveAllowedTopics(admin: {
    readonly id: string;
    readonly role: UserRole;
    readonly rbacRoleId: string | null;
  }): Promise<Set<RealtimeTopic>> {
    const allowed = new Set<RealtimeTopic>();
    for (const topic of REALTIME_TOPICS) {
      const { resource, action } = REALTIME_TOPIC_PERMISSION[topic];
      if (await this.rbacService.hasPermission(admin, resource, action)) {
        allowed.add(topic);
      }
    }
    return allowed;
  }

  private deny(socket: Socket, code: number, reason: string): void {
    try {
      socket.emit('error', { code, reason });
    } finally {
      // Use disconnect(true) to forcibly close the underlying transport.
      // Socket.IO does not expose custom WS close codes directly, so the
      // numeric reason is communicated via the emitted `error` payload and
      // duplicated in the disconnect packet's `data`.
      socket.disconnect(true);
    }
  }
}
