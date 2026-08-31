/**
 * SystemEventsService
 * ───────────────────
 * Central event bus for rezeis-admin. Every significant action in the system
 * emits an event through this service. Events are:
 *
 *   1. Persisted to `AdminAuditLog` (always) — queryable from admin UI.
 *   2. Delivered via webhook (when WEBHOOK_ENABLED=true) — signed HTTP POST
 *      to configured URL(s) with HMAC-SHA256 signature.
 *   3. Logged to stdout (always) — for container log aggregation.
 *
 * Event categories:
 *   - USER: registration, block, delete, role change
 *   - AUTH: web login, web register, telegram link, password change
 *   - SUBSCRIPTION: created, renewed, upgraded, expired, deleted, synced
 *   - PAYMENT: checkout created, completed, failed, webhook received
 *   - REFERRAL: attached, qualified, reward issued
 *   - PARTNER: created, earning, withdrawal request/approve/reject
 *   - PROMOCODE: activated, created, depleted
 *   - SYSTEM: startup, backup, broadcast, error
 *
 * Donor parity: altshop `notification_service.system_notify()` sends events
 * to DEV users via Telegram. We replace that with webhook + audit log since
 * rezeis-admin has no bot — the admin panel shows events in real-time.
 */

import { createHash } from 'node:crypto';

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { ModuleRef } from '@nestjs/core';
import { firstValueFrom } from 'rxjs';

import { appConfig } from '../config/app.config';
import { webhookConfig } from '../config/webhook.config';
import { readAdminBotToken, readEnvBotToken } from '../utils/admin-bot-token.util';
import { buildWebhookSignature } from '../http/webhook-signature.util';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../../modules/realtime/realtime.gateway';
import {
  resolveTelegramDeliveryTarget,
  isEventTelegramAllowed,
} from './telegram-delivery-target.util';
import {
  buildErrorReportFilename,
  formatErrorEventCardHtml,
  formatErrorReportTxt,
  getRezeisBuildInfo,
  isErrorEvent,
  type ErrorReportEvent,
} from './error-report.util';
import { resolveErrorReportsDir, writeErrorReport } from './error-report-archive.util';
import { BotNotifierClient } from '../../modules/notifications/services/bot-notifier.client';
import { ReiwaRelayQueueService } from '../../modules/notifications/services/reiwa-relay-queue.service';
import type { ReiwaRelayEvent } from '../../modules/notifications/reiwa-relay.constants';
import { isRelayLoopGuardedEvent } from '../../modules/notifications/reiwa-relay.policy';
import { TelegramDirectQueueService } from '../../modules/notifications/services/telegram-direct-queue.service';
import { isTelegramDirectLoopGuardedEvent } from '../../modules/notifications/telegram-direct.constants';

// ── Event Types ─────────────────────────────────────────────────────────────

export type SystemEventCategory =
  | 'USER'
  | 'AUTH'
  | 'SUBSCRIPTION'
  | 'DEVICE'
  | 'PAYMENT'
  | 'REFERRAL'
  | 'PARTNER'
  | 'PROMOCODE'
  | 'SUPPORT'
  | 'FRAUD'
  | 'NODE'
  | 'REMNAWAVE'
  | 'SYSTEM';

export type SystemEventSeverity = 'INFO' | 'WARNING' | 'ERROR';

export interface SystemEventPayload {
  /** Machine-readable event type, e.g. "user.registered", "payment.completed" */
  readonly type: string;
  /** Human-readable category for filtering */
  readonly category: SystemEventCategory;
  /** Severity level */
  readonly severity: SystemEventSeverity;
  /** Short human-readable description */
  readonly message: string;
  /** Structured metadata (user IDs, amounts, plan names, etc.) */
  readonly metadata?: Record<string, unknown>;
  /** Admin who triggered the event (null for system-initiated) */
  readonly adminId?: string | null;
  /** Timestamp (auto-filled if not provided) */
  readonly timestamp?: string;
}

// ── Predefined Event Types ──────────────────────────────────────────────────

export const EVENT_TYPES = {
  // User
  USER_REGISTERED: 'user.registered',
  USER_WEB_REGISTERED: 'user.web_registered',
  USER_BLOCKED: 'user.blocked',
  USER_UNBLOCKED: 'user.unblocked',
  USER_DELETED: 'user.deleted',
  USER_ROLE_CHANGED: 'user.role_changed',
  USER_TELEGRAM_LINKED: 'user.telegram_linked',
  USER_EMAIL_LINKED: 'user.email_linked',
  USER_ACCOUNTS_MERGED: 'user.accounts_merged',
  USER_FIRST_TRAFFIC: 'user.first_traffic',
  /**
   * An operator moved a customer's points balance by hand
   * (`POST /admin/users/:telegramId/points`). `points` is a SHARED wallet — the
   * referral exchange spends it and quests credit it — so a manual credit or
   * debit is the one movement in it with no automatic record of its own. Its
   * money sibling `partner.balance_adjusted` has always been evented; this one
   * emitted nothing at all, which made an operator debit indistinguishable from
   * a customer spending their own points.
   */
  USER_POINTS_ADJUSTED: 'user.points_adjusted',

  // Auth
  AUTH_WEB_LOGIN: 'auth.web_login',
  AUTH_PASSWORD_CHANGED: 'auth.password_changed',
  AUTH_PASSWORD_RECOVERY: 'auth.password_recovery',

  // Subscription
  SUBSCRIPTION_CREATED: 'subscription.created',
  SUBSCRIPTION_RENEWED: 'subscription.renewed',
  SUBSCRIPTION_UPGRADED: 'subscription.upgraded',
  SUBSCRIPTION_EXPIRED: 'subscription.expired',
  SUBSCRIPTION_DELETED: 'subscription.deleted',
  SUBSCRIPTION_SYNCED: 'subscription.synced',
  SUBSCRIPTION_TRIAL_GRANTED: 'subscription.trial_granted',
  TRIAL_CLAIM_LATE_SUCCESS_OVER_CAP: 'trial.claim_late_success_over_cap',
  SUBSCRIPTION_DEVICE_REVOKED: 'user_hwid_revoked',

  // Payment
  PAYMENT_CHECKOUT_CREATED: 'payment.checkout_created',
  PAYMENT_COMPLETED: 'payment.completed',
  PAYMENT_FAILED: 'payment.failed',
  /**
   * Money given back to the customer. Deliberately NOT `payment.failed`: that
   * type can be bound to a customer email template, and a refund is not a
   * failed payment — the customer would get "your payment did not go through"
   * about their own refund.
   */
  PAYMENT_REFUNDED: 'payment.refunded',
  /** Refund smaller than the captured amount — needs an operator decision. */
  PAYMENT_REFUND_PARTIAL: 'payment.refund_partial',
  /**
   * Money arrived, but not the amount we invoiced — or it is frozen at the
   * provider (Cryptomus/Heleket `wrong_amount` / `locked`, Pally `UNDERPAID`).
   * Deliberately NOT `payment.failed` and NOT `payment.expired`: the buyer did
   * pay and the funds are ours, so neither "платёж не прошёл" nor the routine
   * abandoned-cart expiry describes it. Needs an operator decision.
   */
  PAYMENT_AMOUNT_MISMATCH: 'payment.amount_mismatch',
  /**
   * The provider's own figure for a payment that COMPLETED came in under what
   * we booked. Nothing is held, nothing is withheld, the customer has what they
   * paid for — somebody should still find out why the two records disagree.
   *
   * Its own type rather than `payment.amount_mismatch`, which was the first
   * attempt and does not work: the Telegram card renders the PRESENTATION title
   * for a type, not the per-call message, so an informational note and a payment
   * that is actually held produced visually identical cards — «⚠️ Оплачена
   * неверная сумма» on a payment that went through perfectly normally, with a
   * `needsManualReview: false` line buried in the metadata as the only
   * difference. An operator who cannot tell "this one needs me now" from "this
   * one is a note" without opening it stops opening either.
   */
  PAYMENT_NOTIFIED_AMOUNT_SHORT: 'payment.notified_amount_short',
  PAYMENT_EXPIRED: 'payment.expired',
  PAYMENT_WEBHOOK_RECEIVED: 'payment.webhook_received',
  PAYMENT_FULFILLMENT_RECOVERED: 'payment.fulfillment_recovered',
  PAYMENT_METHOD_SAVED: 'payment.method_saved',
  PAYMENT_METHOD_UNBOUND: 'payment.method_unbound',
  PAYMENT_METHOD_AUTOPAY_UPDATED: 'payment.method_autopay_updated',
  /**
   * An off-session autopay charge stopped for 3DS/redirect and is waiting on
   * the customer. Nobody is at fault and nothing failed yet — but the money
   * does not arrive until the customer acts, so an operator chasing a missing
   * renewal needs to see this rather than infer it from silence.
   */
  PAYMENT_AUTOPAY_CONFIRMATION_REQUIRED: 'payment.autopay_confirmation_required',
  /**
   * A PAID renewal add-on line was captured against a baseline that absorbs it,
   * so as things stand today it will deliver nothing. The customer paid for
   * extra traffic on a subscription that is already unlimited, or extra devices
   * on one that is already uncapped.
   *
   * WHY IT EXISTS. `PaymentSubscriptionMutationService.applyCombinedRenewal`
   * re-asks the eligibility question at CAPTURE time — eligibility itself only
   * ran at QUOTE time, and an operator can lift this one customer's limit to
   * unlimited in between. The deliberate answer there is CAPTURE AND FLAG: the
   * entitlement is created as quoted and the verdict is written into its
   * immutable `applicabilitySnapshot`, because refusing would roll back every
   * subscription on a combined renewal and a recorded no-op would leave a paid
   * line with no durable record at all. That reasoning is right and is NOT
   * revisited here. What it lacked was a reader: the only other trace was a
   * `logger.warn` in a container, which is indistinguishable — from the
   * operator's seat — from a renewal that delivered everything it sold.
   *
   * SEVERITY IS `WARNING`, NOT `ERROR`, and the difference is that this is a
   * PREDICTION rather than a fact. The entitlement is PENDING until
   * `term.startsAt`, days or weeks out; an operator who puts the finite limit
   * back before then makes the line deliver exactly what was sold and nothing
   * was ever wrong. ERROR also routes differently in this file — `isErrorEvent`
   * sends it through `formatErrorEventCardHtml`, the fixed-header incident card
   * with build info and a `.txt` attachment — which is the shape for a fault in
   * the system, not for a commercial fact awaiting a human decision before a
   * known deadline. (The DIRECT-purchase counterpart is different in exactly
   * this respect: it activates at capture, so its answer is a verdict, and
   * `AddOnPurchaseService` refuses at checkout rather than capturing.)
   *
   * VOLUME. It fires PER LINE at capture, and a bulk renewal can carry many, so
   * the emit site is expected to collapse repeats the way
   * `AntiFraudService`'s `NOTIFY_COOLDOWN_MS` does: one card per identical
   * signature per hour, the signature being
   * `subscriptionId + termId + addOn.type`. Not per transaction and not
   * global — an hour of the same operator mistake across one term is one thing
   * to look at, while two different subscriptions are two. An event stream
   * nobody can read is the same as no event.
   */
  PAYMENT_ADDON_ADDS_NOTHING: 'payment.addon_adds_nothing',

  // Referral
  REFERRAL_ATTACHED: 'referral.attached',
  REFERRAL_QUALIFIED: 'referral.qualified',
  REFERRAL_REWARD_ISSUED: 'referral.reward_issued',
  REFERRAL_MANUAL_ATTACHED: 'referral.manual_attached',

  // Partner
  PARTNER_CREATED: 'partner.created',
  PARTNER_ACTIVATED: 'partner.activated',
  PARTNER_DEACTIVATED: 'partner.deactivated',
  PARTNER_EARNING: 'partner.earning',
  PARTNER_WITHDRAWAL_REQUESTED: 'partner.withdrawal_requested',
  PARTNER_WITHDRAWAL_APPROVED: 'partner.withdrawal_approved',
  PARTNER_WITHDRAWAL_REJECTED: 'partner.withdrawal_rejected',
  PARTNER_BALANCE_ADJUSTED: 'partner.balance_adjusted',
  /**
   * A partner was debited for a purchase, fulfillment failed, and the refund
   * to their balance ALSO failed. Deliberately not `partner.balance_adjusted`:
   * nothing was adjusted — the money is gone and only a human can give it
   * back. A retry sweep re-drives it, but the operator is told immediately
   * because the sweep is not guaranteed to succeed either.
   */
  PARTNER_BALANCE_REFUND_FAILED: 'partner.balance_refund_failed',

  // Promocode
  PROMOCODE_ACTIVATED: 'promocode.activated',
  PROMOCODE_CREATED: 'promocode.created',
  PROMOCODE_DEPLETED: 'promocode.depleted',
  PROMOCODE_ARCHIVED: 'promocode.archived',

  // Support
  SUPPORT_TICKET_CREATED: 'support.ticket_created',
  SUPPORT_TICKET_USER_REPLY: 'support.ticket_user_reply',

  // Anti-fraud
  FRAUD_SIGNAL_OPENED: 'fraud.signal_opened',
  FRAUD_CONNECTIONS_DROPPED: 'fraud.connections_dropped',
  /**
   * A detector named a condition and an operator exemption stopped it becoming
   * a signal. Edge-triggered — emitted when the exemption STARTS covering a
   * condition, not on every one of the 288 daily runs that follow. Without it a
   * whitelist is a detector switched off with nobody told.
   */
  FRAUD_CANDIDATE_EXEMPTED: 'fraud.candidate_exempted',
  FRAUD_EXEMPTION_GRANTED: 'fraud.exemption_granted',
  FRAUD_EXEMPTION_REVOKED: 'fraud.exemption_revoked',
  /**
   * A batch of OPEN signals closed themselves because the condition is no
   * longer detected. One summary event per reconciliation run, not one per
   * row — a first deployment can clear a large backlog at once.
   */
  FRAUD_SIGNALS_AUTO_RESOLVED: 'fraud.signals_auto_resolved',
  /** An existing signal's severity was raised by a fresh detection. */
  FRAUD_SIGNAL_ESCALATED: 'fraud.signal_escalated',
  /**
   * The condition still holds but measures lower than the recorded peak.
   * Edge-triggered, so a signal parked at the lower level does not
   * re-announce itself every run.
   */
  FRAUD_SIGNAL_SEVERITY_RECEDED: 'fraud.signal_severity_receded',
  /**
   * An admin moved a fraud signal between statuses.
   *
   * Sits in the Anti-fraud block because the block a constant sits in is how
   * this file expresses category, and its only producer
   * (`AntiFraudService.transitionStatus`) now emits `FRAUD` like every sibling.
   * It spent a while in the System block instead — see the note at that emit
   * site for the two operator-visible defects that came of it.
   */
  FRAUD_SIGNAL_TRANSITIONED: 'fraud.signal_transitioned',

  // Remnawave panel (forwarded webhook events)
  REMNAWAVE_USER_FIRST_CONNECTED: 'remnawave.user.first_connected',
  REMNAWAVE_USER_EXPIRED: 'remnawave.user.expired',
  REMNAWAVE_USER_LIMITED: 'remnawave.user.limited',
  REMNAWAVE_USER_EXPIRE_SOON: 'remnawave.user.expire_soon',
  REMNAWAVE_USER_ENABLED: 'remnawave.user.enabled',
  REMNAWAVE_USER_DISABLED: 'remnawave.user.disabled',
  REMNAWAVE_USER_TRAFFIC_RESET: 'remnawave.user.traffic_reset',
  REMNAWAVE_BANDWIDTH_THRESHOLD: 'remnawave.user.bandwidth_threshold',
  REMNAWAVE_PANEL_STARTED: 'remnawave.panel.started',
  /**
   * Panel-wide device average crossed a band (`RemnawaveDetectors`, polled —
   * the panel has no webhook for it). An infrastructure fact about the whole
   * panel, so it names no customer and is not a fraud signal.
   */
  REMNAWAVE_HWID_AVERAGE_HIGH: 'remnawave.hwid_average_high',

  // Node (forwarded webhook events)
  NODE_CONNECTION_LOST: 'node.connection_lost',
  NODE_CONNECTION_RESTORED: 'node.connection_restored',
  NODE_CREATED: 'node.created',
  NODE_MODIFIED: 'node.modified',
  NODE_ENABLED: 'node.enabled',
  NODE_DISABLED: 'node.disabled',
  NODE_TRAFFIC_NOTIFY: 'node.traffic_notify',
  /**
   * Too much of the online population sits behind one country's nodes
   * (`RemnawaveDetectors`, polled). Same shape as the forwarded node events
   * above — a fact about the fleet, not about anybody using it.
   */
  NODE_GEO_CONCENTRATION: 'node.geo_concentration',

  // System
  SYSTEM_STARTUP: 'system.startup',
  SYSTEM_BACKUP_COMPLETED: 'system.backup_completed',
  /** A database restore finished — the counterpart of `system.backup_completed`. */
  SYSTEM_RESTORE_COMPLETED: 'system.restore_completed',
  SYSTEM_BROADCAST_SENT: 'system.broadcast_sent',
  /** One admin action that touched many users at once (block/unblock/delete/…). */
  SYSTEM_BULK_USERS_EXECUTED: 'system.bulk_users_executed',
  SYSTEM_ERROR: 'system.error',
  /**
   * Boot found no VAPID keypair, so web-push cannot deliver anything.
   *
   * Exists because the `VAPID_*` environment fallback was removed: a
   * deployment that had its keys only in `.env` now resolves nothing, and the
   * previous signal for that was a `logger.warn` — indistinguishable, from the
   * operator's seat, from push working. ERROR when the legacy variables are
   * still set and could not be migrated (push USED to work and just stopped),
   * WARNING when nothing is configured anywhere.
   */
  SYSTEM_WEB_PUSH_UNCONFIGURED: 'system.web_push_unconfigured',
  /** Admin-panel (SPA) runtime error reported back by the browser. */
  CLIENT_ERROR: 'client.error',
  /** Runtime error forwarded from the reiwa bot over the internal channel. */
  REIWA_ERROR: 'reiwa.error',
  /**
   * A signed webhook to reiwa did not deliver and nothing further is coming —
   * the queue exhausted its attempts, or the failure was never transient.
   * Until this existed the only record was a `logger.warn` in an in-memory
   * ring buffer, so a cabinet that stopped accepting relays was invisible.
   */
  REIWA_RELAY_UNDELIVERED: 'reiwa.relay_undelivered',
  /**
   * The panel's OWN Telegram send did not get through and nothing further is
   * coming. Distinct from `reiwa.relay_undelivered` on purpose: they name two
   * different broken things with two different remedies. The relay one means
   * the panel cannot reach the cabinet; this one means the panel reached
   * Telegram and Telegram said no — a revoked token, a chat the bot was
   * removed from, a group that became a supergroup. Collapsing them into one
   * event would put "check the cabinet" and "check Settings → Bot Token"
   * behind the same card.
   */
  TELEGRAM_DIRECT_UNDELIVERED: 'telegram.direct_undelivered',
  /** Broadcast fan-out began; `system.broadcast_sent` is the terminal one. */
  BROADCAST_STARTED: 'broadcast.started',
  BROADCAST_BATCH_COMPLETED: 'broadcast.batch_completed',
  /**
   * The operator asked for a one-shot copy of a broadcast in a Telegram
   * channel and it never entered durable delivery — the relay is not
   * configured, or the queue refused the job.
   *
   * Its own type rather than `system.broadcast_sent`, which it used to borrow.
   * That type's card reads 📢 «Рассылка отправлена», so the operator got a
   * headline claiming a send above a body saying a send did not happen — and
   * every rule, filter and tick-box watching for "broadcast sent" fired in the
   * middle of staging, on a failure. A warning has to be able to say so in its
   * own name.
   */
  BROADCAST_CHANNEL_POST_UNDELIVERED: 'broadcast.channel_post_undelivered',
  IMPORT_COMPLETED: 'import.completed',
  IMPORT_FAILED: 'import.failed',
  IMPORT_PLAN_ASSIGNED: 'import.plan_assigned',
  /**
   * A plan taken out of sale was removed once the last customer left it.
   *
   * A WARNING rather than an info line, and deliberately so: it is the only
   * notice an operator gets that a row disappeared without anybody pressing
   * anything, and a plan vanishing on its own is otherwise indistinguishable
   * from a bug.
   */
  PLAN_RETIRED_REMOVED: 'plan.retired_removed',
  IMPORT_SYNC_ENQUEUED: 'import.sync_enqueued',
  /** An automation rule's "notify Telegram" action fired. */
  AUTOMATION_TELEGRAM_NOTIFY: 'automation.telegram_notify',
  /**
   * Default type of the automations `system_event` action, used whenever the
   * rule's params omit `type`. The action lets the operator write their OWN
   * type string (a capability other rules and webhooks depend on), so most of
   * that action's output stays unregisterable by construction and is covered
   * by `UNREGISTERED_EVENTS_SENTINEL` instead — but the DEFAULT is a fixed,
   * known string, so it gets a real constant, a card and a tick-box like any
   * other producer. Category is whatever the rule passes (SYSTEM by default),
   * which is what picks the forum topic.
   */
  AUTOMATION_CUSTOM: 'automation.custom',
  SETTINGS_EMAIL_UPDATED: 'settings.email.updated',
  NOTIFICATION_TEMPLATE_CREATED: 'notification.template.created',
  NOTIFICATION_TEMPLATE_UPDATED: 'notification.template.updated',
  NOTIFICATION_TEMPLATE_DELETED: 'notification.template.deleted',
  NOTIFICATION_TEMPLATE_SEEDED: 'notification.template.seeded',
  SYSTEM_REMNAWAVE_SYNC: 'system.remnawave_sync',
} as const;

/**
 * The registered types, as a set, for the Telegram delivery gate.
 *
 * This is precisely the set of types an operator can tick: the SPA catalogue in
 * `notifications-page.tsx` is held equal to `Object.values(EVENT_TYPES)` in both
 * directions by `test/system-event-registry.spec.ts`. The gate needs that
 * distinction because the catch-all tick-box may only cover types the operator
 * had no way to tick — a registered type stays exact-match.
 */
export const REGISTERED_EVENT_TYPES: ReadonlySet<string> = new Set<string>(
  Object.values(EVENT_TYPES),
);

// ── Service ─────────────────────────────────────────────────────────────────

export type SystemEventHook = (
  event: SystemEventPayload & { timestamp: string },
) => void | Promise<void>;

@Injectable()
export class SystemEventsService {
  private readonly logger = new Logger(SystemEventsService.name);

  /**
   * Out-of-band subscribers attached at runtime via `registerHook()`.
   * Used by the Phase 6 webhook dispatcher to fan events out to operator-
   * defined endpoints without hard-wiring a circular dependency between
   * SystemEventsModule and WebhooksModule.
   *
   * Hooks are invoked AFTER persistence/realtime/telegram delivery so a
   * misbehaving hook can never block the primary event pipeline. They
   * are wrapped in try/catch + setImmediate, so any throw is caught and
   * never propagates back to the emit() caller.
   */
  private readonly hooks: SystemEventHook[] = [];

  /**
   * Lazily-resolved realtime gateway.
   *
   * We deliberately avoid declaring `RealtimeGateway` as a constructor
   * dependency to prevent a hard import cycle:
   *   realtime.module → JwtModule → AuthModule → SystemEventsModule
   *                                                        ↑
   *                                              this would close the loop
   *
   * Instead we resolve the gateway through `ModuleRef` on first use. If
   * the module is not yet registered (e.g. worker runtime), the lookup
   * returns `null` and broadcast is silently skipped.
   */
  private realtimeGateway: RealtimeGateway | null = null;
  private realtimeGatewayResolved = false;

  /**
   * Lazily-resolved reiwa bot notifier — same `ModuleRef` escape hatch as the
   * realtime gateway to avoid a hard module cycle. Used for the automatic
   * dev-fallback (`reiwa.dev.notify`): when no operator group/topic is
   * configured, system events are routed to the reiwa bot's `BOT_DEV_ID`.
   */
  private botNotifier: BotNotifierClient | null = null;
  private botNotifierResolved = false;

  /**
   * Lazily-resolved durable relay producer — same `ModuleRef` escape hatch.
   * `null` in runtimes where `ReiwaRelayModule` is not registered, in which
   * case delivery falls back to the direct single-attempt client.
   */
  private relayQueue: ReiwaRelayQueueService | null = null;
  private relayQueueResolved = false;
  private telegramDirectQueue: TelegramDirectQueueService | null = null;
  private telegramDirectQueueResolved = false;

  public constructor(
    private readonly prismaService: PrismaService,
    @Inject(webhookConfig.KEY)
    private readonly webhookConfiguration: ConfigType<typeof webhookConfig>,
    @Optional()
    private readonly httpService?: HttpService,
    @Optional()
    private readonly moduleRef?: ModuleRef,
    /**
     * Source of `REZEIS_CRYPT_KEY`, which is what turns the stored
     * `botTokenEnc` ciphertext back into a token this service can send with.
     *
     * `@Optional()` and LAST in the list for the same reason `httpService`
     * and `moduleRef` are: a dozen specs construct this service positionally,
     * and a required parameter anywhere but the tail breaks every one of
     * them. DI always supplies it — `appConfig` is loaded globally in
     * `AppModule`.
     */
    @Optional()
    @Inject(appConfig.KEY)
    private readonly applicationConfiguration?: ConfigType<typeof appConfig>,
  ) {}

  /**
   * Emit a system event. This is the single entry point for all events.
   * Fire-and-forget — never throws, never blocks the caller.
   */
  public emit(event: SystemEventPayload): void {
    const enrichedEvent = {
      ...event,
      timestamp: event.timestamp ?? new Date().toISOString(),
    };

    // 1. Log to stdout
    this.logEvent(enrichedEvent);

    // 2. Persist to audit log (async, non-blocking)
    this.persistEvent(enrichedEvent).catch((err) => {
      this.logger.error(`Failed to persist event ${event.type}: ${(err as Error).message}`);
    });

    // 3. Deliver via webhook (async, non-blocking)
    if (this.webhookConfiguration.enabled && this.webhookConfiguration.urls.length > 0) {
      this.deliverWebhook(enrichedEvent).catch((err) => {
        this.logger.error(`Webhook delivery failed for ${event.type}: ${(err as Error).message}`);
      });
    }

    // 4. Deliver to Telegram group (async, non-blocking)
    this.deliverTelegram(enrichedEvent).catch((err) => {
      this.logger.error(`Telegram delivery failed for ${event.type}: ${(err as Error).message}`);
    });

    // 4b. Auto-archive ERROR reports to disk when mode=auto (async, non-blocking)
    this.archiveErrorReport(enrichedEvent).catch((err) => {
      this.logger.warn(`Error-report archive failed for ${event.type}: ${(err as Error).message}`);
    });

    // 5. Push over WebSocket to connected admin clients (sync — no I/O)
    this.deliverRealtime(enrichedEvent);

    // 6. Out-of-band hooks (Phase 6 webhook dispatcher, future plugins).
    //    Each hook runs in its own microtask so a slow/buggy receiver
    //    never blocks the primary pipeline.
    if (this.hooks.length > 0) {
      const hooksSnapshot = [...this.hooks];
      setImmediate(() => {
        for (const hook of hooksSnapshot) {
          try {
            const result = hook(enrichedEvent);
            if (result && typeof (result as Promise<unknown>).catch === 'function') {
              (result as Promise<unknown>).catch((err) => {
                this.logger.warn(`SystemEvents hook rejected: ${(err as Error).message}`);
              });
            }
          } catch (err) {
            this.logger.warn(`SystemEvents hook threw: ${(err as Error).message}`);
          }
        }
      });
    }
  }

  /**
   * Registers an out-of-band hook called once per emitted event AFTER
   * the built-in delivery pipeline. The hook is invoked asynchronously
   * (via `setImmediate`) and any throw / rejection is swallowed —
   * downstream hooks must not be able to break primary event delivery.
   *
   * Returns an unregister function for tests / module teardown.
   */
  public registerHook(hook: SystemEventHook): () => void {
    this.hooks.push(hook);
    return () => {
      const index = this.hooks.indexOf(hook);
      if (index !== -1) this.hooks.splice(index, 1);
    };
  }

  /**
   * Convenience: emit an INFO event.
   */
  public info(
    type: string,
    category: SystemEventCategory,
    message: string,
    metadata?: Record<string, unknown>,
  ): void {
    this.emit({ type, category, severity: 'INFO', message, metadata });
  }

  /**
   * Convenience: emit a WARNING event.
   */
  public warn(
    type: string,
    category: SystemEventCategory,
    message: string,
    metadata?: Record<string, unknown>,
  ): void {
    this.emit({ type, category, severity: 'WARNING', message, metadata });
  }

  /**
   * Convenience: emit an ERROR event.
   */
  public error(
    type: string,
    category: SystemEventCategory,
    message: string,
    metadata?: Record<string, unknown>,
  ): void {
    this.emit({ type, category, severity: 'ERROR', message, metadata });
  }

  /**
   * Sends a one-off test card through the SAME Telegram delivery pipeline a
   * real event uses — so it honours category→topic routing, the operator
   * group, the reiwa relay (no local bot token), and the dev-DM fallback.
   * Returns where it was routed so the UI can tell the operator. The event is
   * NOT persisted to the audit log / realtime stream (delivery-only).
   */
  public async sendTelegramTest(input: {
    readonly category: SystemEventCategory;
    readonly note: string | null;
    readonly adminId: string;
  }): Promise<{ readonly via: 'primary' | 'dev' | 'none' }> {
    const tgConfig = await this.loadTelegramConfig();
    const note = input.note?.trim();
    const event: SystemEventPayload & { timestamp: string } = {
      type: 'settings.telegram.test',
      category: input.category,
      severity: 'INFO',
      message: `Тестовое сообщение Rezeis (${input.category})${note ? ` — ${note}` : ''}`,
      metadata: { adminId: input.adminId },
      timestamp: new Date().toISOString(),
    };
    const resolved = resolveTelegramDeliveryTarget(tgConfig, event);
    const via: 'primary' | 'dev' | 'none' =
      resolved === null ? 'none' : resolved.isDevFallback ? 'dev' : 'primary';
    // `synchronous` — the operator is looking at a spinner. See the branch in
    // `deliverTelegram`.
    await this.deliverTelegram(event, { synchronous: true });
    return { via };
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private logEvent(event: SystemEventPayload & { timestamp: string }): void {
    const prefix = `[${event.severity}] [${event.category}]`;
    const msg = `${prefix} ${event.type}: ${event.message}`;
    switch (event.severity) {
      case 'ERROR':
        this.logger.error(msg);
        break;
      case 'WARNING':
        this.logger.warn(msg);
        break;
      default:
        this.logger.log(msg);
    }
  }

  private async persistEvent(event: SystemEventPayload & { timestamp: string }): Promise<void> {
    await this.prismaService.adminAuditLog.create({
      data: {
        action: `event.${event.type}`,
        ipAddress: 'system',
        userAgent: 'rezeis-admin/system-events',
        metadata: {
          category: event.category,
          severity: event.severity,
          message: event.message,
          timestamp: event.timestamp,
          ...(event.metadata ?? {}),
        },
        adminUserId: event.adminId ?? null,
      },
    });
  }

  private async deliverWebhook(event: SystemEventPayload & { timestamp: string }): Promise<void> {
    if (!this.httpService) return;

    const payload = JSON.stringify({
      event: event.type,
      category: event.category,
      severity: event.severity,
      message: event.message,
      metadata: event.metadata ?? {},
      timestamp: event.timestamp,
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Rezeis-Event': event.type,
    };

    // Unified signature: `X-Rezeis-Signature: t=<sec>,v1=<hmac>` over
    // `<t>.<body>` — the same scheme as the per-subscription dispatcher and
    // the reiwa webhook receiver, so any consumer verifies one way.
    const secret = this.webhookConfiguration.secretHeader;
    if (secret) {
      const { header, timestamp } = buildWebhookSignature({ secret, body: payload });
      headers['X-Rezeis-Signature'] = header;
      headers['X-Rezeis-Timestamp'] = String(timestamp);
    }

    for (const url of this.webhookConfiguration.urls) {
      try {
        await firstValueFrom(
          this.httpService.post(url, payload, {
            headers,
            timeout: 10_000,
          }),
        );
      } catch (err) {
        // A MISCONFIGURATION IS NOT AN OUTAGE, and the two must not be logged
        // the same way.
        //
        // This dispatcher runs on EVERY system event. When `WEBHOOK_URL`
        // points at reiwa the failure is permanent — reiwa has no generic
        // /webhook route and will not grow one between two events — so the
        // same three-sentence hint repeated per event does not inform anyone;
        // it buries the events it was meant to sit beside, and an operator
        // reading the log finds the hint everywhere and the reason nowhere.
        // Said once per URL per process: a restart says it again, which is
        // exactly when somebody is looking at the log.
        //
        // A REAL external consumer keeps warning on every failure. That one
        // is transient by nature, and suppressing it would hide an outage.
        if (this.isLikelyReiwaUrl(url)) {
          if (this.reportedReiwaWebhookUrls.has(url)) continue;
          this.reportedReiwaWebhookUrls.add(url);
          this.logger.warn(
            `Webhook to ${url} failed: ${(err as Error).message}` +
              ' — this URL points at reiwa, which has NO generic /webhook endpoint. ' +
              'The reiwa integration uses REIWA_URL (+ /api/v1/webhooks/rezeis), NOT WEBHOOK_URL. ' +
              'Set WEBHOOK_ENABLED=false or point WEBHOOK_URL at a real external consumer. ' +
              'Reported once per process: this condition does not change on its own.',
          );
          continue;
        }
        this.logger.warn(`Webhook to ${url} failed: ${(err as Error).message}`);
      }
    }
  }

  /**
   * URLs already reported as pointing at reiwa. Not a cache of a result — a
   * record of what the operator has already been told, so the hint above is
   * said once instead of once per system event.
   */
  private readonly reportedReiwaWebhookUrls = new Set<string>();

  /**
   * Heuristic: does a generic-webhook URL actually point at reiwa? Operators
   * sometimes set WEBHOOK_URL to the reiwa domain expecting it to deliver
   * notifications — but that's the relay's job (REIWA_URL). Comparing hosts
   * lets us surface an actionable hint instead of a bare 404.
   */
  private isLikelyReiwaUrl(url: string): boolean {
    const reiwaUrl = (process.env.REIWA_URL ?? '').trim();
    try {
      const target = new URL(url).host.toLowerCase();
      if (reiwaUrl.length > 0) {
        const reiwaHost = new URL(reiwaUrl).host.toLowerCase();
        if (target === reiwaHost) return true;
      }
      return /(^|\.)reiwa\b/.test(target) || /\/webhook$/.test(new URL(url).pathname);
    } catch {
      return false;
    }
  }

  // ── Realtime Delivery ───────────────────────────────────────────────────────

  /**
   * Push the event to every connected admin socket whose subscription set
   * covers the event's category. The realtime gateway is resolved lazily
   * to avoid a circular dependency between SystemEventsModule and
   * RealtimeModule (RealtimeModule depends on JwtModule, which is wired
   * inside AuthModule, which itself emits events through this service).
   */
  private deliverRealtime(event: SystemEventPayload & { timestamp: string }): void {
    const gateway = this.resolveRealtimeGateway();
    if (!gateway) return;
    try {
      gateway.broadcast({
        type: event.type,
        category: event.category,
        severity: event.severity,
        message: event.message,
        metadata: event.metadata,
        timestamp: event.timestamp,
      });
    } catch (err) {
      this.logger.warn(`Realtime broadcast failed: ${(err as Error).message}`);
    }
  }

  private resolveRealtimeGateway(): RealtimeGateway | null {
    if (this.realtimeGatewayResolved) return this.realtimeGateway;
    this.realtimeGatewayResolved = true;
    if (!this.moduleRef) return null;
    try {
      this.realtimeGateway = this.moduleRef.get(RealtimeGateway, { strict: false });
    } catch {
      this.realtimeGateway = null;
    }
    return this.realtimeGateway;
  }

  // ── Telegram Delivery ───────────────────────────────────────────────────────

  /**
   * Sends a formatted HTML message to the configured Telegram group/topic.
   *
   * Settings are read from `Settings.systemNotifications` JSON:
   *   - `telegram.enabled` — master toggle
   *   - `telegram.botToken` — bot token for sending (uses BOT_TOKEN from payments config as fallback)
   *   - `telegram.chatId` — target group/channel chat_id
   *   - `telegram.topicId` — optional message_thread_id for forum topics
   *   - `telegram.events` — array of event types to send (empty = all)
   *
   * Message format matches altshop/STEALTHNET style:
   *   #EventType
   *   ⚙️ Событие: Description!
   *   <blockquote>structured data</blockquote>
   */
  private async deliverTelegram(
    event: SystemEventPayload & { timestamp: string },
    opts: { readonly synchronous?: boolean } = {},
  ): Promise<void> {
    if (!this.httpService) return;

    const tgConfig = await this.loadTelegramConfig();

    // Authoritative event-selection gate. When the operator runs in
    // `selected` mode, only ticked event types reach Telegram — and that
    // applies to EVERY path (operator group, reiwa relay, AND the dev-DM
    // fallback). Unselected events go nowhere on Telegram. The panel still
    // has them (audit log + realtime already ran in emit()).
    //
    // `knownTypes` separates "the operator was offered this and said no" from
    // "the operator was never offered this at all" — only the latter can be
    // covered by the catch-all tick-box.
    if (
      !isEventTelegramAllowed(event.type, {
        eventsMode: tgConfig.eventsMode,
        events: tgConfig.events,
        knownTypes: REGISTERED_EVENT_TYPES,
      })
    ) {
      return;
    }

    // Resolve the user's Telegram id / name / username from `metadata.userId`
    // when the emitter didn't include them, so EVERY event card shows a clear
    // "👤 Пользователь" block (payments, referrals, partner, promocode, …).
    // Centralised here so individual emit sites stay lean. Best-effort.
    const enriched = await this.enrichUserIdentity(event);

    const reportEvent = this.toErrorReportEvent(enriched);
    const errorEvent = isErrorEvent(reportEvent);
    const attachTxt =
      errorEvent && tgConfig.errorReportTelegramTxt && tgConfig.errorReportMode !== 'off';

    const resolved = resolveTelegramDeliveryTarget(tgConfig, enriched);
    if (errorEvent) {
      this.logger.log(
        `Telegram error report route: type=${event.type} target=${
          resolved?.isDevFallback ? 'dev-fallback' : resolved !== null ? 'group' : 'dev-fallback'
        } topic=${resolved?.topicId ?? 'none'} attachment=${attachTxt ? 'document' : 'card-only'}`,
      );
    }
    if (resolved === null) {
      // No operator group AND no manual devChatId configured → automatic
      // dev-fallback: route the event to the reiwa bot's BOT_DEV_ID via the
      // internal channel (the bot knows its dev id; rezeis doesn't). The
      // event filter is intentionally NOT applied — the dev firehose sees all.
      await this.deliverToReiwaDev(enriched, { errorEvent, attachTxt, reportEvent });
      return;
    }

    // Direct send (operator group or manual devChatId) needs a bot token —
    // which on the standard split deployment lives in reiwa, NOT rezeis
    // (rezeis has no BOT_TOKEN). When we can't reach the Bot API directly we
    // must NOT silently drop a dev-fallback event: route it through the reiwa
    // relay instead (its bot delivers to BOT_DEV_ID). This keeps the screen's
    // promise true — "если доставка выключена или не указан Chat ID, события
    // всё равно придут сюда в личку бота. Не потеряются."
    if (!tgConfig.botToken) {
      if (resolved.isDevFallback) {
        await this.deliverToReiwaDev(enriched, { errorEvent, attachTxt, reportEvent });
      } else {
        // Operator group/topic configured but rezeis has no local bot token
        // (split deployment). Route the card through the reiwa relay's
        // broadcast path — the bot owns the token and posts to the exact
        // chat/topic. This is what makes category routing + the test message
        // actually work without a token on rezeis.
        const html = errorEvent
          ? formatErrorEventCardHtml(reportEvent, getRezeisBuildInfo(), attachTxt)
          : this.formatTelegramMessage(enriched);
        await this.deliverViaReiwaBroadcast(enriched, {
          html,
          chatId: resolved.chatId,
          topicId: resolved.topicId,
          attachTxt,
          reportEvent,
        });
      }
      return;
    }
    const targetChatId = resolved.chatId;
    const topicId = resolved.topicId;

    // ERROR events get the richly-sectioned card; everything else keeps the
    // generic event formatter.
    const html = errorEvent
      ? formatErrorEventCardHtml(reportEvent, getRezeisBuildInfo(), attachTxt)
      : this.formatTelegramMessage(enriched);

    // ── Durable, or inline? ────────────────────────────────────────────────
    // The queue is the normal path: it gives a panel-sent card the same four
    // attempts across a restart that the relay gave it, so "the panel sends
    // this itself" does not quietly mean "the panel tries once".
    //
    // Two cases still send inline, and both would be broken BY the queue:
    //
    //  * `synchronous` — the Settings test button. It exists to make an
    //    attempt whose result a human is waiting on; enqueuing would return
    //    "sent" before anything was, and a wrong token would surface a minute
    //    later in the event feed instead of under the button. Same reasoning
    //    `RELAY_DIRECT_DELIVERY_EXCEPTIONS` records for the broadcast test.
    //  * the loop-guarded alert — `telegram.direct_undelivered` is emitted BY
    //    this queue's processor, so queuing it feeds the failure back into the
    //    thing that failed. See `isTelegramDirectLoopGuardedEvent`.
    const queue = opts.synchronous ? null : this.resolveTelegramDirectQueue();
    if (queue !== null && !isTelegramDirectLoopGuardedEvent(event.type)) {
      await queue.enqueue(
        {
          kind: 'message',
          chatId: targetChatId,
          topicId: topicId ?? null,
          text: html,
          parseMode: 'HTML',
          sourceEventType: event.type,
        },
        `sysevt:${clip(event.type, 48)}:${clip(event.timestamp, 32)}`,
      );
      if (attachTxt) {
        // A SECOND job, not a caption, because that is what this path has
        // always produced: the card as its own message and the `.txt` behind
        // it. The relay path collapses them into one captioned document
        // because the cabinet's route takes one call — a difference in the
        // transport, not something to normalise away here, where changing it
        // would change what the operator sees.
        await queue.enqueue(
          {
            kind: 'document',
            chatId: targetChatId,
            topicId: topicId ?? null,
            text: '',
            parseMode: null,
            filename: buildErrorReportFilename(reportEvent),
            content: formatErrorReportTxt(reportEvent, getRezeisBuildInfo()),
            sourceEventType: event.type,
          },
          `sysevt:${clip(event.type, 48)}:${clip(event.timestamp, 32)}:error-report`,
        );
      }
      return;
    }

    const payload: Record<string, unknown> = {
      chat_id: targetChatId,
      text: html,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    };
    if (topicId) {
      payload['message_thread_id'] = topicId;
    }

    try {
      await firstValueFrom(
        this.httpService.post(
          `https://api.telegram.org/bot${tgConfig.botToken}/sendMessage`,
          payload,
          { timeout: 10_000 },
        ),
      );
    } catch (err) {
      this.logger.warn(`Telegram send failed: ${(err as Error).message}`);
    }

    // Attach the .txt error report as a follow-up document when enabled.
    if (attachTxt) {
      await this.sendErrorReportDocument({
        botToken: tgConfig.botToken,
        chatId: targetChatId,
        topicId,
        reportEvent,
      });
    }
  }

  /** Map an emitted system event to the normalized error-report shape. */
  private toErrorReportEvent(event: SystemEventPayload & { timestamp: string }): ErrorReportEvent {
    const meta = event.metadata ?? {};
    return {
      kind: `event.${event.type}`,
      severity: event.severity,
      category: event.category,
      message: event.message,
      timestamp: event.timestamp,
      metadata: meta,
      actor: typeof meta['adminId'] === 'string' ? (meta['adminId'] as string) : null,
    };
  }

  /**
   * Upload the formatted `.txt` error report as a Telegram document to the
   * given chat/topic via the Bot API (`sendDocument`, multipart). Best-effort.
   */
  private async sendErrorReportDocument(input: {
    readonly botToken: string;
    readonly chatId: string;
    readonly topicId: number | null;
    readonly reportEvent: ErrorReportEvent;
  }): Promise<void> {
    try {
      const txt = formatErrorReportTxt(input.reportEvent, getRezeisBuildInfo());
      const filename = buildErrorReportFilename(input.reportEvent);
      const form = new FormData();
      form.append('chat_id', input.chatId);
      if (input.topicId) form.append('message_thread_id', String(input.topicId));
      form.append('document', new Blob([txt], { type: 'text/plain' }), filename);
      const res = await fetch(`https://api.telegram.org/bot${input.botToken}/sendDocument`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        this.logger.warn(`Telegram sendDocument returned ${res.status}`);
      }
    } catch (err) {
      this.logger.warn(`Telegram sendDocument failed: ${(err as Error).message}`);
    }
  }

  /**
   * Formats an event into a Telegram HTML message matching the altshop style.
   */
  /**
   * Lazily resolve the reiwa `BotNotifierClient` through `ModuleRef` (same
   * cycle-avoidance escape hatch as the realtime gateway). Returns `null` when
   * the notifications module isn't registered (e.g. minimal worker runtimes).
   */
  private resolveBotNotifier(): BotNotifierClient | null {
    if (this.botNotifierResolved) return this.botNotifier;
    this.botNotifierResolved = true;
    try {
      this.botNotifier = this.moduleRef?.get(BotNotifierClient, { strict: false }) ?? null;
    } catch {
      this.botNotifier = null;
    }
    return this.botNotifier;
  }

  /** Same lazy `ModuleRef` lookup for the durable relay queue producer. */
  private resolveRelayQueue(): ReiwaRelayQueueService | null {
    if (this.relayQueueResolved) return this.relayQueue;
    this.relayQueueResolved = true;
    try {
      this.relayQueue = this.moduleRef?.get(ReiwaRelayQueueService, { strict: false }) ?? null;
    } catch {
      this.relayQueue = null;
    }
    return this.relayQueue;
  }

  /**
   * And again for the panel's own Telegram queue.
   *
   * `null` in a runtime where `TelegramDirectModule` is not registered — the
   * specs that build this service by hand, and any worker runtime that does
   * not import it. That is not a degraded mode to be alarmed about: the branch
   * below falls back to the single inline send this path used before it was
   * durable, which is strictly what it did yesterday.
   */
  private resolveTelegramDirectQueue(): TelegramDirectQueueService | null {
    if (this.telegramDirectQueueResolved) return this.telegramDirectQueue;
    this.telegramDirectQueueResolved = true;
    try {
      this.telegramDirectQueue =
        this.moduleRef?.get(TelegramDirectQueueService, { strict: false }) ?? null;
    } catch {
      this.telegramDirectQueue = null;
    }
    return this.telegramDirectQueue;
  }

  /**
   * Hand one relay event to the durable queue — except for the one system
   * event that must never enter it.
   *
   * `emit()` fans every event out to Telegram, and the relay processor reports
   * an exhausted job by emitting a system event. Queue that and the failure
   * feeds itself for as long as the cabinet is down: exhausted job -> alert ->
   * new relay job -> exhausted -> alert. So `reiwa.relay_undelivered` keeps
   * the delivery model relays used to have — one direct attempt, outcome
   * logged — which terminates the chain after a single hop. It loses nothing:
   * that event is already in `AdminAuditLog` and on the realtime socket before
   * Telegram is tried at all. See `isRelayLoopGuardedEvent`.
   */
  private async relaySystemEvent(
    systemEventType: string,
    relayEvent: ReiwaRelayEvent,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const queue = this.resolveRelayQueue();
    if (queue !== null && !isRelayLoopGuardedEvent(systemEventType)) {
      await queue.enqueue(relayEvent, metadata);
      return;
    }
    const notifier = this.resolveBotNotifier();
    if (notifier === null) return;
    const outcome = await notifier.deliverRelayEvent(relayEvent, metadata);
    if (outcome.status !== 'confirmed' && outcome.status !== 'unconfirmed') {
      this.logger.warn(
        `Direct relay ${relayEvent} for ${systemEventType} did not deliver: ${outcome.status}`,
      );
    }
  }

  /**
   * Automatic dev-fallback: deliver the event card to the reiwa bot's
   * `BOT_DEV_ID` over the internal channel. Best-effort and a no-op when the
   * notifier isn't wired (no REIWA_URL / WEBHOOK_SECRET_HEADER) — the event
   * still lives in the audit log + realtime stream.
   */
  private async deliverToReiwaDev(
    event: SystemEventPayload & { timestamp: string },
    opts: {
      readonly errorEvent: boolean;
      readonly attachTxt: boolean;
      readonly reportEvent: ErrorReportEvent;
    },
  ): Promise<void> {
    const html = opts.errorEvent
      ? formatErrorEventCardHtml(opts.reportEvent, getRezeisBuildInfo(), opts.attachTxt)
      : this.formatTelegramMessage(event);
    try {
      if (opts.attachTxt) {
        // Single dev-DM message that mirrors the screenshot/operator layout:
        // the full `.txt` report as a document, the sectioned error card as
        // its caption, and a Close button (attached bot-side). The stack
        // trace + raw payload live in the attached .txt, one tap away.
        const txt = formatErrorReportTxt(opts.reportEvent, getRezeisBuildInfo());
        await this.relaySystemEvent(event.type, 'reiwa.dev.notify.document', {
          eventId: buildDevRelayEventId(event, 'dev-document'),
          filename: buildErrorReportFilename(opts.reportEvent),
          content: txt,
          caption: html,
          parseMode: 'HTML',
        });
      } else {
        // Non-error events (or txt attachment disabled): inline card only.
        await this.relaySystemEvent(event.type, 'reiwa.dev.notify', {
          eventId: buildDevRelayEventId(event, 'dev'),
          text: html,
          parseMode: 'HTML',
        });
      }
    } catch (err) {
      this.logger.warn(`Dev-fallback notify failed: ${(err as Error).message}`);
    }
  }

  /**
   * Split-deployment operator delivery through the reiwa bot. Error reports
   * retain both their `.txt` attachment and the configured forum topic, even
   * though Rezeis intentionally does not keep the Telegram bot token.
   */
  private async deliverViaReiwaBroadcast(
    event: SystemEventPayload & { timestamp: string },
    opts: {
      readonly html: string;
      readonly chatId: string;
      readonly topicId: number | null;
      readonly attachTxt: boolean;
      readonly reportEvent: ErrorReportEvent;
    },
  ): Promise<void> {
    if (this.resolveRelayQueue() === null && this.resolveBotNotifier() === null) {
      this.logger.warn(
        `Telegram delivery skipped for ${event.type}: no local bot token and reiwa relay unavailable`,
      );
      return;
    }
    try {
      if (opts.attachTxt) {
        // `eventId` is built from the event's own emit timestamp, not the send
        // time, so every retry of this job carries the same key and the bot's
        // idempotency cache collapses the duplicates.
        //
        // Both parts are clipped for the same reason `buildDevRelayEventId`
        // clips them: the cabinet validates this field with a REQUIRED
        // `.max(128)` and no soft fallback (unlike the dev routes, which use
        // `.catch(undefined)`). An over-long key is a 400, the relay reads a
        // 4xx as non-transient, `ReiwaRelayProcessor` throws
        // `UnrecoverableError` — so the operator card is LOST OUTRIGHT rather
        // than merely undeduplicated, and `reiwa.relay_undelivered` fires in
        // its place. `type` is not a closed set: `ReceiveSystemEventDto`
        // accepts 200 characters and automation rules mint types at runtime,
        // so `7 + 200 + 1 + 24` overflows 128 with room to spare.
        //
        // CLIPPED UNCONDITIONALLY, not only when the key would overflow. The
        // conditional form is tempting because it preserves every key that
        // works today — the budget is 83 characters, so types of 49..83 do
        // currently produce a valid key and this DOES change theirs. Two
        // reasons it is still the wrong trade:
        //
        //   1. A length-conditional branch puts a SECOND key shape in
        //      production and reaches it only on the rare long input — the
        //      branch nobody exercises until the day it matters. That failure
        //      shape has shipped here repeatedly; a single always-taken path
        //      is worth more than the keys it renames.
        //   2. Renaming those keys costs nothing. The key is frozen into the
        //      BullMQ payload at enqueue and replayed verbatim on every
        //      attempt, so a job already queued when this deploys keeps
        //      deduping against itself. Only events emitted AFTER the deploy
        //      get the new shape, and those have nothing to collide with.
        //
        // 48/32 keeps the worst case at 103 characters including the
        // `:error-report` suffix, and matches `buildDevRelayEventId` so this
        // file has one rule rather than two.
        await this.relaySystemEvent(event.type, 'reiwa.channel.broadcast.document', {
          eventId: `sysevt:${clip(event.type, 48)}:${clip(event.timestamp, 32)}:error-report`,
          chatId: opts.chatId,
          topicThreadId: opts.topicId ?? undefined,
          filename: buildErrorReportFilename(opts.reportEvent),
          content: formatErrorReportTxt(opts.reportEvent, getRezeisBuildInfo()),
          caption: opts.html,
          parseMode: 'HTML',
        });
      } else {
        // Clipped for the reason spelt out on the document branch above.
        await this.relaySystemEvent(event.type, 'reiwa.channel.broadcast', {
          eventId: `sysevt:${clip(event.type, 48)}:${clip(event.timestamp, 32)}`,
          chatId: opts.chatId,
          topicThreadId: opts.topicId ?? undefined,
          text: opts.html,
          parseMode: 'HTML',
        });
      }
    } catch (err) {
      this.logger.warn(`Reiwa broadcast relay failed: ${(err as Error).message}`);
    }
  }

  /**
   * Auto-archive: when the operator selected the `auto` error-report mode,
   * write the formatted `.txt` for every new ERROR event into the on-disk
   * archive (`data/error-reports/<date>/`). Best-effort and bounded — never
   * blocks the primary pipeline.
   */
  private async archiveErrorReport(
    event: SystemEventPayload & { timestamp: string },
  ): Promise<void> {
    const reportEvent = this.toErrorReportEvent(event);
    if (!isErrorEvent(reportEvent)) return;
    const tgConfig = await this.loadTelegramConfig();
    if (tgConfig.errorReportMode !== 'auto') return;
    const txt = formatErrorReportTxt(reportEvent, getRezeisBuildInfo());
    const result = await writeErrorReport({
      baseDir: resolveErrorReportsDir(),
      filename: buildErrorReportFilename(reportEvent),
      content: txt,
      timestamp: event.timestamp,
    });
    if (!result.written && result.reason !== 'rate-capped') {
      this.logger.warn(`Error-report archive skipped: ${result.reason}`);
    }
  }

  private formatTelegramMessage(event: SystemEventPayload & { timestamp: string }): string {
    const hashtag = `#${eventTypeToHashtag(event.type)}`;
    const meta = event.metadata ?? {};
    const present = EVENT_PRESENTATION[event.type];
    const emoji = present?.emoji ?? severityEmoji(event.severity);

    const lines: string[] = [hashtag, ''];
    if (present) {
      lines.push(`${emoji} <b>Событие: ${escapeHtml(present.title)}!</b>`);
    } else {
      // No EVENT_PRESENTATION entry — a type chosen at runtime by an
      // automation rule or by the reiwa ingest, which by construction can
      // never be in that map. Two things have to hold for the card to stay
      // readable:
      //
      //   * the header is never empty. `message` is what the fallback header
      //     has always shown, but nothing guarantees it is non-blank —
      //     `ReceiveSystemEventDto.message` has no `@MinLength`, so an empty
      //     string used to render as a bare `<b></b>`;
      //   * the machine type is shown ONCE, in full and as `<code>`. Its only
      //     other appearance is the hashtag, which mangles dots and drops
      //     punctuation, so without this line an operator receiving a card for
      //     a type they do not recognise has no way to find out what fired.
      const message = event.message.trim();
      const headline =
        message.length > 0 ? message : `Событие без описания: ${clip(event.type, 120)}`;
      lines.push(`${emoji} <b>${escapeHtml(clip(headline, 200))}</b>`);
      lines.push(`🏷 Незарегистрированный тип: <code>${escapeHtml(clip(event.type, 120))}</code>`);
    }

    // Fraud block — a dedicated, informative card for anti-fraud signals.
    // Uses `fraud*`-prefixed metadata so it never collides with the generic
    // user/promocode blocks below.
    if (event.category === 'FRAUD' && meta['fraudKind'] !== undefined) {
      lines.push(...formatFraudBlock(meta));
    }

    // Fraud signal lifecycle block — what an operator (or the reconciliation
    // sweep) just did to a signal. `formatFraudBlock` above cannot carry this:
    // it is offender-centric and keys off `fraudKind`, which a status change
    // does not have.
    //
    // Keyed on the status PAIR rather than the event type because that pair has
    // exactly one producer in the codebase (`AntiFraudService.transitionStatus`)
    // and no other emitter puts `previousStatus`/`newStatus` in metadata — so
    // the condition cannot quietly start matching somebody else's card.
    //
    // Not optional decoration: `code` and the two statuses belong to no other
    // block, so without this the card would announce «изменён статус сигнала»
    // and never say which signal, or to what.
    if (meta['previousStatus'] && meta['newStatus']) {
      lines.push('');
      lines.push('🔁 <b>Сигнал:</b>');
      const signalLines: string[] = [];
      if (meta['code']) signalLines.push(`🚦 Код: <code>${escapeHtml(meta['code'])}</code>`);
      signalLines.push(
        `↔️ Статус: ${humanizeFraudSignalStatus(meta['previousStatus'])} → ` +
          `${humanizeFraudSignalStatus(meta['newStatus'])}`,
      );
      if (meta['signalId'])
        signalLines.push(`🆔 Сигнал: <code>${escapeHtml(String(meta['signalId']).slice(0, 12))}</code>`);
      lines.push(`<blockquote>${signalLines.join('\n')}</blockquote>`);
    }

    // User block
    if (meta['userId'] || meta['telegramId']) {
      lines.push('');
      lines.push('👤 <b>Пользователь:</b>');
      const userLines: string[] = [];
      if (meta['telegramId'])
        userLines.push(`🪪 Telegram ID: <code>${escapeHtml(meta['telegramId'])}</code>`);
      if (meta['userId']) userLines.push(`👾 Reiwa ID: <code>${escapeHtml(meta['userId'])}</code>`);
      const displayName = meta['userName'] ?? meta['firstName'];
      if (displayName) {
        const handle = meta['username'] ? ` (@${escapeHtml(meta['username'])})` : '';
        userLines.push(`👤 Имя: ${escapeHtml(displayName)}${handle}`);
      } else if (meta['username']) {
        userLines.push(`👤 Username: @${escapeHtml(meta['username'])}`);
      }
      if (meta['login']) userLines.push(`🔑 Login: <code>${escapeHtml(meta['login'])}</code>`);
      if (meta['email'] && !meta['fraudUserEmail'])
        userLines.push(`📧 Email: ${escapeHtml(meta['email'])}`);
      lines.push(`<blockquote>${userLines.join('\n')}</blockquote>`);
    }

    // Payment block
    if (meta['paymentId'] || meta['amount']) {
      lines.push('');
      lines.push('💰 <b>Платёж:</b>');
      const payLines: string[] = [];
      if (meta['paymentId']) payLines.push(`🆔 ID: <code>${escapeHtml(meta['paymentId'])}</code>`);
      if (meta['gatewayType'])
        payLines.push(`💳 Способ оплаты: ${escapeHtml(meta['gatewayType'])}`);
      if (meta['amount']) payLines.push(`💷 Сумма: ${fmtAmount(meta['amount'], meta['currency'])}`);
      if (meta['purchaseType'])
        payLines.push(`💥 Тип покупки: ${humanizePurchaseType(meta['purchaseType'])}`);
      if (typeof meta['receiptUrl'] === 'string')
        payLines.push(`📃 <a href="${escapeHtml(meta['receiptUrl'])}">Чек</a>`);
      else if (typeof meta['checkoutUrl'] === 'string')
        payLines.push(`🧾 <a href="${escapeHtml(meta['checkoutUrl'])}">Ссылка на оплату</a>`);
      if (meta['paidAt']) payLines.push(`⏰ Оплачено: ${fmtDate(meta['paidAt'])}`);
      lines.push(`<blockquote>${payLines.join('\n')}</blockquote>`);
    }

    // Plan/Subscription block
    if (meta['planName'] || meta['subscriptionId']) {
      lines.push('');
      lines.push('📦 <b>План / подписка:</b>');
      const planLines: string[] = [];
      // Receipt here only when there's no dedicated Payment block above (e.g.
      // a subscription.created without payment metadata) — avoids duplicating.
      if (!meta['paymentId'] && !meta['amount'] && typeof meta['receiptUrl'] === 'string') {
        planLines.push(`📃 <a href="${escapeHtml(meta['receiptUrl'])}">Чек</a>`);
      }
      if (meta['subscriptionId'])
        planLines.push(`🗳 ID: <code>${escapeHtml(meta['subscriptionId'])}</code>`);
      if (meta['planName']) planLines.push(`🏷 План: ${escapeHtml(meta['planName'])}`);
      if (meta['status'] !== undefined)
        planLines.push(`🚦 Статус: ${humanizeSubscriptionStatus(meta['status'])}`);
      if (meta['planType']) planLines.push(`📦 Тип: ${humanizePlanType(meta['planType'])}`);
      else if (meta['purchaseType'])
        planLines.push(`📦 Тип: ${humanizePurchaseType(meta['purchaseType'])}`);
      // Prefer "used / limit" when usage is known (first connect / first traffic
      // cards). Fall back to limit-only for purchase/renewal events.
      if (typeof meta['usedTrafficBytes'] === 'number') {
        const limit =
          typeof meta['trafficLimitBytes'] === 'number' && meta['trafficLimitBytes'] > 0
            ? ` / ${fmtBytes(meta['trafficLimitBytes'])}`
            : '';
        planLines.push(`📊 Трафик: ${fmtBytes(meta['usedTrafficBytes'])}${limit}`);
      } else if (typeof meta['trafficLimitBytes'] === 'number') {
        planLines.push(`📊 Лимит трафика: ${fmtBytes(meta['trafficLimitBytes'])}`);
      }
      if (meta['deviceLimit'] !== undefined)
        planLines.push(`📱 Лимит устройств: ${escapeHtml(meta['deviceLimit'])}`);
      if (meta['durationDays'])
        planLines.push(`⏳ Длительность: ${humanizeDuration(meta['durationDays'])}`);
      if (meta['isTrial'] !== undefined)
        planLines.push(`🎁 Триал: ${meta['isTrial'] ? 'да' : 'нет'}`);
      const expireRaw = meta['expireAt'] ?? meta['expiresAt'];
      if (expireRaw !== undefined && expireRaw !== null) {
        const remaining = fmtRemaining(expireRaw);
        if (remaining) planLines.push(`⏱ Осталось: ${remaining}`);
        planLines.push(`📅 Действует до: ${fmtDate(expireRaw)}`);
      }
      if (meta['source']) planLines.push(`📌 Причина: ${humanizeSource(meta['source'])}`);
      lines.push(`<blockquote>${planLines.join('\n')}</blockquote>`);
    }

    // Remnawave profile block — which panel profile this event refers to.
    // Rendered when the event carries a Remnawave uuid/login and it isn't
    // already covered by the fraud card or the HWID/device block.
    const remnaUuid = meta['remnawaveId'] ?? meta['remnawaveUuid'];
    if ((remnaUuid || meta['remnawaveUsername']) && event.category !== 'FRAUD' && !meta['hwid']) {
      lines.push('');
      lines.push('🌐 <b>Профиль Remnawave:</b>');
      const remnaLines: string[] = [];
      if (meta['remnawaveUsername'])
        remnaLines.push(
          `🃏 Профиль на панели: <code>${escapeHtml(meta['remnawaveUsername'])}</code>`,
        );
      if (remnaUuid) remnaLines.push(`🔹 UUID: <code>${escapeHtml(remnaUuid)}</code>`);
      // When a subscription block already owns usage/limit, skip the duplicate
      // traffic line here so first-connect / first-traffic cards stay clean.
      if (typeof meta['usedTrafficBytes'] === 'number' && !meta['subscriptionId']) {
        const limit =
          typeof meta['trafficLimitBytes'] === 'number' && meta['trafficLimitBytes'] > 0
            ? ` / ${fmtBytes(meta['trafficLimitBytes'])}`
            : '';
        remnaLines.push(`📊 Трафик: ${fmtBytes(meta['usedTrafficBytes'])}${limit}`);
      }
      if (meta['expireAt'] && !meta['planName'] && !meta['subscriptionId'])
        remnaLines.push(`📅 Действует до: ${fmtDate(meta['expireAt'])}`);
      lines.push(`<blockquote>${remnaLines.join('\n')}</blockquote>`);
      const panelUrl = buildRemnawavePanelUrl();
      if (panelUrl)
        lines.push(`🔗 <a href="${escapeHtml(panelUrl)}">Открыть в панели Remnawave</a>`);
    }
    if (meta['filename'] && (event.category === 'SYSTEM' || meta['backupId'])) {
      lines.push('');
      lines.push('🗄 <b>Бэкап:</b>');
      const backupLines: string[] = [];
      backupLines.push(`🗂 Файл: <code>${escapeHtml(meta['filename'])}</code>`);
      if (typeof meta['sizeBytes'] === 'number')
        backupLines.push(`🗃 Размер: ${fmtBytes(meta['sizeBytes'])}`);
      if (meta['scope']) backupLines.push(`📦 Объём: ${escapeHtml(meta['scope'])}`);
      if (typeof meta['checksum'] === 'string')
        backupLines.push(
          `📰 Контрольная сумма: <code>${escapeHtml(meta['checksum'].slice(0, 12))}</code>`,
        );
      if (meta['deliveredToTelegram'] === false)
        backupLines.push('📥 Доставка: только локально (слишком большой)');
      if (meta['initiatedBy'])
        backupLines.push(`👤 Инициатор: <code>${escapeHtml(meta['initiatedBy'])}</code>`);
      lines.push(`<blockquote>${backupLines.join('\n')}</blockquote>`);
    }

    // Node block — infrastructure events forwarded from the Remnawave panel.
    if (meta['nodeName'] || meta['nodeUuid']) {
      lines.push('');
      lines.push('🖥 <b>Нода:</b>');
      const nodeLines: string[] = [];
      if (meta['nodeName']) nodeLines.push(`🎴 Название: ${escapeHtml(meta['nodeName'])}`);
      if (meta['countryCode'])
        nodeLines.push(`🏴 Страна: ${countryCodeToFlag(meta['countryCode'])}`);
      if (meta['nodeAddress'])
        nodeLines.push(`💈 Адрес: <code>${escapeHtml(meta['nodeAddress'])}</code>`);
      if (meta['nodeUuid'])
        nodeLines.push(
          `🔹 UUID: <code>${escapeHtml(String(meta['nodeUuid']).slice(0, 12))}</code>`,
        );
      lines.push(`<blockquote>${nodeLines.join('\n')}</blockquote>`);
    }
    if (meta['partnerId'] || meta['earning']) {
      lines.push('');
      lines.push('🤝 <b>Партнёр:</b>');
      const partnerLines: string[] = [];
      if (meta['partnerId'])
        partnerLines.push(`🗳 ID: <code>${String(meta['partnerId']).slice(0, 12)}</code>`);
      if (meta['level']) partnerLines.push(`🏮 Уровень: ${meta['level']}`);
      if (meta['earning'])
        partnerLines.push(`💴 Начислено: ${(Number(meta['earning']) / 100).toFixed(2)} ₽`);
      if (meta['percent']) partnerLines.push(`🏵 Процент: ${meta['percent']}%`);
      lines.push(`<blockquote>${partnerLines.join('\n')}</blockquote>`);
    }

    // Referral block
    if (meta['referrerId'] || meta['referralId'] || meta['referredUserId']) {
      lines.push('');
      lines.push('🔗 <b>Реферал:</b>');
      const refLines: string[] = [];
      if (meta['referralId']) {
        refLines.push(`🆔 Связь: <code>${escapeHtml(meta['referralId'])}</code>`);
      }
      if (meta['referredUserId']) {
        refLines.push(`👤 Приглашённый:`);
        if (meta['referredTelegramId'])
          refLines.push(
            `   🪪 Telegram ID: <code>${escapeHtml(meta['referredTelegramId'])}</code>`,
          );
        refLines.push(`   👾 Reiwa ID: <code>${escapeHtml(meta['referredUserId'])}</code>`);
        if (meta['referredName']) {
          const h = meta['referredUsername'] ? ` (@${escapeHtml(meta['referredUsername'])})` : '';
          refLines.push(`   👤 Имя: ${escapeHtml(meta['referredName'])}${h}`);
        } else if (meta['referredUsername']) {
          refLines.push(`   👤 Username: @${escapeHtml(meta['referredUsername'])}`);
        }
        if (meta['referredLogin'])
          refLines.push(`   🔑 Login: <code>${escapeHtml(meta['referredLogin'])}</code>`);
      }
      if (meta['referrerId']) {
        refLines.push(`👥 Пригласил:`);
        if (meta['referrerTelegramId'])
          refLines.push(
            `   🪪 Telegram ID: <code>${escapeHtml(meta['referrerTelegramId'])}</code>`,
          );
        refLines.push(`   👾 Reiwa ID: <code>${escapeHtml(meta['referrerId'])}</code>`);
        if (meta['referrerName']) {
          const h = meta['referrerUsername'] ? ` (@${escapeHtml(meta['referrerUsername'])})` : '';
          refLines.push(`   👤 Имя: ${escapeHtml(meta['referrerName'])}${h}`);
        } else if (meta['referrerUsername']) {
          refLines.push(`   👤 Username: @${escapeHtml(meta['referrerUsername'])}`);
        }
        if (meta['referrerLogin'])
          refLines.push(`   🔑 Login: <code>${escapeHtml(meta['referrerLogin'])}</code>`);
      }
      if (meta['rewardType']) {
        const rv = meta['rewardValue'] !== undefined ? `: ${escapeHtml(meta['rewardValue'])}` : '';
        refLines.push(`🎊 Награда: ${humanizeRewardType(meta['rewardType'])}${rv}`);
      }
      if (meta['historicalPaymentsProcessed'] !== undefined)
        refLines.push(`📈 Платежей обработано: ${meta['historicalPaymentsProcessed']}`);
      lines.push(`<blockquote>${refLines.join('\n')}</blockquote>`);
    }

    // Promocode block.
    //
    // Gated on the PROMOCODE category — an allow-list — rather than on "any
    // category except FRAUD", which is what it used to say.
    //
    // The deny-list had exactly one victim, and it is already fixed at its
    // source: `fraud.signal_transitioned` passed category SYSTEM, walked around
    // the single FRAUD exception, and arrived titled «🎟 Промокод: 🎫 Код:
    // NODES_OFFLINE». So this is hardening, not a second repair of that card —
    // with the category corrected it would render right either way.
    //
    // It is worth doing anyway because `code` is a generic key and the deny-list
    // decides by what an event is NOT. `POST /api/internal/events` takes a
    // free-form `type` with any category from the enum and an unconstrained
    // `metadata`, so the next service that names a field `code` is captioned as
    // a coupon until somebody notices and adds a third exception. An allow-list
    // fails the other way: an unknown producer gets no block rather than a wrong
    // one, which is the direction to be wrong in.
    //
    // Nothing that belongs here loses its block: only `promocode.*` emits under
    // PROMOCODE, and `promocode.activated` is the sole producer of
    // `rewardType`/`rewardValue`.
    if ((meta['code'] || meta['promocodeId']) && event.category === 'PROMOCODE') {
      lines.push('');
      lines.push('🎟 <b>Промокод:</b>');
      const promoLines: string[] = [];
      // Escaped like every other interpolation on this card: a promocode is
      // operator-authored free text and this message is sent in HTML mode.
      if (meta['code']) promoLines.push(`🎫 Код: <code>${escapeHtml(meta['code'])}</code>`);
      if (meta['rewardType']) promoLines.push(`💥 Тип награды: ${escapeHtml(meta['rewardType'])}`);
      if (meta['rewardValue']) promoLines.push(`🎊 Значение: ${escapeHtml(meta['rewardValue'])}`);
      lines.push(`<blockquote>${promoLines.join('\n')}</blockquote>`);
    }

    // Device/HWID block
    if (meta['hwid']) {
      lines.push('');
      lines.push('📱 <b>Устройство:</b>');
      const deviceLines: string[] = [];
      deviceLines.push(`🧬 HWID: <code>${meta['hwid']}</code>`);
      if (meta['remainingDevices'] !== undefined)
        deviceLines.push(`📱 Осталось устройств: ${meta['remainingDevices']}`);
      if (meta['planName']) deviceLines.push(`🏷 План: ${escapeHtml(meta['planName'])}`);
      if (meta['subscriptionId'])
        deviceLines.push(
          `🗳 Подписка ID: <code>${String(meta['subscriptionId']).slice(0, 12)}</code>`,
        );
      if (meta['remnawaveId'])
        deviceLines.push(`🌊 Remnawave: <code>${String(meta['remnawaveId']).slice(0, 12)}</code>`);
      lines.push(`<blockquote>${deviceLines.join('\n')}</blockquote>`);
    }

    // Error block
    if (meta['error'] || event.severity === 'ERROR') {
      lines.push('');
      lines.push('⚠️ <b>Ошибка:</b>');
      const errLines: string[] = [];
      if (meta['error']) errLines.push(`💬 Сообщение: ${meta['error']}`);
      if (meta['action']) errLines.push(`🧷 Действие: <code>${meta['action']}</code>`);
      if (meta['attempt']) errLines.push(`🔁 Попытка: ${meta['attempt']}`);
      lines.push(`<blockquote>${errLines.join('\n')}</blockquote>`);
    }

    // Extra block — curated leftover keys that carry useful context but don't
    // belong to any dedicated block above. Each is optional and escaped.
    const extraLines: string[] = [];
    if (meta['reason']) extraLines.push(`📌 Причина: ${humanizeSource(meta['reason'])}`);
    if (meta['note']) extraLines.push(`📝 Заметка: ${escapeHtml(meta['note'])}`);
    if (meta['addOnType']) {
      const val = meta['addOnValue'] !== undefined ? ` ${escapeHtml(meta['addOnValue'])}` : '';
      extraLines.push(`🛒 Докупка: ${escapeHtml(meta['addOnType'])}${val}`);
    }
    if (meta['itemCount'] !== undefined)
      extraLines.push(`🧾 Позиций: ${escapeHtml(meta['itemCount'])}`);
    if (meta['count'] !== undefined) extraLines.push(`🔢 Количество: ${escapeHtml(meta['count'])}`);
    if (meta['recipients'] !== undefined)
      extraLines.push(`👥 Получателей: ${escapeHtml(meta['recipients'])}`);
    if (meta['templateName']) extraLines.push(`🫧 Шаблон: ${escapeHtml(meta['templateName'])}`);
    if (meta['ticketId'])
      extraLines.push(`🚓 Тикет: <code>${String(meta['ticketId']).slice(0, 12)}</code>`);
    if (meta['subject']) extraLines.push(`📨 Тема: ${escapeHtml(meta['subject'])}`);
    if (meta['oldRole'] && meta['newRole'])
      extraLines.push(`🥢 Роль: ${escapeHtml(meta['oldRole'])} → ${escapeHtml(meta['newRole'])}`);
    if (extraLines.length > 0) {
      lines.push('');
      lines.push('🧩 <b>Дополнительно:</b>');
      lines.push(`<blockquote>${extraLines.join('\n')}</blockquote>`);
    }

    // Context block
    lines.push('');
    lines.push('🌀 <b>Контекст:</b>');
    const ctxLines: string[] = [`💠 Категория: ${event.category}`];
    const origin = meta['source'] ?? meta['origin'];
    if (origin) ctxLines.push(`🔎 Источник: ${humanizeSource(origin)}`);
    if (meta['surface']) ctxLines.push(`🌫 Поверхность: ${escapeHtml(meta['surface'])}`);
    if (meta['operation'])
      ctxLines.push(`❄️ Операция: <code>${escapeHtml(meta['operation'])}</code>`);
    ctxLines.push(`🧮 Уровень: ${event.severity}`);
    const channel = meta['channel'] ?? meta['purchaseChannel'];
    if (channel) ctxLines.push(`📣 Канал покупки: ${humanizeChannel(channel)}`);
    ctxLines.push(`⏰ Время: ${new Date(event.timestamp).toLocaleString('ru-RU')}`);
    lines.push(`<blockquote>${ctxLines.join('\n')}</blockquote>`);

    // Build info — which release produced this event. Prefers values carried
    // in metadata (so events relayed from reiwa show reiwa's own build) and
    // falls back to rezeis's image env (APP_VERSION / REZEIS_GIT_SHA /
    // REZEIS_GIT_BRANCH baked by the Dockerfile + CI).
    const fallbackBuild = getRezeisBuildInfo();
    const buildVersion =
      (typeof meta['version'] === 'string' && meta['version']) || fallbackBuild.version;
    const buildCommit =
      (typeof meta['commit'] === 'string' && meta['commit']) || fallbackBuild.commit;
    const buildBranch =
      (typeof meta['branch'] === 'string' && meta['branch']) || fallbackBuild.branch;
    lines.push('');
    lines.push('🏗 <b>Сборка:</b>');
    lines.push(
      `<blockquote>🎯 Версия: <code>${escapeHtml(buildVersion)}</code>\n` +
        `🔩 Коммит: <code>${escapeHtml(String(buildCommit).slice(0, 12))}</code>\n` +
        `⚙️ Ветка: <code>${escapeHtml(buildBranch)}</code></blockquote>`,
    );

    return lines.join('\n');
  }

  /**
   * Best-effort identity enrichment for Telegram cards. From `metadata.userId`
   * it fills any missing `telegramId` / `userName` / `username` / `login` (the
   * last one is rarely carried by emitters). When the event references a
   * referral pair (`referredUserId` — the invited user — and `referrerId` —
   * the inviter), it resolves each side's telegramId / name / username / login
   * into `referred*` / `referrer*` keys so the referral block can render full
   * identities. Note: `referralId` is a Referral RECORD id (not a user id) and
   * is never looked up here. One bounded `findMany`; never throws; the original
   * payload is untouched on failure.
   */
  private async enrichUserIdentity(
    event: SystemEventPayload & { timestamp: string },
  ): Promise<SystemEventPayload & { timestamp: string }> {
    const meta = event.metadata;
    if (!meta) return event;
    const userId = typeof meta['userId'] === 'string' ? meta['userId'] : null;
    const referredUserId =
      typeof meta['referredUserId'] === 'string' ? meta['referredUserId'] : null;
    const referrerId = typeof meta['referrerId'] === 'string' ? meta['referrerId'] : null;

    // Resolve the main user when any of telegramId / name / login is missing
    // (login is almost never carried by emitters, so this now runs for most
    // user-bearing events — one bounded query, best-effort).
    const userNeeds =
      userId !== null &&
      (meta['telegramId'] === undefined ||
        meta['login'] === undefined ||
        (meta['userName'] === undefined && meta['username'] === undefined));
    const referredNeeds =
      referredUserId !== null &&
      meta['referredTelegramId'] === undefined &&
      meta['referredName'] === undefined;
    const referrerNeeds =
      referrerId !== null &&
      meta['referrerTelegramId'] === undefined &&
      meta['referrerName'] === undefined;

    const ids = Array.from(
      new Set(
        [
          userNeeds ? userId : null,
          referredNeeds ? referredUserId : null,
          referrerNeeds ? referrerId : null,
        ].filter((x): x is string => x !== null),
      ),
    );
    if (ids.length === 0) return event;

    try {
      const rows = await this.prismaService.user.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          telegramId: true,
          username: true,
          name: true,
          webAccount: { select: { login: true } },
        },
      });
      const byId = new Map(rows.map((row) => [row.id, row]));
      const merged: Record<string, unknown> = { ...meta };

      if (userNeeds && userId !== null) {
        const u = byId.get(userId);
        if (u) {
          if (u.telegramId !== null && merged['telegramId'] === undefined) {
            merged['telegramId'] = u.telegramId.toString();
          }
          if (u.username && merged['username'] === undefined) merged['username'] = u.username;
          if (u.name && merged['userName'] === undefined) merged['userName'] = u.name;
          if (u.webAccount?.login && merged['login'] === undefined)
            merged['login'] = u.webAccount.login;
        }
      }
      if (referredNeeds && referredUserId !== null) {
        const r = byId.get(referredUserId);
        if (r) {
          if (r.telegramId !== null) merged['referredTelegramId'] = r.telegramId.toString();
          if (r.name) merged['referredName'] = r.name;
          if (r.username) merged['referredUsername'] = r.username;
          if (r.webAccount?.login) merged['referredLogin'] = r.webAccount.login;
        }
      }
      if (referrerNeeds && referrerId !== null) {
        const r = byId.get(referrerId);
        if (r) {
          if (r.telegramId !== null) merged['referrerTelegramId'] = r.telegramId.toString();
          if (r.name) merged['referrerName'] = r.name;
          if (r.username) merged['referrerUsername'] = r.username;
          if (r.webAccount?.login) merged['referrerLogin'] = r.webAccount.login;
        }
      }
      return { ...event, metadata: merged };
    } catch {
      return event;
    }
  }

  /**
   * Whether a Telegram notification for this event type could be delivered.
   *
   * ── Why this is public, and what it is NOT ────────────────────────────────
   *
   * `warn()` is `void` and fire-and-forget on purpose: the event bus must never
   * block or fail the caller that raised the event. That is right, and it left
   * one caller telling a lie. The automations action "notify Telegram" called
   * `warn()` and reported SUCCESS — so an operator whose notifications were
   * switched off, or who had unticked this event type, watched their alerting
   * rule report a clean run on every fire while nothing was ever delivered.
   *
   * This does not promise delivery — nothing can, short of awaiting the Bot
   * API. It answers the narrower question that is actually knowable up front
   * and that covers both silent-death cases: is delivery switched on at all,
   * and does the operator's own event filter let this type through.
   *
   * `null` means "no reason it cannot be delivered", not "it was delivered".
   */
  public async describeTelegramDelivery(
    eventType: string,
  ): Promise<{ readonly deliverable: boolean; readonly reason: string | null }> {
    try {
      const config = await this.loadTelegramConfig();
      if (!config.enabled) {
        return { deliverable: false, reason: 'Telegram notifications are switched off' };
      }
      const allowed = isEventTelegramAllowed(eventType, {
        events: config.events,
        eventsMode: config.eventsMode,
        knownTypes: REGISTERED_EVENT_TYPES,
      });
      if (!allowed) {
        return {
          deliverable: false,
          reason: `"${eventType}" is not ticked in the Telegram notification settings`,
        };
      }
      return { deliverable: true, reason: null };
    } catch {
      // A readiness probe must not be the thing that fails an action. Unknown
      // reads as deliverable: refusing on a settings hiccup would turn a
      // working rule red.
      return { deliverable: true, reason: null };
    }
  }

  private async loadTelegramConfig(): Promise<{
    enabled: boolean;
    botToken: string | null;
    chatId: string | null;
    topicMap: Record<string, number | null>;
    defaultTopicId: number | null;
    errorTopicId: number | null;
    events: string[];
    eventsMode: 'all' | 'selected';
    devChatId: string | null;
    errorReportMode: 'off' | 'manual' | 'auto';
    errorReportTelegramTxt: boolean;
  }> {
    // `orderBy` matches `SettingsService.getSettingsRecord` and
    // `PaymentOpsAlertService.readSettings`. It was absent here, and an
    // unordered `findFirst` picks whatever row the query plan yields — so on
    // a database that ever grew a second `Settings` row this service could
    // read its Telegram config, and now its bot token, from a DIFFERENT row
    // than the one the Bot Token card writes to. One row is the intent; the
    // ordering is what makes every reader agree on which one that is.
    const settings = await this.prismaService.settings.findFirst({
      orderBy: { updatedAt: 'asc' },
      select: { systemNotifications: true },
    });
    if (!settings) {
      return {
        enabled: false,
        botToken: null,
        chatId: null,
        topicMap: {},
        defaultTopicId: null,
        events: [],
        eventsMode: 'all',
        devChatId: null,
        errorReportMode: 'manual',
        errorTopicId: null,
        errorReportTelegramTxt: true,
      };
    }
    const json = settings.systemNotifications as Record<string, unknown>;
    const tg = (json?.telegram ?? {}) as Record<string, unknown>;

    // Per-category topic routing (like STEALTHNET):
    // { "USER": 377, "PAYMENT": 377, "SUPPORT": 187, "SYSTEM": 185 }
    const topics = (tg.topics ?? {}) as Record<string, unknown>;
    const topicMap: Record<string, number | null> = {};
    for (const [key, value] of Object.entries(topics)) {
      topicMap[key.toUpperCase()] = typeof value === 'number' ? value : null;
    }

    const errorReports = (tg.errorReports ?? {}) as Record<string, unknown>;
    const mode = errorReports.mode;

    return {
      enabled: tg.enabled === true,
      // The panel-managed (encrypted) token first, `BOT_TOKEN` second — the
      // same order and the same source as every other Telegram sender here
      // (`BackupService`, `BroadcastMediaUploadService`,
      // `PaymentOpsAlertService`, the settings test buttons).
      //
      // This line used to read `tg.botToken`: a PLAINTEXT key at a path no
      // write path in this tree has ever produced. It was therefore always
      // undefined, the env fallback is unset by policy on this product, and
      // so `deliverTelegram`'s direct branch below was unreachable — every
      // operator card went out through the reiwa bot, not by design but
      // because the panel could not find its own token. See
      // `readAdminBotToken`.
      botToken:
        readAdminBotToken(settings.systemNotifications, this.applicationConfiguration?.cryptKey) ??
        readEnvBotToken(),
      chatId: typeof tg.chatId === 'string' ? tg.chatId : null,
      topicMap,
      defaultTopicId: typeof tg.topicId === 'number' ? tg.topicId : null,
      errorTopicId: typeof tg.errorTopicId === 'number' ? tg.errorTopicId : null,
      events: Array.isArray(tg.events)
        ? tg.events.filter((e): e is string => typeof e === 'string')
        : [],
      eventsMode: tg.eventsMode === 'selected' ? 'selected' : 'all',
      devChatId: typeof tg.devChatId === 'string' && tg.devChatId.length > 0 ? tg.devChatId : null,
      errorReportMode: mode === 'off' || mode === 'auto' ? mode : 'manual',
      errorReportTelegramTxt: errorReports.telegramTxt !== false,
    };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function eventTypeToHashtag(type: string): string {
  // "payment.completed" → "EventPaymentCompleted"
  //
  // The result is interpolated into a `parse_mode: 'HTML'` message, and the
  // event type is NOT always ours: the automations `system_event` action and
  // the reiwa `/internal/events` ingest both choose it at runtime. Characters
  // outside the hashtag alphabet are therefore DROPPED, not escaped — a
  // Telegram hashtag has no use for them, and dropping them removes the only
  // route by which a type string could open a tag and forge card structure
  // (`<b>`, `<blockquote>`, `<a href>`). Every registered type is already
  // `[a-z0-9_.]`, so this is a no-op for them.
  return (
    'Event' +
    type
      .split('.')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join('')
      .replace(/[^A-Za-z0-9_]/g, '')
  );
}

/** Trims a value to `max` characters, marking the cut with an ellipsis. */
function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * The dedup key for the two dev-fallback relays
 * ═════════════════════════════════════════════
 * `reiwa.dev.notify` / `reiwa.dev.notify.document` are `durable`: the queue
 * gives them four attempts because the dev firehose going quiet during an
 * incident is the worst outcome on the list. Retrying an unconfirmed delivery
 * is only safe if the far end can recognise the replay, and the cabinet can —
 * `claimDevEvent(scope, eventId)` in `bot/listeners/internal-http-listener.ts`,
 * scoped per endpoint. It just had nothing to key on, because the panel sent
 * no key. This mints one.
 *
 * Two properties matter, and they pull in opposite directions.
 *
 * MINTED ONCE, IDENTICAL ON EVERY ATTEMPT. This runs at the producer, before
 * `ReiwaRelayQueueService.enqueue`, so the value is frozen into the BullMQ job
 * payload and every retry replays that same payload byte for byte. Nothing in
 * the key reads the clock at SEND time: the timestamp is `event.timestamp`,
 * stamped once by `emit()`. Compute it per attempt instead — the obvious
 * shortcut of `new Date().toISOString()` right here — and every retry would
 * arrive under a fresh key, the cabinet would claim each one as new, and the
 * protection would be decoration.
 *
 * DISTINCT EVENTS MUST NOT COLLIDE. `sysevt:${type}:${timestamp}`, the shape
 * the operator-channel relays next door use, is not enough here. Its whole
 * discriminator is an ISO millisecond, and the firehose's characteristic
 * traffic is a burst of same-type ERROR events from one failing loop — which
 * really can land inside one millisecond. A collision is not a harmless
 * duplicate: `enqueue` derives the BullMQ `jobId` from this key, so the second
 * card would never even be queued, and the bot would swallow it too. The
 * digest closes that: it covers everything that makes the event itself, so two
 * different cards in the same millisecond get different keys, while a genuinely
 * identical card collapses — which is the behaviour you want anyway.
 *
 * Length is bounded ON PURPOSE. The cabinet parses this with
 * `z.string().trim().min(1).max(128)` and `.catch(undefined)`, so an over-long
 * key does not fail loudly — it is silently dropped and the event degrades to
 * exactly the undeduped state this function exists to end. `event.type` is
 * caller-supplied (automation rules and the reiwa ingest both mint types at
 * runtime), so it is clipped; the digest still covers it in full. Worst case:
 * 7 + 49 + 1 + 33 + 1 + 12 + 1 + 16 = 120 characters.
 */
function buildDevRelayEventId(
  event: SystemEventPayload & { timestamp: string },
  route: 'dev' | 'dev-document',
): string {
  let payload: string;
  try {
    payload = JSON.stringify(event.metadata ?? {}) ?? '';
  } catch {
    // A cyclic or BigInt-bearing payload. Falling back to no payload in the
    // digest weakens the discriminator to type+timestamp+card-kind for that
    // one event; throwing here would take down a delivery to protect a key.
    payload = '';
  }
  const digest = createHash('sha256')
    .update(
      [route, event.type, event.timestamp, event.severity, event.category, event.message, payload]
        // NUL cannot occur in any of these, so no combination of field values
        // can be reassembled into a different one with the same joined string.
        .join('\u0000'),
    )
    .digest('hex')
    .slice(0, 16);
  return `sysevt:${clip(event.type, 48)}:${clip(event.timestamp, 32)}:${route}-${digest}`;
}

function severityEmoji(severity: SystemEventSeverity): string {
  switch (severity) {
    case 'ERROR':
      return '🚨';
    case 'WARNING':
      return '⚠️';
    default:
      return '⚙️';
  }
}

/** Minimal HTML escaping for user-supplied values rendered in Telegram HTML. */
function escapeHtml(value: unknown): string {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Renders an ISO 3166-1 alpha-2 country code as a flag emoji + the code
 * (e.g. `DE` → `🇩🇪 DE`). Non-2-letter input is returned escaped as-is.
 */
function countryCodeToFlag(value: unknown): string {
  const cc = String(value).trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return escapeHtml(value);
  const A = 0x1f1e6;
  const base = 'A'.charCodeAt(0);
  const flag = String.fromCodePoint(A + (cc.charCodeAt(0) - base), A + (cc.charCodeAt(1) - base));
  return `${flag} ${cc}`;
}

/**
 * Renders the dedicated anti-fraud block: the sharing metric, the offender's
 * rezeis profile snapshot (or a "Remnawave-only" note when unmapped), the
 * Remnawave uuid, and a deep link to the admin user page so the operator can
 * decide trust-or-block from the message itself.
 */
function formatFraudBlock(meta: Record<string, unknown>): string[] {
  const out: string[] = [];

  const kind = typeof meta['fraudKind'] === 'string' ? (meta['fraudKind'] as string) : null;
  const kindLabel =
    kind === 'ip_sharing'
      ? 'Шеринг по IP'
      : kind === 'hwid_overage'
        ? 'Превышение устройств'
        : 'Сигнал';
  const count = meta['fraudCount'];
  const limit = meta['fraudLimit'];

  out.push('');
  out.push('🚨 <b>Антифрод:</b>');
  const sig: string[] = [`🚓 Тип: ${kindLabel}`];
  if (typeof count === 'number' && typeof limit === 'number') {
    sig.push(`📈 Превышение: ${count} / ${limit}`);
  }
  if (typeof meta['fraudScore'] === 'number') {
    const conf =
      typeof meta['fraudConfidence'] === 'number' ? ` (увер. ${meta['fraudConfidence']}%)` : '';
    sig.push(`🎯 Оценка: ${meta['fraudScore']}${conf}`);
  }
  out.push(`<blockquote>${sig.join('\n')}</blockquote>`);

  out.push('');
  out.push('👤 <b>Нарушитель:</b>');
  const who: string[] = [];
  if (meta['fraudHasRezeisAccount'] === true) {
    if (meta['fraudUserName']) who.push(`👤 Имя: ${escapeHtml(meta['fraudUserName'])}`);
    if (meta['fraudUsername']) who.push(`👤 Username: @${escapeHtml(meta['fraudUsername'])}`);
    if (meta['fraudTelegramId'])
      who.push(`🪪 Telegram ID: <code>${escapeHtml(meta['fraudTelegramId'])}</code>`);
    if (meta['fraudUserEmail']) who.push(`📧 Email: ${escapeHtml(meta['fraudUserEmail'])}`);
    if (meta['fraudUserRole']) who.push(`🥢 Роль: ${escapeHtml(meta['fraudUserRole'])}`);
    if (typeof meta['fraudSubscriptions'] === 'number')
      who.push(`📦 Подписок: ${meta['fraudSubscriptions']}`);
    who.push(`🖥 Web-кабинет: ${meta['fraudHasWebAccount'] === true ? 'да' : 'нет'}`);
    who.push(`🚦 Статус: ${meta['fraudUserBlocked'] === true ? '🔴 заблокирован' : '🟢 активен'}`);
  } else {
    who.push('<i>В rezeis не найден — пользователь есть только в Remnawave</i>');
  }
  if (meta['remnawaveUuid']) {
    who.push(`🌊 Remnawave: <code>${escapeHtml(meta['remnawaveUuid'])}</code>`);
  }
  out.push(`<blockquote>${who.join('\n')}</blockquote>`);

  if (typeof meta['fraudProfileUrl'] === 'string' && meta['fraudProfileUrl'].length > 0) {
    out.push(`🔗 <a href="${escapeHtml(meta['fraudProfileUrl'])}">Открыть профиль в rezeis</a>`);
  }

  return out;
}

// ── Event presentation (emoji + Russian title) ──────────────────────────────

/**
 * Per-event-type presentation: a distinctive emoji and a human Russian title
 * for the card header. Keeps the firehose readable at a glance — every event
 * type gets its own identity instead of a generic severity icon. Falls back to
 * `severityEmoji` + the raw `event.message` when a type isn't mapped here.
 */
export const EVENT_PRESENTATION: Record<string, { emoji: string; title: string }> = {
  // User
  'user.registered': { emoji: '🆕', title: 'Новый пользователь' },
  'user.web_registered': { emoji: '🆕', title: 'Регистрация через сайт' },
  'user.blocked': { emoji: '🔴', title: 'Пользователь заблокирован' },
  'user.unblocked': { emoji: '🟢', title: 'Пользователь разблокирован' },
  'user.deleted': { emoji: '🗑', title: 'Пользователь удалён' },
  'user.role_changed': { emoji: '🛡', title: 'Изменена роль пользователя' },
  'user.telegram_linked': { emoji: '🔗', title: 'Привязан Telegram' },
  'user.email_linked': { emoji: '📧', title: 'Привязан Email' },
  'user.accounts_merged': { emoji: '🧬', title: 'Аккаунты объединены' },
  'user.points_adjusted': { emoji: '🎯', title: 'Изменён баланс баллов' },
  user_hwid_revoked: { emoji: '📱', title: 'Сброшено устройство (HWID)' },

  // Auth
  'auth.web_login': { emoji: '🔑', title: 'Вход в веб-кабинет' },
  'auth.password_changed': { emoji: '🔐', title: 'Изменён пароль' },
  'auth.password_recovery': { emoji: '🔓', title: 'Восстановление пароля' },

  // Subscription
  'subscription.created': { emoji: '✅', title: 'Подписка создана' },
  'subscription.renewed': { emoji: '🔄', title: 'Подписка продлена' },
  'subscription.upgraded': { emoji: '⬆️', title: 'Подписка улучшена' },
  'subscription.expired': { emoji: '⌛', title: 'Подписка истекла' },
  'subscription.deleted': { emoji: '🗑', title: 'Подписка удалена' },
  'subscription.synced': { emoji: '🔄', title: 'Синхронизация подписки' },
  'subscription.trial_granted': { emoji: '🎁', title: 'Выдан триал' },
  // Emitted with category PAYMENT (see the emit site in
  // `PaymentSubscriptionMutationService`), which is why its tick-box lives
  // under «Платежи» even though the constant sits in the Subscription block.
  'trial.claim_late_success_over_cap': {
    emoji: '⏳',
    title: 'Поздняя оплата триала прошла сверх квоты',
  },

  // Payment
  'payment.checkout_created': { emoji: '🧾', title: 'Создан счёт на оплату' },
  'payment.completed': { emoji: '💰', title: 'Платёж получен' },
  'payment.failed': { emoji: '❌', title: 'Платёж не прошёл' },
  'payment.refunded': { emoji: '↩️', title: 'Платёж возвращён' },
  'payment.refund_partial': { emoji: '⚠️', title: 'Частичный возврат платежа' },
  'payment.amount_mismatch': { emoji: '⚠️', title: 'Оплачена неверная сумма' },
  // Reads as a note, not as a task: ℹ️ against the ⚠️ above, and the outcome
  // («Платёж проведён») before the discrepancy. The operator has to be able to
  // skip this one and open the mismatch card without reading either.
  'payment.notified_amount_short': {
    emoji: 'ℹ️',
    title: 'Платёж проведён, но сумма в уведомлении меньше',
  },
  'payment.expired': { emoji: '⌛', title: 'Счёт на оплату истёк' },
  'payment.webhook_received': { emoji: '📩', title: 'Вебхук платёжки' },
  'payment.fulfillment_recovered': { emoji: '🛟', title: 'Восстановлено исполнение платежа' },
  'payment.method_saved': { emoji: '💳', title: 'Сохранён способ оплаты' },
  'payment.method_unbound': { emoji: '🚫', title: 'Отвязан способ оплаты' },
  'payment.method_autopay_updated': { emoji: '🔁', title: 'Изменено автосписание' },
  // Not an error and not a completion: the charge is parked until the customer
  // passes 3DS. Titled as a wait, so it does not read like `payment.failed`.
  'payment.autopay_confirmation_required': {
    emoji: '🔐',
    title: 'Автосписание ждёт подтверждения пользователя',
  },
  // A prediction about a line that is ALREADY PAID, not a failure: the
  // entitlement is PENDING until the renewed term starts, and an operator who
  // restores the finite limit before then makes it deliver what was sold.
  // Titled as the question the operator has to answer — "will this deliver
  // anything?" — rather than as an incident.
  'payment.addon_adds_nothing': {
    emoji: '🫙',
    title: 'Оплаченное дополнение ничего не добавит',
  },

  // Referral
  'referral.attached': { emoji: '🔗', title: 'Реферал привязан' },
  'referral.qualified': { emoji: '⭐', title: 'Реферал подтверждён' },
  'referral.reward_issued': { emoji: '🎉', title: 'Реферальная награда выдана' },
  'referral.manual_attached': { emoji: '🔗', title: 'Реферал привязан вручную' },

  // Partner
  'partner.created': { emoji: '🤝', title: 'Создан партнёр' },
  'partner.activated': { emoji: '🟢', title: 'Партнёр активирован' },
  'partner.deactivated': { emoji: '🔴', title: 'Партнёр деактивирован' },
  'partner.earning': { emoji: '💵', title: 'Партнёрское начисление' },
  'partner.withdrawal_requested': { emoji: '📤', title: 'Запрос на вывод средств' },
  'partner.withdrawal_approved': { emoji: '✅', title: 'Вывод средств одобрен' },
  'partner.withdrawal_rejected': { emoji: '❌', title: 'Вывод средств отклонён' },
  'partner.balance_adjusted': { emoji: '⚖️', title: 'Скорректирован баланс партнёра' },
  'partner.balance_refund_failed': {
    emoji: '🚨',
    title: 'Партнёру не вернулся списанный баланс!',
  },

  // Promocode
  'promocode.activated': { emoji: '🎟', title: 'Промокод активирован' },
  'promocode.created': { emoji: '🎟', title: 'Промокод создан' },
  'promocode.depleted': { emoji: '🚫', title: 'Промокод исчерпан' },
  'promocode.archived': { emoji: '📦', title: 'Промокод архивирован' },

  // Support
  'support.ticket_created': { emoji: '🆘', title: 'Новое обращение в поддержку' },
  'support.ticket_user_reply': { emoji: '💬', title: 'Ответ пользователя в тикете' },

  // Anti-fraud
  'fraud.signal_opened': { emoji: '🚨', title: 'Антифрод: новый сигнал' },
  'fraud.connections_dropped': { emoji: '✂️', title: 'Антифрод: соединения сброшены' },
  'fraud.candidate_exempted': { emoji: '🙈', title: 'Антифрод: находка скрыта исключением' },
  'fraud.exemption_granted': { emoji: '🛡️', title: 'Антифрод: выдано исключение' },
  'fraud.exemption_revoked': { emoji: '↩️', title: 'Антифрод: исключение отозвано' },
  'fraud.signal_escalated': { emoji: '⏫', title: 'Антифрод: сигнал усилился' },
  'fraud.signal_severity_receded': { emoji: '⏬', title: 'Антифрод: сигнал ослаб' },
  'fraud.signals_auto_resolved': { emoji: '🧹', title: 'Антифрод: сигналы закрылись сами' },
  'fraud.signal_transitioned': { emoji: '🔁', title: 'Антифрод: изменён статус сигнала' },

  // System
  'system.startup': { emoji: '🚀', title: 'Запуск системы' },
  'system.backup_completed': { emoji: '🗄', title: 'Резервная копия создана' },
  'system.restore_completed': { emoji: '♻️', title: 'База восстановлена из копии' },
  'system.broadcast_sent': { emoji: '📢', title: 'Рассылка отправлена' },
  'system.bulk_users_executed': { emoji: '👥', title: 'Массовая операция над пользователями' },
  'system.error': { emoji: '🚨', title: 'Системная ошибка' },
  'system.web_push_unconfigured': { emoji: '🔕', title: 'Web-push не настроен' },
  'broadcast.started': { emoji: '📣', title: 'Рассылка запущена' },
  'broadcast.batch_completed': { emoji: '📬', title: 'Партия рассылки отправлена' },
  'broadcast.channel_post_undelivered': { emoji: '📭', title: 'Пост в канал не доставлен' },
  'import.completed': { emoji: '📥', title: 'Импорт завершён' },
  'import.plan_assigned': { emoji: '🏷', title: 'Массовое назначение плана' },
  'plan.retired_removed': { emoji: '🗑', title: 'Тариф удалён: на нём никого не осталось' },
  'import.sync_enqueued': { emoji: '🔄', title: 'Синхронизация после импорта поставлена в очередь' },
  'automation.telegram_notify': { emoji: '🤖', title: 'Автоматизация: уведомление' },
  // The DEFAULT type of the `system_event` action. A rule that names its own
  // type keeps doing so and lands under the catch-all tick-box instead — this
  // entry exists so the common case (no `type` in the action params) reads
  // like every other event rather than like an unregistered one.
  'automation.custom': { emoji: '🤖', title: 'Автоматизация: своё событие' },
  // These three never reach `formatTelegramMessage` today: `isErrorEvent`
  // matches ERROR severity OR a kind ending in `.error`, and error events are
  // rendered by `formatErrorEventCardHtml`, which has its own fixed header.
  // Registered anyway so the card follows if the severity or the routing ever
  // changes, and so no type is registered in two lists out of three.
  'import.failed': { emoji: '🚨', title: 'Импорт не удался' },
  'client.error': { emoji: '🖥', title: 'Ошибка в админ-панели' },
  'reiwa.error': { emoji: '🚨', title: 'Ошибка в reiwa' },
  'reiwa.relay_undelivered': { emoji: '📡', title: 'Вебхук в reiwa не доставлен' },
  'telegram.direct_undelivered': { emoji: '📵', title: 'Панель не доставила карточку в Telegram' },
  'system.remnawave_sync': { emoji: '🔄', title: 'Синхронизация с Remnawave' },
  'settings.email.updated': { emoji: '⚙️', title: 'Обновлены настройки почты' },
  'notification.template.created': { emoji: '📝', title: 'Создан шаблон уведомления' },
  'notification.template.updated': { emoji: '📝', title: 'Обновлён шаблон уведомления' },
  'notification.template.deleted': { emoji: '🗑', title: 'Удалён шаблон уведомления' },
  'notification.template.seeded': { emoji: '🌱', title: 'Засеяны шаблоны уведомлений' },

  // User traffic usage (detected from Remnawave webhooks; category USER → topic «Пользователи»).
  'user.first_traffic': { emoji: '📶', title: 'Пользователь начал использовать трафик' },

  // Remnawave panel (forwarded webhook events)
  'remnawave.user.first_connected': { emoji: '🔌', title: 'Первое подключение пользователя' },
  'remnawave.user.expired': { emoji: '⌛', title: 'Профиль истёк (Remnawave)' },
  'remnawave.user.limited': { emoji: '🚧', title: 'Достигнут лимит трафика' },
  'remnawave.user.expire_soon': { emoji: '⏰', title: 'Подписка скоро истекает' },
  'remnawave.user.enabled': { emoji: '🟢', title: 'Профиль включён (Remnawave)' },
  'remnawave.user.disabled': { emoji: '🔴', title: 'Профиль отключён (Remnawave)' },
  'remnawave.user.traffic_reset': { emoji: '♻️', title: 'Сброшен трафик профиля' },
  'remnawave.user.bandwidth_threshold': { emoji: '📊', title: 'Порог трафика достигнут' },
  'remnawave.panel.started': { emoji: '🟢', title: 'Панель Remnawave запущена' },
  'remnawave.hwid_average_high': {
    emoji: '📈',
    title: 'Среднее число устройств на пользователя выросло',
  },

  // Node (forwarded webhook events)
  'node.connection_lost': { emoji: '🔌', title: 'Нода офлайн' },
  'node.connection_restored': { emoji: '✅', title: 'Нода снова онлайн' },
  'node.created': { emoji: '🆕', title: 'Добавлена нода' },
  'node.modified': { emoji: '🛠', title: 'Нода изменена' },
  'node.enabled': { emoji: '🟢', title: 'Нода включена' },
  'node.disabled': { emoji: '🔴', title: 'Нода отключена' },
  'node.traffic_notify': { emoji: '📊', title: 'Уведомление о трафике ноды' },
  'node.geo_concentration': { emoji: '🌍', title: 'Концентрация онлайна в одной стране' },
};

/**
 * Human label for a `FraudSignalStatus`. Unknown input is escaped and returned
 * as-is rather than replaced by a placeholder: a status this function has not
 * been taught is still the truth about the signal, and hiding it behind
 * «неизвестно» would make a new enum value invisible instead of merely
 * untranslated.
 */
function humanizeFraudSignalStatus(value: unknown): string {
  switch (String(value).toUpperCase()) {
    case 'OPEN':
      return 'Открыт';
    case 'ACKNOWLEDGED':
      return 'Принят в работу';
    case 'RESOLVED':
      return 'Решён';
    case 'DISMISSED':
      return 'Отклонён';
    default:
      return escapeHtml(value);
  }
}

/** Human label for a payment/subscription purchase type. */
function humanizePurchaseType(value: unknown): string {
  switch (String(value).toUpperCase()) {
    case 'SUBSCRIPTION':
      return 'Покупка подписки';
    case 'RENEW':
    case 'RENEWAL':
      return 'Продление';
    case 'ADD_ON':
    case 'ADDON':
      return 'Докупка';
    case 'UPGRADE':
      return 'Апгрейд';
    case 'TRIAL':
      return 'Триал';
    default:
      return escapeHtml(value);
  }
}

/** Human label for a referral reward type. */
function humanizeRewardType(value: unknown): string {
  switch (String(value).toUpperCase()) {
    case 'POINTS':
      return 'Баллы';
    case 'EXTRA_DAYS':
      return 'Доп. дни';
    default:
      return escapeHtml(value);
  }
}

/** Human label for a system-action `source` (why an event fired). */
function humanizeSource(value: unknown): string {
  switch (String(value).toUpperCase()) {
    case 'EXPIRED_PROFILE_CLEANUP':
      return 'Очистка истёкших профилей';
    case 'ADMIN_PANEL':
    case 'PANEL':
      return 'Rezeis Админ-панель';
    case 'WEB_CABINET':
    case 'WEB':
      return 'Веб-кабинет';
    case 'BOT':
      return 'Telegram-бот / Mini App';
    case 'API':
      return 'API';
    case 'WORKER':
      return 'Worker';
    case 'SCHEDULER':
    case 'CRON':
      return 'Планировщик';
    case 'REMNAWAVE_SYNC':
      return 'Синхронизация Remnawave';
    case 'PAYMENT_WEBHOOK':
      return 'Вебхук платёжки';
    case 'REMNAWAVE_WEBHOOK':
      return 'Вебхук Remnawave';
    default:
      return escapeHtml(value);
  }
}

/**
 * Tolerant date formatter: ISO/Date-ish values render as `ru-RU` locale
 * date+time; anything else (already-formatted strings, plain labels) is
 * returned escaped as-is so the card never shows "Invalid Date".
 */
function fmtDate(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? escapeHtml(String(value))
      : value.toLocaleString('ru-RU');
  }
  if (typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? escapeHtml(String(value)) : d.toLocaleString('ru-RU');
  }
  if (typeof value === 'string') {
    // Only attempt parsing for ISO-like strings to avoid mangling labels.
    if (/^\d{4}-\d{2}-\d{2}[T\s]/.test(value) || /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const d = new Date(value);
      if (!Number.isNaN(d.getTime())) return d.toLocaleString('ru-RU');
    }
    return escapeHtml(value);
  }
  return escapeHtml(String(value));
}

/** Human-readable byte size (Б/КБ/МБ/ГБ/ТБ); whole numbers drop the decimal. */
function fmtBytes(bytes: unknown): string {
  const n = typeof bytes === 'number' ? bytes : Number(bytes);
  if (!Number.isFinite(n) || n < 0) return escapeHtml(String(bytes));
  if (n < 1024) return `${n} Б`;
  const units = ['КБ', 'МБ', 'ГБ', 'ТБ', 'ПБ'];
  let value = n / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const rounded = Number.isInteger(value) ? String(value) : value.toFixed(1);
  return `${rounded} ${units[unitIndex]}`;
}

// ── Presentation helpers (formatting niceties) ───────────────────────────────

/** Russian pluralization: picks the form for 1 / 2-4 / 5+ (one/few/many). */
function pluralRu(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

/** Money with a currency symbol for fiat (₽/$/€/₴/₸/£), code for the rest. */
function fmtAmount(amount: unknown, currency: unknown): string {
  const amt = escapeHtml(amount);
  const cur = currency ? String(currency).toUpperCase() : '';
  const symbols: Record<string, string> = {
    RUB: '₽',
    USD: '$',
    EUR: '€',
    UAH: '₴',
    KZT: '₸',
    GBP: '£',
  };
  if (cur && symbols[cur]) return `${amt} ${symbols[cur]}`;
  return cur ? `${amt} ${escapeHtml(cur)}` : amt;
}

/** Humanizes a duration in days into months / years / weeks when it divides
 * evenly (30 → "1 месяц", 365 → "1 год"), otherwise plain days. */
function humanizeDuration(value: unknown): string {
  const days = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(days) || days <= 0) return escapeHtml(String(value));
  if (days % 365 === 0) {
    const y = days / 365;
    return `${y} ${pluralRu(y, 'год', 'года', 'лет')}`;
  }
  if (days % 30 === 0) {
    const m = days / 30;
    return `${m} ${pluralRu(m, 'месяц', 'месяца', 'месяцев')}`;
  }
  if (days % 7 === 0) {
    const w = days / 7;
    return `${w} ${pluralRu(w, 'неделя', 'недели', 'недель')}`;
  }
  return `${days} ${pluralRu(days, 'день', 'дня', 'дней')}`;
}

/** Human label for the purchase channel (PurchaseChannel enum). */
function humanizeChannel(value: unknown): string {
  switch (String(value).toUpperCase()) {
    case 'TELEGRAM':
    case 'BOT':
    case 'MINI_APP':
      return 'Bot / Mini App';
    case 'WEB':
      return 'Веб-сайт';
    case 'ADMIN':
    case 'PANEL':
      return 'Админ-панель';
    default:
      return escapeHtml(value);
  }
}

/** Human label for the plan type (PlanType enum). */
function humanizePlanType(value: unknown): string {
  switch (String(value).toUpperCase()) {
    case 'TRAFFIC':
      return 'Трафик';
    case 'DEVICES':
      return 'Устройства';
    case 'BOTH':
      return 'Трафик + устройства';
    default:
      return escapeHtml(value);
  }
}

/** Human label for SubscriptionStatus (and similar panel statuses). */
function humanizeSubscriptionStatus(value: unknown): string {
  switch (String(value).toUpperCase()) {
    case 'ACTIVE':
      return 'Активна';
    case 'DISABLED':
      return 'Отключена';
    case 'LIMITED':
      return 'Ограничена';
    case 'EXPIRED':
      return 'Истекла';
    case 'DELETED':
      return 'Удалена';
    case 'PENDING':
      return 'Ожидает';
    default:
      return escapeHtml(value);
  }
}

/**
 * Relative remaining lifetime from an expire-at value. Returns null when the
 * input is not a parseable future/past timestamp so callers can fall back to
 * the absolute date line alone.
 */
function fmtRemaining(value: unknown): string | null {
  let ms: number | null = null;
  if (value instanceof Date) {
    ms = value.getTime();
  } else if (typeof value === 'number' && Number.isFinite(value)) {
    ms = value;
  } else if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) ms = parsed;
  }
  if (ms === null || Number.isNaN(ms)) return null;

  const diffMs = ms - Date.now();
  if (diffMs <= 0) return 'истекла';

  const totalMinutes = Math.floor(diffMs / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} ${pluralRu(days, 'день', 'дня', 'дней')}`);
  if (hours > 0) parts.push(`${hours} ${pluralRu(hours, 'час', 'часа', 'часов')}`);
  if (minutes > 0 || parts.length === 0) {
    parts.push(`${minutes} ${pluralRu(minutes, 'минута', 'минуты', 'минут')}`);
  }
  return parts.join(' ');
}

/**
 * Builds a link to the Remnawave panel users page when `REMNAWAVE_HOST` is a
 * public domain (contains a dot). Docker-internal service names (no dot) are
 * unreachable from a Telegram client, so we omit the link there and just show
 * the searchable login + uuid.
 */
function buildRemnawavePanelUrl(): string | null {
  const host = (process.env.REMNAWAVE_HOST ?? '').trim();
  if (host.length === 0 || !host.includes('.')) return null;
  return `https://${host}/dashboard/management/users`;
}
