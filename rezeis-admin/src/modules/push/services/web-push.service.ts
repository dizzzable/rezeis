import { ConflictException, Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { AdminWebPushSubscription, Prisma, WebPushSubscription } from '@prisma/client';
import * as webpush from 'web-push';

import { appConfig } from '../../../common/config/app.config';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  EVENT_TYPES,
  SystemEventsService,
} from '../../../common/services/system-events.service';
import { readJsonObject } from '../../../common/utils/read-json-object.util';
import { SettingsService } from '../../settings/services/settings.service';
import { encryptTotpSecret } from '../../two-factor/utils/secret-cipher';

/**
 * Outcome of the one-time `VAPID_*` env→panel migration.
 *
 * `absent` and `already-migrated` are both "nothing to do", but they are not
 * the same state to an operator and must not be collapsed: `already-migrated`
 * means the `VAPID_*` variables are still sitting in `.env` and are now inert,
 * and telling them to delete those is the last step of the migration.
 */
type LegacyEnvAdoption =
  | { readonly outcome: 'adopted' }
  | { readonly outcome: 'absent' }
  | { readonly outcome: 'already-migrated' }
  | { readonly outcome: 'failed'; readonly reason: string };

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

/**
 * What one user-scoped fanout actually did. `sendToUser` used to return
 * `void`, which is why "push doesn't work" could not be answered from the
 * operator's seat: a disabled deployment, a user with no browser registered,
 * and a push service rejecting every endpoint were all the same silence.
 * Each is a different thing to tell the operator, so each gets a field.
 */
export interface WebPushSendResult {
  /** Subscriptions this fanout tried. Zero ⇒ the user has no browser bound. */
  readonly attempted: number;
  /** Subscriptions the push service accepted. */
  readonly delivered: number;
  /** Subscriptions that failed — transient, or pruned as permanently gone. */
  readonly failed: number;
  /** True when no VAPID keypair is configured, so nothing was attempted. */
  readonly disabled: boolean;
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
 * VAPID keys are generated and stored IN THE PANEL — Settings → Web-push —
 * and nowhere else. The private half is encrypted at rest
 * (`systemNotifications.webPush.privateKeyEnc`). Rotating the pair
 * invalidates every existing subscription, so nothing auto-rotates.
 *
 * `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_CONTACT_EMAIL` are a
 * MIGRATION SOURCE, not a configuration surface, and `adoptLegacyEnvKeys`
 * below is the only place in the product that reads them. Nothing serves from
 * them: `SettingsService.getDecryptedWebPushConfig` resolves the panel store
 * and returns `null` when it is empty. Adoption copies the key material
 * verbatim rather than generating a fresh pair, which is the whole point:
 * every browser subscription out there is bound to the old public key, and a
 * new pair would silently strand all of them. The panel can only GENERATE a
 * pair (`SettingsService.generateWebPushKeys`) — there is no paste path — so
 * adoption is the only migration that keeps subscribers.
 *
 * Because there is no fallback left, adoption failing is now the difference
 * between a deployment that delivers push and one that does not. It is never
 * allowed to fail QUIETLY: `onModuleInit` emits
 * `EVENT_TYPES.SYSTEM_WEB_PUSH_UNCONFIGURED` through `SystemEventsService`, at
 * ERROR when legacy keys are sitting in the environment unadopted (the
 * operator believes push is configured and it is not) and at WARNING when
 * nothing is configured anywhere. That reaches the audit log, the realtime
 * admin stream and the operator's Telegram card — not just a container log
 * line nobody reads, which is what "silently" meant the last time this
 * removal was attempted and deferred.
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

  /**
   * The OTHER 409 this route can answer with, and the reason it needs a name.
   *
   * `subscribeAdmin` refuses twice at the same status, for opposite reasons.
   * One is lasting — another admin holds the row and no retry clears it. This
   * one is a race that did not settle: every INSERT collided with a row that
   * had already been deleted by the time it was read back. Nothing is wrong
   * with the caller's browser and the next attempt normally succeeds.
   *
   * Collapsed into one untyped 409 the client can only report the lasting one,
   * because that is the only one it can name — which is exactly what happened:
   * `isEndpointTaken` in `web/src/lib/push.ts` mapped every 409 here to
   * "registered to another administrator", the toggle stayed off, and the
   * operator was sent looking for an administrator who held nothing.
   *
   * PUBLIC because two other files have to agree with it by name: the
   * allowlist in `admin-safe-exception.filter.ts` (which restates it as a
   * literal, so that adding a code here can never widen the allowlist by
   * itself) and the SPA branch that reads it off the wire.
   */
  public static readonly ENDPOINT_RACE_UNSETTLED_CODE = 'PUSH_SUBSCRIBE_ENDPOINT_RACE_UNSETTLED';

  /**
   * The sentence that rides beside the code, for a client build that does not
   * know the code yet.
   *
   * Every word is checked against the scrub in `admin-safe-exception.filter.ts`
   * (`SENSITIVE_HTTP_TEXT_PATTERNS`): one occurrence of `profile`, `token`,
   * `secret`, a URL, an address or a uuid and the whole message is replaced
   * with "Request failed", which tells the operator nothing and hides the one
   * instruction that matters — that trying again is worth doing.
   */
  public static readonly ENDPOINT_RACE_UNSETTLED_MESSAGE =
    'This browser could not be registered because a competing change landed mid-request. Try again.';

  /**
   * How many times `subscribeAdmin` will play its two-step write out before it
   * gives up on a race.
   *
   * THREE, and the number matters less than what it is a bound ON. The retry
   * is reachable from ONE branch: the unique violation was read back and there
   * was NO ROW AT ALL. A genuinely held endpoint is a row that is present and
   * foreign, which leaves the loop on the spot — so no amount of retrying can
   * be spent pressing a refusal that will not move. What remains is the
   * pathological case where something takes and releases the endpoint around
   * every attempt, and a constant is what keeps that from becoming a request
   * that never returns.
   */
  public static readonly ADMIN_SUBSCRIBE_ATTEMPTS = 3;

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly settingsService: SettingsService,
    /**
     * Supplies `cryptKey` for the one-time env→panel adoption below. Last and
     * `@Optional()` so every positional construction in the specs keeps
     * working; absent, adoption cannot encrypt the private half and the
     * deployment is reported as unconfigured rather than quietly half-migrated.
     */
    @Optional()
    @Inject(appConfig.KEY)
    private readonly applicationConfiguration?: ConfigType<typeof appConfig>,
    /**
     * The loud half. `@Optional()` for the same positional-construction
     * reason, but a deployment that resolves it gets the unconfigured state in
     * the audit log, the realtime stream and the operator's Telegram card
     * instead of one `logger.warn` in a container nobody is tailing.
     */
    @Optional()
    private readonly systemEvents?: SystemEventsService,
  ) {}

  public async onModuleInit(): Promise<void> {
    if ((await this.settingsService.getDecryptedWebPushConfig()) !== null) {
      this.logger.log('WebPushService VAPID configured (source: panel)');
      return;
    }
    const adoption = await this.adoptLegacyEnvKeys();
    if (adoption.outcome === 'adopted') {
      this.logger.log(
        'WebPushService adopted VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY from the environment into the panel ' +
          '(Settings → Web-push). The same keypair was kept, so every existing browser subscription still ' +
          'works. You can now remove VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_CONTACT_EMAIL from .env.',
      );
      return;
    }
    this.announceUnconfigured(adoption);
  }

  /**
   * One-time migration of `VAPID_*` environment keys into the panel store, and
   * THE ONLY READER of those three variables left in the product.
   *
   * Deliberately copies the key material instead of generating a new pair.
   * Every `WebPushSubscription` row out there was created by a browser against
   * the OLD public key; a new pair does not re-bind them, it strands them, and
   * they only come back when each subscriber's browser re-subscribes. Copying
   * keeps every one of them working across the upgrade, which is the whole
   * reason this runs at all rather than just refusing the env path.
   *
   * Runs at most once per deployment, not once per boot. `webPushEnvAdoptedAt`
   * records that the migration happened, and it is checked BEFORE the keys are
   * read, because the panel store being empty is not proof the migration is
   * still owed: an operator who clicks "Remove keys" empties it deliberately.
   * Without the marker the next container restart would re-adopt the `.env`
   * pair and turn push back on behind them — an operator action silently
   * undone by a restart, which is worse than the fallback this replaced.
   *
   * Both containers run this (`worker.ts` loads the full `AppModule`), so two
   * processes can race here on the same boot. The re-read inside the
   * transaction is what makes that safe, and the loser reports `adopted`
   * because the panel does now hold keys — which is the only thing the caller
   * is asking about.
   */
  private async adoptLegacyEnvKeys(): Promise<LegacyEnvAdoption> {
    // Environment first, deliberately: on a deployment that never used the
    // `.env` route — which is now every new one — this returns without going
    // near the database, so the migration costs nothing on every boot forever.
    const publicKey = (process.env.VAPID_PUBLIC_KEY ?? '').trim();
    const privateKey = (process.env.VAPID_PRIVATE_KEY ?? '').trim();
    const contactEmail = (process.env.VAPID_CONTACT_EMAIL ?? '').trim();
    if (publicKey.length === 0 || privateKey.length === 0) {
      return { outcome: 'absent' };
    }
    const settings = await this.prismaService.settings.findFirst({ orderBy: { id: 'asc' } });
    if (settings !== null && readJsonObject(settings.systemNotifications).webPushEnvAdoptedAt) {
      return { outcome: 'already-migrated' };
    }
    const cryptKey = this.applicationConfiguration?.cryptKey;
    if (cryptKey === undefined || cryptKey === null || cryptKey.length === 0) {
      return {
        outcome: 'failed',
        reason:
          'REZEIS_CRYPT_KEY is unset, so the private key cannot be encrypted at rest. ' +
          'Set REZEIS_CRYPT_KEY and restart to complete the migration.',
      };
    }
    if (settings === null) {
      return {
        outcome: 'failed',
        reason:
          'no settings row exists yet to move them into. Restart once the panel has been ' +
          'initialised, or generate a fresh keypair in Settings → Web-push.',
      };
    }
    try {
      return await this.prismaService.$transaction(async (tx): Promise<LegacyEnvAdoption> => {
        // Re-read inside the transaction. Settings is a singleton JSON column
        // that several features share (`botTokenEnc`, telegram delivery, the
        // notification toggles); a stale copy written back wholesale would
        // drop whichever of them changed since. Spreading the row we just read
        // preserves every sibling key — the same shape `persistWebPush` uses.
        const existing = await tx.settings.findFirst({ orderBy: { id: 'asc' } });
        if (existing === null) {
          return { outcome: 'failed', reason: 'the settings row disappeared mid-migration' };
        }
        const nextSystemNotifications = readJsonObject(existing.systemNotifications);
        if (nextSystemNotifications.webPushEnvAdoptedAt) {
          return { outcome: 'already-migrated' };
        }
        if (readJsonObject(nextSystemNotifications.webPush).publicKey !== undefined) {
          // Someone configured the panel between our read and this write.
          // Theirs wins: it is the newer intent, and overwriting it would
          // strand the subscriptions their key already has. Push is on, which
          // is what the caller needs to know.
          return { outcome: 'adopted' };
        }
        nextSystemNotifications.webPush = {
          publicKey,
          privateKeyEnc: encryptTotpSecret(privateKey, cryptKey),
          contactEmail: contactEmail.replace(/^mailto:/i, ''),
        };
        nextSystemNotifications.webPushEnvAdoptedAt = new Date().toISOString();
        await tx.settings.update({
          where: { id: existing.id },
          data: { systemNotifications: nextSystemNotifications as Prisma.InputJsonValue },
        });
        return { outcome: 'adopted' };
      });
    } catch (err: unknown) {
      return {
        outcome: 'failed',
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Say — everywhere an operator actually looks — that web-push cannot deliver.
   *
   * Two severities, because the two states need different reactions:
   *
   *   - `failed` — the three `VAPID_*` variables ARE set and could not be
   *     moved into the panel. Until the `.env` fallback was removed this state
   *     still delivered push, so an operator upgrading into it sees push stop
   *     while every sign they have (the variables are right there in `.env`)
   *     says it should work. ERROR.
   *   - anything else — no keys anywhere, or the migration already ran and the
   *     operator has since cleared the panel entry on purpose. Push being off
   *     is a legitimate configuration. WARNING.
   *
   * Emitted on every boot, from both the api and the worker container, and
   * that duplication is deliberate: this is the one signal standing between a
   * dead push channel and nobody noticing, and a boot is a rare enough event
   * that two audit rows cost nothing. Do not "de-duplicate" it into silence.
   */
  private announceUnconfigured(adoption: LegacyEnvAdoption): void {
    const stranded = adoption.outcome === 'failed';
    const reason = stranded ? adoption.reason.replace(/\.?$/, '.') : '';
    const message = stranded
      ? `Web-push is DISABLED: VAPID keys are set in the environment but could not be migrated ` +
        `into the panel — ${reason} The environment variables are no longer read at ` +
        `send time, so every push is a no-op until this succeeds or you generate a keypair in ` +
        `Settings → Web-push (which invalidates existing browser subscriptions).`
      : 'Web-push is DISABLED: no VAPID keypair is configured. Generate one in the admin panel ' +
        '(Settings → Web-push). Until then every web-push send is a no-op.';
    if (stranded) this.logger.error(message);
    else this.logger.warn(message);
    this.systemEvents?.emit({
      type: EVENT_TYPES.SYSTEM_WEB_PUSH_UNCONFIGURED,
      category: 'SYSTEM',
      severity: stranded ? 'ERROR' : 'WARNING',
      message,
      metadata: {
        legacyEnvKeysStranded: stranded,
        adoption: adoption.outcome,
        ...(adoption.outcome === 'failed' ? { reason: adoption.reason } : {}),
      },
    });
  }

  /** True when a VAPID keypair resolves, i.e. web-push can deliver at all. */
  public async isConfigured(): Promise<boolean> {
    return (await this.settingsService.getDecryptedWebPushConfig()) !== null;
  }

  /**
   * How many browsers this user has bound. Zero means a web-push send is a
   * guaranteed no-op — the fact an operator needs BEFORE choosing the channel,
   * not after the send silently did nothing.
   */
  public async countSubscriptions(userId: string): Promise<number> {
    return this.prismaService.webPushSubscription.count({ where: { userId } });
  }

  /**
   * Returns the active VAPID public key for the SPA to use during
   * subscription. Empty string when push is disabled — the SPA must hide
   * its push opt-in UI in that case. Panel-managed keys are the only source.
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
   * `ensurePushSubscription()` once per session on every sign-in (the call in
   * `reiwa/web/src/components/layout/stealth-layout.tsx`), so the row
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
  public async sendToUser(input: SendInput): Promise<WebPushSendResult> {
    const vapidDetails = await this.resolveVapidDetails();
    if (vapidDetails === null) {
      return { attempted: 0, delivered: 0, failed: 0, disabled: true };
    }
    const subs = await this.prismaService.webPushSubscription.findMany({
      where: { userId: input.userId },
    });
    if (subs.length === 0) {
      return { attempted: 0, delivered: 0, failed: 0, disabled: false };
    }
    const payload = JSON.stringify({
      title: input.title,
      body: input.body,
      url: input.url ?? '/dashboard',
    });
    const outcomes = await Promise.all(
      subs.map((sub) => this.deliverOne(sub, payload, vapidDetails)),
    );
    const delivered = outcomes.filter((ok) => ok).length;
    return {
      attempted: subs.length,
      delivered,
      failed: subs.length - delivered,
      disabled: false,
    };
  }

  // ── Admin-scoped push (panel operators) ───────────────────────────────────

  /**
   * Bind the calling admin's own browser to a push subscription row.
   *
   * Every write here is scoped to the caller, and that is the whole point.
   * The previous `upsert({ where: { endpoint } })` was not: `endpoint` is
   * globally `@unique` on `AdminWebPushSubscription` in `prisma/schema.prisma`
   * (the ADMIN table — `WebPushSubscription` is the subscriber one and carries
   * its own separate `endpoint @unique`), so its update branch
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
   * A unique violation is one of THREE things, and the row itself — never the
   * caller's claim — decides which:
   *
   *   a. our own concurrent request won the insert (two tabs re-subscribing at
   *      once). Not a conflict: refresh and report success.
   *   b. another admin holds the endpoint. Refused, 409, logged with both ids,
   *      and refused ONCE — see the bound below.
   *   c. the blocking row has already gone by the time we read it back (an
   *      unsubscribe or a fanout prune landing in the same window). Nothing is
   *      wrong and nothing is held: the write is simply played again.
   *
   * (c) used to be refused with the SAME 409 as (b), and the two were told
   * apart in the log but not on the wire. The SPA reads 409 on this route as
   * "another admin holds this browser" (`web/src/lib/push.ts` — and it could
   * read it no other way), so a transient race told the operator their own
   * browser belonged to somebody else, left the toggle off, and hid the one
   * fact that mattered: a retry would have worked.
   *
   * So (c) retries, HERE, bounded by {@link ADMIN_SUBSCRIBE_ATTEMPTS}, and
   * normally succeeds on the next pass with no error reaching anybody. Two
   * separate things keep that from becoming a loop, and the second is the one
   * worth stating:
   *
   *   - the attempt budget is a constant, so even endless churn terminates;
   *   - the retry is reachable from ONE branch — the read-back found NO ROW AT
   *     ALL. A genuinely held endpoint is a row that is present and foreign,
   *     and that leaves the loop on the spot. No retry can ever be spent
   *     pressing a refusal that will not move.
   *
   * Only a budget exhausted entirely on (c) refuses, and then with
   * {@link ENDPOINT_RACE_UNSETTLED_CODE} rather than (b)'s sentence, so the
   * client can say "try again" instead of naming an owner that does not exist.
   *
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
    for (let attempt = 1; attempt <= WebPushService.ADMIN_SUBSCRIBE_ATTEMPTS; attempt += 1) {
      // Re-read on every pass, not just the first. A retry follows a window in
      // which rows appeared and vanished, and one of the things that may have
      // appeared is the caller's OWN row — inserted by their second tab while
      // this request was losing its race.
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
        if (incumbent === null) {
          // The blocking row disappeared between our failed INSERT and this
          // read (an unsubscribe, or the fanout pruning it). Nobody holds this
          // endpoint, so there is nothing to refuse: play the write again.
          // This is the ONLY branch that continues the loop, which is what
          // makes the bound safe — see the note above the method.
          this.logger.warn(
            `WebPush(admin): subscribe for admin ${input.adminId} lost an insert race to a row ` +
              `that no longer exists (attempt ${attempt} of ${WebPushService.ADMIN_SUBSCRIBE_ATTEMPTS})`,
          );
          continue;
        }
        if (incumbent.adminId === input.adminId) {
          // Our own row, inserted by a concurrent request in the window between
          // the scoped `updateMany` above and this `create`. Re-subscribing the
          // same browser twice is not a conflict: refresh and report success.
          return (await this.refreshOwnAdminSubscription(input)) ?? { id: incumbent.id };
        }
        // Present, and somebody else's. Refused on the first sight of it: this
        // is the state no retry can improve, and pressing it again would only
        // spend the budget saying the same thing three times.
        this.logger.warn(
          `WebPush(admin): refused subscribe for admin ${input.adminId} — endpoint is bound to ` +
            `admin ${incumbent.adminId} (subscription ${incumbent.id})`,
        );
        throw new ConflictException(WebPushService.ENDPOINT_HELD_BY_ANOTHER_ADMIN);
      }
    }

    // Every attempt collided, and every read-back found the collision already
    // gone. Refused with its own code so the client says "try again" instead of
    // naming an owner that, on the evidence, does not exist.
    this.logger.warn(
      `WebPush(admin): subscribe for admin ${input.adminId} gave up after ` +
        `${WebPushService.ADMIN_SUBSCRIBE_ATTEMPTS} attempts — every insert race was lost to a ` +
        `row that had already gone`,
    );
    throw new ConflictException({
      code: WebPushService.ENDPOINT_RACE_UNSETTLED_CODE,
      message: WebPushService.ENDPOINT_RACE_UNSETTLED_MESSAGE,
    });
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
  ): Promise<boolean> {
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
      return true;
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
        return false;
      }
      // Transient — bump counter, evict if we hit the threshold.
      const next = sub.failureCount + 1;
      if (next >= WebPushService.MAX_FAILURES) {
        await this.prismaService.webPushSubscription.delete({ where: { id: sub.id } });
        this.logger.warn(`WebPush: evicted ${sub.id} after ${next} consecutive failures`);
        return false;
      }
      await this.prismaService.webPushSubscription.update({
        where: { id: sub.id },
        data: { failureCount: next },
      });
      this.logger.warn(
        `WebPush: send failed for ${sub.id} (${status ?? 'unknown'}), failureCount=${next}`,
      );
      return false;
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
