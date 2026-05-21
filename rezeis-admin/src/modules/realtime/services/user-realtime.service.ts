import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';

import {
  RealtimeEventInterface,
} from '../interfaces/realtime-event.interface';
import {
  USER_EVENT_WHITELIST,
  UserRealtimeEventInterface,
} from '../interfaces/user-realtime-event.interface';
import { RealtimeGateway } from '../realtime.gateway';

/**
 * Per-user subscriber. Each open SSE stream registers one of these and
 * unregisters on close. The service holds a tiny in-memory registry,
 * subscribes to the same broadcast hook the automation engine uses, and
 * routes every emitted admin event through the user-event whitelist
 * before fanning it out.
 *
 * Why share the gateway broadcast hook?
 *   `AutomationEventBridgeService` already wraps `RealtimeGateway.broadcast`
 *   with `setImmediate` so dispatch never blocks the WS fan-out. We
 *   layer on top of the same wrapper so user routing is also async.
 *
 * Cap: each user can hold at most `MAX_STREAMS_PER_USER` concurrent
 * streams. New streams beyond the cap evict the oldest — protects the
 * server from pathological clients that don't close streams.
 */
const MAX_STREAMS_PER_USER = 4;

interface UserSubscriber {
  readonly userId: string | null;
  readonly telegramId: string | null;
  readonly handler: (event: UserRealtimeEventInterface) => void;
  readonly registeredAt: number;
}

@Injectable()
export class UserRealtimeService {
  private readonly logger = new Logger(UserRealtimeService.name);
  private readonly subscribersById = new Map<string, UserSubscriber>();
  private installedHook = false;

  public constructor(private readonly moduleRef: ModuleRef) {}

  /**
   * Register a subscriber. Returns an unsubscribe function that the
   * controller MUST call on stream close.
   */
  public subscribe(input: {
    readonly userId: string | null;
    readonly telegramId: string | null;
    readonly handler: (event: UserRealtimeEventInterface) => void;
  }): () => void {
    this.installHookOnce();
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const subscriber: UserSubscriber = {
      userId: input.userId,
      telegramId: input.telegramId,
      handler: input.handler,
      registeredAt: Date.now(),
    };
    this.subscribersById.set(id, subscriber);
    this.enforcePerUserCap(input.userId, input.telegramId);
    return () => {
      this.subscribersById.delete(id);
    };
  }

  /**
   * Number of currently-attached subscribers — exposed to dashboards
   * so operators can see how many user clients are live.
   */
  public connectedCount(): number {
    return this.subscribersById.size;
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private installHookOnce(): void {
    if (this.installedHook) return;
    let gateway: RealtimeGateway | null = null;
    try {
      gateway = this.moduleRef.get(RealtimeGateway, { strict: false });
    } catch {
      gateway = null;
    }
    if (!gateway) {
      this.logger.warn('RealtimeGateway not available — user realtime disabled');
      return;
    }
    const original = gateway.broadcast.bind(gateway);
    gateway.broadcast = (event: RealtimeEventInterface): void => {
      original(event);
      // Route on a microtask so a slow user-side handler never blocks
      // the admin fan-out.
      setImmediate(() => this.fanOut(event));
    };
    this.installedHook = true;
  }

  private fanOut(event: RealtimeEventInterface): void {
    const projection = USER_EVENT_WHITELIST[event.type];
    if (!projection) return;
    if (this.subscribersById.size === 0) return;

    for (const subscriber of this.subscribersById.values()) {
      const projected = projection.project(event.metadata ?? {}, {
        userId: subscriber.userId,
        telegramId: subscriber.telegramId,
      });
      if (projected === null) continue;
      const userEvent: UserRealtimeEventInterface = {
        type: event.type,
        category: projection.category,
        severity: projection.severity ?? event.severity,
        message: event.message,
        metadata: projected,
        timestamp: event.timestamp,
      };
      try {
        subscriber.handler(userEvent);
      } catch (err) {
        // A single broken handler must never bring down the fan-out.
        this.logger.warn(`User SSE handler threw: ${(err as Error).message}`);
      }
    }
  }

  private enforcePerUserCap(userId: string | null, telegramId: string | null): void {
    if (userId === null && telegramId === null) return;
    const matching: Array<{ id: string; subscriber: UserSubscriber }> = [];
    for (const [id, subscriber] of this.subscribersById.entries()) {
      const sameUserId = userId !== null && subscriber.userId === userId;
      const sameTg = telegramId !== null && subscriber.telegramId === telegramId;
      if (sameUserId || sameTg) matching.push({ id, subscriber });
    }
    if (matching.length <= MAX_STREAMS_PER_USER) return;
    matching.sort((a, b) => a.subscriber.registeredAt - b.subscriber.registeredAt);
    const overflow = matching.length - MAX_STREAMS_PER_USER;
    for (let i = 0; i < overflow; i++) {
      this.subscribersById.delete(matching[i].id);
    }
  }
}
