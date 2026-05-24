import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
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

import { authConfig } from '../../common/config/auth.config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AdminJwtPayloadInterface } from '../auth/interfaces/admin-jwt-payload.interface';
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
  RealtimeEventInterface,
  RealtimeTopic,
} from './interfaces/realtime-event.interface';

interface AuthenticatedSocket extends Socket {
  data: {
    adminId: string;
    login: string;
    tokenVersion: number;
    topics: Set<RealtimeTopic>;
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
  cors: { origin: true, credentials: true },
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
  ) {}

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
      select: { id: true, login: true, isActive: true, tokenVersion: true },
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

    const authed = client as AuthenticatedSocket;
    authed.data = {
      adminId: admin.id,
      login: admin.login,
      tokenVersion: admin.tokenVersion,
      topics: new Set<RealtimeTopic>(),
    };
    this.sockets.set(authed.id, authed);

    authed.emit(REALTIME_READY, {
      adminId: admin.id,
      topics: REALTIME_TOPICS,
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
    requested.forEach((t) => authed.data.topics.add(t));
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
    for (const socket of this.sockets.values()) {
      const topics = socket.data.topics;
      if (topics.size === 0 || topics.has(event.category)) {
        socket.emit(REALTIME_EVENT, event);
      }
    }
  }

  /**
   * Forcefully drop every socket bound to an admin (e.g. password change,
   * role demotion). The frontend will reconnect with the latest token, at
   * which point handshake validation will either succeed or kick the user
   * out cleanly.
   */
  public disconnectAdmin(adminId: string, reason = 'admin_session_revoked'): number {
    let dropped = 0;
    for (const socket of this.sockets.values()) {
      if (socket.data.adminId === adminId) {
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
