import { ConflictException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AdminWebPushSubscription, WebPushSubscription } from '@prisma/client';
import * as webpush from 'web-push';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { SettingsService } from '../../settings/services/settings.service';

interface SubscribeInput {
  readonly userId: string;
  readonly endpoint: string;
  readonly p256dhKey: string;
  readonly authKey: string;
  readonly userAgent?: string | null;
}

interface AdminSubscribeInput {
  readonly adminId: string;
  readonly endpoint: string;
  readonly p256dhKey: string;
  readonly authKey: string;
  readonly userAgent?: string | null;
}

interface AdminSendInput {
  readonly adminId: string;
  readonly title: string;
  readonly body: string;
  /** URL the SPA navigates to when the admin taps the notification. */
  readonly url?: string;
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

  /** Number of consecutive transient failures we tolerate before
   * deleting a subscription. Three matches Web Push best practice —
   * higher rates indicate a permanent failure (lost user, blocked
   * notifications, dropped service worker). */
  private static readonly MAX_FAILURES = 3;

  /**
   * Refusal returned when the endpoint a browser presents is already bound to
   * a DIFFERENT admin's row. Deliberately names nobody — who holds the row is
   * an operator question and belongs in the log, not in a response any admin
   * can trigger at will.
   */
  private static readonly ENDPOINT_HELD_BY_ANOTHER_ADMIN =
    'This browser subscription is already registered to another administrator';

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly settingsService: SettingsService,
  ) {}

  public async onModuleInit(): Promise<void> {
    const config = await this.settingsService.getDecryptedWebPushConfig();
    if (config === null) {
      this.logger.warn(
        'WebPushService disabled — generate VAPID keys in the admin panel (Settings → Web-push) or set VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY/VAPID_CONTACT_EMAIL',
      );
      return;
    }
    this.logger.log(`WebPushService VAPID configured (source: ${config.source})`);
  }

  /**
   * Returns the active VAPID public key for the SPA to use during
   * subscription. Empty string when push is disabled — the SPA must hide
   * its push opt-in UI in that case. Resolves panel-managed keys first,
   * then the environment fallback.
   */
  public async getPublicKey(): Promise<string> {
    const config = await this.settingsService.getDecryptedWebPushConfig();
    return config?.publicKey ?? '';
  }

  /** Resolve the VAPID details used to sign a push, or null when disabled. */
  private async resolveVapidDetails(): Promise<webpush.RequestOptions['vapidDetails'] | null> {
    const config = await this.settingsService.getDecryptedWebPushConfig();
    if (config === null) return null;
    return { subject: config.subject, publicKey: config.publicKey, privateKey: config.privateKey };
  }

  /**
   * Bind a subscriber's browser to a push subscription row.
   *
   * This is deliberately an `upsert` keyed on the endpoint, and its update
   * branch deliberately rewrites `userId` — the same shape that was a real
   * defect on the admin side and had to be split apart there
   * (`subscribeAdmin` below). The two are not the same situation, and the
   * difference is worth stating because the code looks identical:
   *
   *   - Nobody reaches this from the outside. `POST internal/push/subscribe`
   *     sits behind `InternalAdminAuthGuard`; the cabinet's BFF is the only
   *     caller and it fills `userId` from a session it has already verified.
   *     A subscriber cannot name another subscriber's id. If the internal
   *     token leaks, the subscriptions are not what has been lost.
   *   - There is no channel to learn someone else's endpoint. What made the
   *     admin case exploitable was that an endpoint reaches any log recording
   *     request bodies, and admins read logs. Subscribers do not.
   *   - So the only way one account offers up another's endpoint is that it is
   *     literally the same browser — and there, re-pointing the row is the
   *     correct answer, not a leak. Two people share a computer; whoever is
   *     signed in is who that browser's push belongs to.
   *
   * And it self-corrects, which the admin side did not: the cabinet calls
   * `ensurePushSubscription()` once per session on every sign-in
   * (`reiwa/web/src/components/layout/stealth-layout.tsx:164`), so the row
   * follows whoever signed in last. Refusing here — the admin fix — would
   * instead leave the second person on a shared machine with no push at all
   * until the first one's row is removed. That is a regression in the only
   * scenario this branch exists for.
   *
   * The condition that would change this answer: a route that lets a caller
   * supply `userId` without an already-verified session behind it.
   */
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
        // Endpoint already known — hand the browser to the account that is
        // signed in now, and refresh the keys the service worker may have
        // rotated on re-subscribe.
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
    const vapidDetails = await this.resolveVapidDetails();
    if (vapidDetails === null) return;
    const subs = await this.prismaService.webPushSubscription.findMany({
      where: { userId: input.userId },
    });
    if (subs.length === 0) return;
    const payload = JSON.stringify({
      title: input.title,
      body: input.body,
      url: input.url ?? '/dashboard',
    });
    await Promise.all(subs.map((sub) => this.deliverOne(sub, payload, vapidDetails)));
  }

  // ── Admin-scoped push (panel operators) ───────────────────────────────────

  /**
   * Bind the calling admin's own browser to a push subscription row.
   *
   * Every write here is scoped to the caller, and that is the whole point.
   * The previous `upsert({ where: { endpoint } })` was not: `endpoint` is
   * globally `@unique` (`prisma/schema.prisma:2343`), so its update branch
   * re-pointed whichever row already held the endpoint at the caller. An
   * endpoint is not a secret — it sits in the table in plaintext next to
   * `userAgent` and reaches any log that records request bodies — so an admin
   * who had seen another admin's endpoint could POST it here and take the row
   * over. The victim stopped receiving push with nothing to show for it, the
   * caller's own notifications started arriving in the victim's browser (the
   * endpoint never changed, only the row's owner did), and `failureCount: 0`
   * resurrected rows the fanout had already written off as dead.
   *
   * Split in two so that neither half can reach a row the caller does not own:
   *
   *   1. `updateMany` scoped by `{ adminId, endpoint }` — the re-subscribe
   *      path. Same browser, same admin: refresh the keys the service worker
   *      may have rotated and clear the failure state. It cannot change
   *      `adminId`, so it cannot move a row between admins.
   *   2. `create` when the caller owns no such row. The global `@unique` on
   *      `endpoint` is what makes this safe rather than merely tidy: a row
   *      belonging to somebody else turns the INSERT into a unique violation
   *      instead of a second row aimed at the same browser. That is also why
   *      this fix needs no migration — the constraint that caused the damage
   *      through `upsert` is the constraint that now enforces ownership.
   *
   * A unique violation is therefore one of two things, and the row itself —
   * never the caller's claim — decides which: our own concurrent request won
   * the insert (two tabs re-subscribing at once, which is not a conflict), or
   * another admin holds the endpoint (refused, 409, and logged with both ids).
   * Refusing is the deliberate choice over silently replacing: replacing keeps
   * the victim's loss of push, only with a log line next to it, whereas a
   * refusal leaves their row exactly as it was. The one honest subscription it
   * turns away is a browser genuinely handed from one admin to another with
   * the old row still live. That operator is not stuck: the SPA's opt-in path
   * (`web/src/lib/push.ts` `enablePush`) drops the local subscription when this
   * POST fails, and the next `pushManager.subscribe()` issues a fresh endpoint
   * — which also revokes the old one, so the abandoned row starts taking 410s
   * and the fanout prunes it. The silent on-load path
   * (`ensurePushSubscription`) swallows the failure instead, so until the
   * operator uses the toggle their only evidence is the warn logged below.
   */
  public async subscribeAdmin(input: AdminSubscribeInput): Promise<{ id: string }> {
    const refreshed = await this.refreshOwnAdminSubscription(input);
    if (refreshed !== null) return refreshed;

    try {
      return await this.prismaService.adminWebPushSubscription.create({
        data: {
          adminId: input.adminId,
          endpoint: input.endpoint,
          p256dhKey: input.p256dhKey,
          authKey: input.authKey,
          userAgent: input.userAgent ?? null,
        },
        select: { id: true },
      });
    } catch (err: unknown) {
      // `id` is a client-generated cuid, so `endpoint` is the only unique this
      // INSERT can violate — no need to read the constraint name back out.
      if (!isUniqueConstraintViolation(err)) throw err;
      const incumbent = await this.prismaService.adminWebPushSubscription.findUnique({
        where: { endpoint: input.endpoint },
        select: { id: true, adminId: true },
      });
      if (incumbent !== null && incumbent.adminId === input.adminId) {
        // Our own row, inserted by a concurrent request in the window between
        // the scoped `updateMany` above and this `create`. Re-subscribing the
        // same browser twice is not a conflict: refresh and report success.
        return (await this.refreshOwnAdminSubscription(input)) ?? { id: incumbent.id };
      }
      if (incumbent === null) {
        // The blocking row disappeared between our failed INSERT and this read
        // (an unsubscribe, or the fanout pruning it). Refuse rather than
        // looping back to `create`: the browser retries on its next load and
        // lands on a clean insert, whereas retrying in place is how this path
        // would start recursing.
        this.logger.warn(
          `WebPush(admin): subscribe for admin ${input.adminId} lost an insert race to a row that no longer exists`,
        );
      } else {
        this.logger.warn(
          `WebPush(admin): refused subscribe for admin ${input.adminId} — endpoint is bound to ` +
            `admin ${incumbent.adminId} (subscription ${incumbent.id})`,
        );
      }
      throw new ConflictException(WebPushService.ENDPOINT_HELD_BY_ANOTHER_ADMIN);
    }
  }

  /**
   * Refresh the caller's OWN row for this endpoint, when they have one.
   * Scoped by `adminId` in the `where`, and it never writes `adminId`, so no
   * call can move a row from one admin to another. Returns null when the
   * caller owns no row for the endpoint — the signal to insert one.
   */
  private async refreshOwnAdminSubscription(
    input: AdminSubscribeInput,
  ): Promise<{ id: string } | null> {
    const owned = { adminId: input.adminId, endpoint: input.endpoint };
    const { count } = await this.prismaService.adminWebPushSubscription.updateMany({
      where: owned,
      data: {
        p256dhKey: input.p256dhKey,
        authKey: input.authKey,
        userAgent: input.userAgent ?? null,
        failureCount: 0,
        lastSeenAt: new Date(),
      },
    });
    if (count === 0) return null;
    return this.prismaService.adminWebPushSubscription.findFirst({
      where: owned,
      select: { id: true },
    });
  }

  public async unsubscribeAdmin(input: {
    readonly adminId: string;
    readonly endpoint: string;
  }): Promise<void> {
    await this.prismaService.adminWebPushSubscription.deleteMany({
      where: { adminId: input.adminId, endpoint: input.endpoint },
    });
  }

  /** True when at least one admin has an active push subscription. */
  public async adminHasSubscription(adminId: string): Promise<boolean> {
    const count = await this.prismaService.adminWebPushSubscription.count({
      where: { adminId },
    });
    return count > 0;
  }

  /**
   * Fan a notification out to every active subscription owned by one admin.
   * Mirrors `sendToUser` isolation: a dead subscription never blocks the
   * admin's other devices, and 404/410 prune immediately.
   */
  public async sendToAdmin(input: AdminSendInput): Promise<void> {
    const vapidDetails = await this.resolveVapidDetails();
    if (vapidDetails === null) return;
    const subs = await this.prismaService.adminWebPushSubscription.findMany({
      where: { adminId: input.adminId },
    });
    if (subs.length === 0) return;
    const payload = JSON.stringify({
      title: input.title,
      body: input.body,
      url: input.url ?? '/',
    });
    await Promise.all(subs.map((sub) => this.deliverOneAdmin(sub, payload, vapidDetails)));
  }

  private async deliverOneAdmin(
    sub: AdminWebPushSubscription,
    payload: string,
    vapidDetails: webpush.RequestOptions['vapidDetails'],
  ): Promise<void> {
    const target: PushSubscriptionPayload = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dhKey, auth: sub.authKey },
    };
    try {
      await webpush.sendNotification(target, payload, { TTL: 60, vapidDetails });
      await this.prismaService.adminWebPushSubscription.update({
        where: { id: sub.id },
        data: { failureCount: 0, lastSeenAt: new Date() },
      });
    } catch (err: unknown) {
      const status =
        err !== null && typeof err === 'object' && 'statusCode' in err
          ? (err as { statusCode?: number }).statusCode ?? null
          : null;
      if (status === 404 || status === 410) {
        await this.prismaService.adminWebPushSubscription.delete({ where: { id: sub.id } });
        this.logger.log(`WebPush(admin): deleted dead subscription ${sub.id} (${status})`);
        return;
      }
      const next = sub.failureCount + 1;
      if (next >= WebPushService.MAX_FAILURES) {
        await this.prismaService.adminWebPushSubscription.delete({ where: { id: sub.id } });
        this.logger.warn(`WebPush(admin): evicted ${sub.id} after ${next} consecutive failures`);
        return;
      }
      await this.prismaService.adminWebPushSubscription.update({
        where: { id: sub.id },
        data: { failureCount: next },
      });
      this.logger.warn(
        `WebPush(admin): send failed for ${sub.id} (${status ?? 'unknown'}), failureCount=${next}`,
      );
    }
  }

  private async deliverOne(
    sub: WebPushSubscription,
    payload: string,
    vapidDetails: webpush.RequestOptions['vapidDetails'],
  ): Promise<void> {
    const target: PushSubscriptionPayload = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dhKey, auth: sub.authKey },
    };
    try {
      await webpush.sendNotification(target, payload, { TTL: 60, vapidDetails });
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Prisma unique-constraint violation, matched on the error code rather than
 * `instanceof Prisma.PrismaClientKnownRequestError`. The code is the
 * contractual part; the class identity is not, and it survives neither a
 * driver adapter re-wrapping the error nor a second copy of `@prisma/client`
 * in the module graph.
 */
function isUniqueConstraintViolation(error: unknown): boolean {
  return isRecord(error) && error.code === 'P2002';
}
