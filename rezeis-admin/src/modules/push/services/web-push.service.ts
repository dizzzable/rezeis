import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { WebPushSubscription } from '@prisma/client';
import * as webpush from 'web-push';

import { PrismaService } from '../../../common/prisma/prisma.service';

interface SubscribeInput {
  readonly userId: string;
  readonly endpoint: string;
  readonly p256dhKey: string;
  readonly authKey: string;
  readonly userAgent?: string | null;
}

interface SendInput {
  readonly userId: string;
  readonly title: string;
  readonly body: string;
  /**
   * URL the SPA navigates to when the user taps the notification.
   * Defaults to `/dashboard` so a tap always lands somewhere useful.
   */
  readonly url?: string;
}

/**
 * Expected shape of the encryption JSON each push delivery requires
 * from `web-push`. Pulled out as a typed alias so we can pass strings
 * straight from `WebPushSubscription` rows without `any`.
 */
interface PushKeys {
  readonly p256dh: string;
  readonly auth: string;
}

/**
 * Strip-down of the `WebPush` library's expected `PushSubscription`
 * shape. `web-push` accepts these three fields and ignores the rest;
 * the spec-level `PushSubscription` is much wider but irrelevant for
 * the server side.
 */
interface PushSubscriptionPayload {
  readonly endpoint: string;
  readonly keys: PushKeys;
}

/**
 * WebPushService
 * ──────────────
 * Persists browser web-push subscriptions and fans `UserNotificationEvent`
 * notifications out to them via the standardised Web Push protocol
 * (RFC 8030 + VAPID RFC 8292).
 *
 * VAPID keys (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`,
 * `VAPID_CONTACT_EMAIL`) are generated once with
 * `npx web-push generate-vapid-keys` and pinned to the deployment;
 * rotating them invalidates every existing subscription, so we
 * intentionally don't auto-rotate.
 *
 * iOS 16.4+ note: web-push delivery on Safari only works for PWAs
 * that the user added to the Home Screen. Reiwa is already a PWA
 * (vite-plugin-pwa + manifest.webmanifest), so once the user
 * installs it from Safari's Share menu, push delivery works
 * identically to Chrome / Firefox / desktop Safari.
 */
@Injectable()
export class WebPushService implements OnModuleInit {
  private readonly logger = new Logger(WebPushService.name);
  private vapidConfigured = false;

  /** Number of consecutive transient failures we tolerate before
   * deleting a subscription. Three matches Web Push best practice —
   * higher rates indicate a permanent failure (lost user, blocked
   * notifications, dropped service worker). */
  private static readonly MAX_FAILURES = 3;

  public constructor(private readonly prismaService: PrismaService) {}

  public onModuleInit(): void {
    const publicKey = (process.env.VAPID_PUBLIC_KEY ?? '').trim();
    const privateKey = (process.env.VAPID_PRIVATE_KEY ?? '').trim();
    const contact = (process.env.VAPID_CONTACT_EMAIL ?? '').trim();
    if (publicKey === '' || privateKey === '' || contact === '') {
      this.logger.warn(
        'WebPushService disabled — set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_CONTACT_EMAIL to enable browser pushes',
      );
      return;
    }
    const subject = contact.startsWith('mailto:') ? contact : `mailto:${contact}`;
    webpush.setVapidDetails(subject, publicKey, privateKey);
    this.vapidConfigured = true;
    this.logger.log('WebPushService VAPID configured');
  }

  /**
   * Returns the VAPID public key for the SPA to use during
   * subscription. Empty string when push is disabled — the SPA
   * must hide its push opt-in UI in that case.
   */
  public getPublicKey(): string {
    return (process.env.VAPID_PUBLIC_KEY ?? '').trim();
  }

  public async subscribe(input: SubscribeInput): Promise<{ id: string }> {
    const persisted = await this.prismaService.webPushSubscription.upsert({
      where: { endpoint: input.endpoint },
      create: {
        userId: input.userId,
        endpoint: input.endpoint,
        p256dhKey: input.p256dhKey,
        authKey: input.authKey,
        userAgent: input.userAgent ?? null,
      },
      update: {
        // Endpoint already known — refresh the user binding (handles
        // a device shared between two accounts) and the keys (the
        // service worker may rotate them on re-subscribe).
        userId: input.userId,
        p256dhKey: input.p256dhKey,
        authKey: input.authKey,
        userAgent: input.userAgent ?? null,
        failureCount: 0,
        lastSeenAt: new Date(),
      },
      select: { id: true },
    });
    return persisted;
  }

  public async unsubscribe(input: {
    readonly userId: string;
    readonly endpoint: string;
  }): Promise<void> {
    await this.prismaService.webPushSubscription.deleteMany({
      where: { userId: input.userId, endpoint: input.endpoint },
    });
  }

  /**
   * Fan a notification out to every active subscription for a user.
   * Failures are isolated per subscription — one dead subscription
   * never blocks delivery to a user's other devices. 410 Gone /
   * 404 Not Found responses delete the subscription immediately
   * (those endpoints will never recover).
   */
  public async sendToUser(input: SendInput): Promise<void> {
    if (!this.vapidConfigured) return;
    const subs = await this.prismaService.webPushSubscription.findMany({
      where: { userId: input.userId },
    });
    if (subs.length === 0) return;
    const payload = JSON.stringify({
      title: input.title,
      body: input.body,
      url: input.url ?? '/dashboard',
    });
    await Promise.all(subs.map((sub) => this.deliverOne(sub, payload)));
  }

  private async deliverOne(sub: WebPushSubscription, payload: string): Promise<void> {
    const target: PushSubscriptionPayload = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dhKey, auth: sub.authKey },
    };
    try {
      await webpush.sendNotification(target, payload, { TTL: 60 });
      // Successful delivery — reset failure count, refresh lastSeenAt.
      await this.prismaService.webPushSubscription.update({
        where: { id: sub.id },
        data: { failureCount: 0, lastSeenAt: new Date() },
      });
    } catch (err: unknown) {
      const status =
        err !== null && typeof err === 'object' && 'statusCode' in err
          ? (err as { statusCode?: number }).statusCode ?? null
          : null;
      if (status === 404 || status === 410) {
        // Endpoint is permanently gone (device unsubscribed, app
        // uninstalled, push service rotated identifiers). Drop it.
        await this.prismaService.webPushSubscription.delete({ where: { id: sub.id } });
        this.logger.log(`WebPush: deleted dead subscription ${sub.id} (${status})`);
        return;
      }
      // Transient — bump counter, evict if we hit the threshold.
      const next = sub.failureCount + 1;
      if (next >= WebPushService.MAX_FAILURES) {
        await this.prismaService.webPushSubscription.delete({ where: { id: sub.id } });
        this.logger.warn(`WebPush: evicted ${sub.id} after ${next} consecutive failures`);
        return;
      }
      await this.prismaService.webPushSubscription.update({
        where: { id: sub.id },
        data: { failureCount: next },
      });
      this.logger.warn(
        `WebPush: send failed for ${sub.id} (${status ?? 'unknown'}), failureCount=${next}`,
      );
    }
  }
}
