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
import { literalCardText } from '../utils/operator-card-text.util';
import { buildWebhookSignature } from '../http/webhook-signature.util';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../../modules/realtime/realtime.gateway';
// Pure module, no Nest dependencies — see `chain-depth.ts` for why a delivery
// job has to carry an automation hop count.
import { chainDepthMetadata, chainDepthOf } from '../../modules/automations/chain-depth';
import {
  resolveTelegramDeliveryTarget,
  isEventTelegramAllowed,
} from './telegram-delivery-target.util';
import {
  buildErrorReportFilename,
  formatErrorEventCardHtml,
  formatErrorReportTxt,
  formatUserBlockLines,
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
// Read only for the strings their records carry — the repeat count an
// undelivered alert appends to its sentence, and the event id a broadcast's
// channel post is relayed under. Neither module imports anything that leads
// back to this file.
import {
  describeRelayRepeats,
  describeTelegramDirectRepeats,
} from '../../modules/notifications/undelivered-record';
import { BROADCAST_CHANNEL_EVENT_PREFIX } from '../../modules/broadcast/broadcast.constants';
import { readPlatformBranding } from '../../modules/settings/utils/platform-branding.util';

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
  | 'SYSTEM'
  /**
   * Whatever a rule's `system_event` action emits, whatever the rule asks for.
   * Its words are the rule author's, so no surface may take it for one of the
   * panel's own alerts (the admin push titles it after the rule).
   */
  | 'AUTOMATION';

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
  /**
   * Skip the Telegram card for this one emit. Everything else — the audit log,
   * the webhook, the realtime push, the hooks — still happens.
   *
   * For events whose story is told better by another message that is already
   * going out, and would otherwise be told twice in two different places. The
   * backup is the case it exists for: the archive is uploaded as a document
   * with its own caption, and the card duplicated all of it into a second
   * topic, so an operator saw the file in "Бэкапы" and the description of that
   * file in "Система".
   *
   * Set it only when the other message is CERTAIN to be sent. Suppressing a
   * card whose replacement never leaves is silence, and silence about a backup
   * reads exactly like a backup that did not run.
   */
  readonly skipTelegram?: boolean;
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
   * The customer opened the cabinet from an installed app for the first time.
   *
   * Fires once per account, from the same conditional write that stamps
   * `User.pwaInstalledAt`, so a reinstall or a second device does not repeat
   * it. Installation itself is invisible to the page on every platform — the
   * milestone is the first OPEN from the installed app, which is the earliest
   * moment anything can be known.
   */
  USER_PWA_INSTALLED: 'user.pwa_installed',
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
  /**
   * Points cashback for a paid purchase: credited after fulfilment, taken
   * back on a refund, or skipped for a reason the operator can fix (a plan
   * with no price in the default currency, a catalogue row that is gone).
   */
  POINTS_CASHBACK_CREDITED: 'points.cashback_credited',
  POINTS_CASHBACK_REVERSED: 'points.cashback_reversed',
  POINTS_CASHBACK_SKIPPED: 'points.cashback_skipped',

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
  /**
   * «Помощь с подключением» reached its decision about a subscription whose VPN
   * profile verifiably never connected N hours after it was bought (or, with
   * trials switched on, granted). Once per subscription, from the sender in
   * `connect-help-sweep.service.ts`, and only while the automatic help is on.
   * Metadata: `{ userId, subscriptionId, kind, anchorAt, hoursSincePurchase,
   * helpedBy }` — `helpedBy` is the outcome (bot, push, email, banner,
   * opted_out, merged, skipped_template_off).
   */
  SUBSCRIPTION_NOT_CONNECTED: 'subscription.not_connected',
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
  /**
   * A trial's conversion was paid after ANOTHER payment had converted the
   * trial, so it was received and not applied: the operator is to refund it
   * at the provider and record that («Отметить возврат» in the payment's
   * details). Operator-only (`OPERATOR_ONLY_EVENT_TYPES`): not a receipt, not a
   * completed sale — no automation rule, outbound webhook, email or customer
   * toast ever sees it. It used to be raised as `payment.completed`, which
   * every one of those treats as money in and an order fulfilled.
   * Metadata: `{ userId, paymentId, amount, currency, gatewayType, planName,
   * subscriptionId, trialConvertedByPaymentId, note }`. Raised once more, with
   * `paidAfterRefund: true`, when the provider says such a payment is paid again
   * after its refund — the same news as `payment.amount_mismatch` for any other.
   * Raised the same way, with `withheldReason`, for an autopay charge after a
   * refund (`AUTOPAY_AFTER_REFUND`) and, since 24.09.2026, for a renewal or an
   * upgrade paid for a subscription with no end date (`SUBSCRIPTION_IS_LIFETIME`,
   * with `subscriptionId` or a combined renewal's `subscriptionIds`).
   */
  PAYMENT_WITHHELD: 'payment.withheld',
  /**
   * A withheld payment's money went back — recorded by an operator
   * («Отметить возврат») or reported by the provider (a refund notification,
   * in full or in part). Raised INSTEAD of `payment.refunded` /
   * `payment.refund_partial` for such a payment, and operator-only like
   * `payment.withheld`: no sale was ever announced for it, so an integration, a
   * rule or a refund email would hear of a refund of a sale it never saw.
   * Metadata: `payment.refunded`'s, plus `conversionWithheld: true`, and for a
   * partial refund `partial`, `refundedAmount` and `refundedAmountTotal`.
   */
  PAYMENT_WITHHELD_REFUNDED: 'payment.withheld_refunded',
  /**
   * The provider reported a chargeback (or a refund) on an autopay
   * subscription charged several times, and named none of our payments — every
   * charge is the same sum — so the panel could not tell which charge to
   * reverse (`ProviderSubscriptionService.handleChargeback`). Nothing was
   * guessed: the autopay was ended, and the operator is to find the charge at
   * the provider and press «Отметить возврат» on it in the panel, which
   * reverses its commission and cashback (the note says where; the panel
   * files «Мой налог» receipts for ЮKassa payments only, so it has none to
   * cancel for this charge). Operator-only (`OPERATOR_ONLY_EVENT_TYPES`), and
   * delivered to whoever ticked the refund cards (`DELIVERED_WITH`). Metadata:
   * `{ userId, gatewayType, providerSubscriptionId, providerPaymentId,
   * providerStatus, amount, currency, chargeCount, subscriptionId?, note }`.
   */
  PAYMENT_CHARGEBACK_UNMATCHED: 'payment.chargeback_unmatched',
  /**
   * An operator ended a customer's autopay from the user's card, without a
   * refund: a Platega or RollyPay subscription cancelled at the provider, or
   * the ЮKassa autopay switched off on every saved method
   * (`AdminAutopayService`). Operator-only (`OPERATOR_ONLY_EVENT_TYPES`): the
   * customer's own switch is `payment.method_autopay_updated`, and whatever is
   * bound to that would tell the customer they did it. Delivered to whoever
   * ticked that one (`DELIVERED_WITH`). Metadata: `{ userId, gatewayType,
   * providerSubscriptionId?, subscriptionId?, amount?, currency?, note }`.
   */
  PAYMENT_AUTOPAY_STOPPED_BY_OPERATOR: 'payment.autopay_stopped_by_operator',
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

/**
 * Types the panel tells its OPERATOR about and nobody else.
 *
 * Such an event is written to the audit log («Журнал аудита» → «Системные
 * события»), sent as the operator's Telegram card, and pushed to the admin
 * panel's own realtime stream — an open «Платежи» page refreshes on it as on
 * any payment. That is all: the two consumers that ride on the same broadcast
 * skip it (the automation bridge, `AutomationEventBridgeService`, and the
 * payer's projection, `UserRealtimeService`), it is not handed to the
 * out-of-band hooks (outbound webhooks, the email bridge, quests) and not
 * posted to the environment's webhook URLs. The automation event catalogue
 * does not offer it as a trigger either.
 *
 * For money a human has to settle that must not read as anything else to a
 * machine: a withheld payment announced as `payment.completed` went to the
 * payer's receipt template, to every rule and integration bound to a sale, and
 * as "Payment received" to the payer's open cabinet — for a plan never applied.
 *
 * The admin notification centre and its push are hooks too. Neither has a
 * route for this type (nor had one for `payment.completed`); one that wants it
 * must be let through here first.
 */
export const OPERATOR_ONLY_EVENT_TYPES: ReadonlySet<string> = new Set<string>([
  EVENT_TYPES.PAYMENT_WITHHELD,
  EVENT_TYPES.PAYMENT_WITHHELD_REFUNDED,
  // A chargeback the panel could not pin on one payment: the operator finds
  // the charge by hand, and no integration may read it as a refund of anything.
  EVENT_TYPES.PAYMENT_CHARGEBACK_UNMATCHED,
  // An operator's own action. A rule or letter bound to an autopay change
  // would tell the customer they turned it off.
  EVENT_TYPES.PAYMENT_AUTOPAY_STOPPED_BY_OPERATOR,
]);

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
    // The audit log and the operator's card, and nothing any customer-facing
    // or integration consumer acts on — see `OPERATOR_ONLY_EVENT_TYPES`.
    const operatorOnly = OPERATOR_ONLY_EVENT_TYPES.has(event.type);

    // 1. Log to stdout
    this.logEvent(enrichedEvent);

    // 2. Persist to audit log (async, non-blocking)
    this.persistEvent(enrichedEvent).catch((err) => {
      this.logger.error(`Failed to persist event ${event.type}: ${(err as Error).message}`);
    });

    // 3. Deliver via webhook (async, non-blocking)
    if (!operatorOnly && this.webhookConfiguration.enabled && this.webhookConfiguration.urls.length > 0) {
      this.deliverWebhook(enrichedEvent).catch((err) => {
        this.logger.error(`Webhook delivery failed for ${event.type}: ${(err as Error).message}`);
      });
    }

    // 4. Deliver to Telegram group (async, non-blocking)
    //    `skipTelegram` opts one emit out of THIS step alone — see the field.
    if (event.skipTelegram !== true) {
      this.deliverTelegram(enrichedEvent).catch((err) => {
        this.logger.error(`Telegram delivery failed for ${event.type}: ${(err as Error).message}`);
      });
    }

    // 4b. Auto-archive ERROR reports to disk when mode=auto (async, non-blocking)
    this.archiveErrorReport(enrichedEvent).catch((err) => {
      this.logger.warn(`Error-report archive failed for ${event.type}: ${(err as Error).message}`);
    });

    // 5. Push over WebSocket to connected admin clients (sync — no I/O).
    //    An operator-only type too: it is the operator's own panel, and an
    //    open «Платежи» page shows a withheld payment as it shows any other.
    //    The automation rules and the payer's projection ride on this same
    //    broadcast, and both skip an operator-only type themselves
    //    (`AutomationEventBridgeService`, `UserRealtimeService`).
    this.deliverRealtime(enrichedEvent);

    // 6. Out-of-band hooks (Phase 6 webhook dispatcher, future plugins).
    //    Each hook runs in its own microtask so a slow/buggy receiver
    //    never blocks the primary pipeline. Not for an operator-only type:
    //    outbound webhooks and the email bridge are hooks.
    if (!operatorOnly && this.hooks.length > 0) {
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
  }): Promise<{
    readonly via: 'primary' | 'dev' | 'none';
    readonly delivery: TelegramDeliveryResult;
  }> {
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
    //
    // `via` says where the card was ROUTED and is read off configuration
    // alone, so it is `primary` just as readily for a revoked token as for a
    // working one. `delivery` is what actually happened. Reporting only the
    // first is how this button came to answer "sent" no matter what.
    const delivery = await this.deliverTelegram(event, { synchronous: true });
    return { via, delivery };
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
  ): Promise<TelegramDeliveryResult> {
    if (!this.httpService) return { kind: 'muted', reason: 'no-transport' };

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
      return { kind: 'muted', reason: 'not-selected' };
    }

    // Resolve the user's Telegram id / name / username from `metadata.userId`
    // when the emitter didn't include them, so EVERY event card shows a clear
    // "👤 Пользователь" block (payments, referrals, partner, promocode, …).
    // Centralised here so individual emit sites stay lean. Best-effort.
    const enriched = await this.enrichAdminIdentity(await this.enrichUserIdentity(event));

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
    const timeZone = tgConfig.timeZone;
    if (resolved === null) {
      // No operator group AND no manual devChatId configured → automatic
      // dev-fallback: route the event to the reiwa bot's BOT_DEV_ID via the
      // internal channel (the bot knows its dev id; rezeis doesn't). The
      // event filter is intentionally NOT applied — the dev firehose sees all.
      await this.deliverToReiwaDev(enriched, { errorEvent, attachTxt, reportEvent, timeZone });
      return { kind: 'relayed' };
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
        await this.deliverToReiwaDev(enriched, { errorEvent, attachTxt, reportEvent, timeZone });
      } else {
        // Operator group/topic configured but rezeis has no local bot token
        // (split deployment). Route the card through the reiwa relay's
        // broadcast path — the bot owns the token and posts to the exact
        // chat/topic. This is what makes category routing + the test message
        // actually work without a token on rezeis.
        const html = errorEvent
          ? formatErrorEventCardHtml(
              reportEvent,
              getRezeisBuildInfo(),
              attachTxt,
              errorCardHeader(enriched),
            )
          : this.formatTelegramMessage(enriched, timeZone);
        await this.deliverViaReiwaBroadcast(enriched, {
          html,
          chatId: resolved.chatId,
          topicId: resolved.topicId,
          attachTxt,
          reportEvent,
        });
      }
      return { kind: 'relayed' };
    }
    const targetChatId = resolved.chatId;
    const topicId = resolved.topicId;

    // ERROR events get the richly-sectioned card; everything else keeps the
    // generic event formatter.
    const html = errorEvent
      ? formatErrorEventCardHtml(
          reportEvent,
          getRezeisBuildInfo(),
          attachTxt,
          errorCardHeader(enriched),
        )
      : this.formatTelegramMessage(enriched, timeZone);

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
      // The event's automation hop count rides on both jobs, so a card the panel
      // cannot send hands it back on `telegram.direct_undelivered` instead of
      // re-seeding the chain at zero (`TelegramDirectJobData.automationChainDepth`).
      const chainDepth = chainDepthOf(event.metadata);
      const carriedDepth = chainDepth === 0 ? {} : { automationChainDepth: chainDepth };
      await queue.enqueue(
        {
          kind: 'message',
          chatId: targetChatId,
          topicId: topicId ?? null,
          text: clipHtmlCard(html, TELEGRAM_TEXT_LIMIT),
          parseMode: 'HTML',
          sourceEventType: event.type,
          ...carriedDepth,
        },
        buildRelayEventId(event, 'direct'),
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
            ...carriedDepth,
          },
          buildRelayEventId(event, 'direct-document'),
        );
      }
      return { kind: 'queued' };
    }

    const payload: Record<string, unknown> = {
      chat_id: targetChatId,
      text: clipHtmlCard(html, TELEGRAM_TEXT_LIMIT),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    };
    if (topicId) {
      payload['message_thread_id'] = topicId;
    }

    let outcome: TelegramDeliveryResult = { kind: 'sent' };
    try {
      const response = await firstValueFrom(
        this.httpService.post(
          `https://api.telegram.org/bot${tgConfig.botToken}/sendMessage`,
          payload,
          { timeout: 10_000 },
        ),
      );
      // Telegram answers a refusal with a non-2xx and axios throws, so this
      // is belt-and-braces — but a body that says `ok: false` under a 200 is
      // still a card nobody received, and the whole point of returning an
      // outcome is that "sent" means sent.
      const body = (response as { data?: { ok?: unknown; description?: unknown } })?.data;
      if (body !== undefined && body.ok === false) {
        outcome = { kind: 'failed', reason: describeTelegramRefusal(body.description) };
      }
    } catch (err) {
      outcome = { kind: 'failed', reason: describeTelegramError(err) };
    }
    if (outcome.kind === 'failed') {
      this.logger.warn(`Telegram send failed: ${outcome.reason}`);
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
    return outcome;
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
    /**
     * The metadata of the event being relayed, for its automation hop count.
     *
     * ── Why a delivery job carries an automation counter ──────────────────
     *
     * Because losing it here reset the loop guard. A `notify_telegram` action
     * emits a correctly stamped event; that event queues a relay job; the job
     * exhausts its attempts and emits `reiwa.relay_undelivered` — built from
     * scratch, at depth zero. A rule bound to that event (`notify_telegram`
     * on "tell me when the relay breaks" is the obvious one to write) then had
     * a fresh four-hop budget on every generation, and with the cabinet down
     * it never terminated.
     *
     * `isRelayLoopGuardedEvent` exists for this loop shape and does not catch
     * it: it breaks only `reiwa.relay_undelivered` re-queuing ITSELF, and the
     * automation hop launders the event into a different type on the way past.
     */
    sourceMetadata?: Record<string, unknown> | null,
  ): Promise<void> {
    const queue = this.resolveRelayQueue();
    if (queue !== null && !isRelayLoopGuardedEvent(systemEventType)) {
      await queue.enqueue(relayEvent, {
        ...metadata,
        ...chainDepthMetadata(sourceMetadata),
      });
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
      readonly timeZone: string;
    },
  ): Promise<void> {
    const html = opts.errorEvent
      ? formatErrorEventCardHtml(
          opts.reportEvent,
          getRezeisBuildInfo(),
          opts.attachTxt,
          errorCardHeader(event),
        )
      : this.formatTelegramMessage(event, opts.timeZone);
    try {
      if (opts.attachTxt) {
        // Single dev-DM message that mirrors the screenshot/operator layout:
        // the full `.txt` report as a document, the sectioned error card as
        // its caption, and a Close button (attached bot-side). The stack
        // trace + raw payload live in the attached .txt, one tap away.
        const txt = formatErrorReportTxt(opts.reportEvent, getRezeisBuildInfo());
        await this.relaySystemEvent(event.type, 'reiwa.dev.notify.document', {
          eventId: buildRelayEventId(event, 'dev-document'),
          filename: buildErrorReportFilename(opts.reportEvent),
          content: txt,
          caption: clipHtmlCard(html, TELEGRAM_CAPTION_LIMIT),
          parseMode: 'HTML',
        }, event.metadata);
      } else {
        // Non-error events (or txt attachment disabled): inline card only.
        await this.relaySystemEvent(event.type, 'reiwa.dev.notify', {
          eventId: buildRelayEventId(event, 'dev'),
          text: clipHtmlCard(html, TELEGRAM_TEXT_LIMIT),
          parseMode: 'HTML',
        }, event.metadata);
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
          eventId: buildRelayEventId(event, 'relay-document'),
          chatId: opts.chatId,
          topicThreadId: opts.topicId ?? undefined,
          filename: buildErrorReportFilename(opts.reportEvent),
          content: formatErrorReportTxt(opts.reportEvent, getRezeisBuildInfo()),
          caption: clipHtmlCard(opts.html, TELEGRAM_CAPTION_LIMIT),
          parseMode: 'HTML',
        }, event.metadata);
      } else {
        // Clipped for the reason spelt out on the document branch above.
        await this.relaySystemEvent(event.type, 'reiwa.channel.broadcast', {
          eventId: buildRelayEventId(event, 'relay'),
          chatId: opts.chatId,
          topicThreadId: opts.topicId ?? undefined,
          text: clipHtmlCard(opts.html, TELEGRAM_TEXT_LIMIT),
          parseMode: 'HTML',
        }, event.metadata);
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

  private formatTelegramMessage(
    event: SystemEventPayload & { timestamp: string },
    /**
     * The zone every time on the card is written in, and named in. Resolved
     * once per delivery from the operator's platform settings — see
     * `resolveCardTimeZone`.
     */
    timeZone: string = 'UTC',
  ): string {
    const hashtag = `#${eventTypeToHashtag(event.type)}`;
    const meta = event.metadata ?? {};
    const present = EVENT_PRESENTATION[event.type];
    // A producer that shares its type with a different situation wears its own
    // header (`EventPresentation.variants`), and a failure raised under a type
    // whose title announces a success wears the failure header — see
    // `EventPresentation.warning` for why neither type is split.
    const header = present === undefined ? undefined : headerFor(event, present);
    const emoji = header?.emoji ?? severityEmoji(event.severity);

    // The producer's sentence as printed under the title, when it is. Kept so
    // the details block below does not print the same fact a second time.
    let messageShown: string | null = null;
    // Where that line sits, for an operator's text too long to leave the rest
    // of the card room (see the budget at the end of this method).
    let messageLineIndex = -1;
    const rawDetail = typeof meta['detail'] === 'string' ? meta['detail'].trim() : '';
    const lines: string[] = [hashtag, ''];
    if (present !== undefined && header !== undefined) {
      lines.push(`${emoji} <b>Событие: ${escapeHtml(header.title)}!</b>`);
      // The producer's own sentence, directly under the title — ONLY for the
      // types that opt in with `showMessage`: an operator's own text, and the
      // Russian remedy for a card Telegram refused. No block below carries
      // those. Every other type keeps title + blocks: its message is an
      // English log line restating what the blocks say in Russian.
      messageShown = cardMessageLine(event, present, header.title);
      if (messageShown !== null) {
        messageLineIndex = lines.length;
        lines.push(`<blockquote>${sentenceHtml(messageShown, rawDetail)}</blockquote>`);
      }
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

    // User block — the same one the incident card prints.
    const userBlock = formatUserBlockLines(meta);
    if (userBlock !== null) lines.push('', ...userBlock);

    // Payment block
    //
    // `webhookKind` is in the gate, and it has to be. Three of the four
    // notifications «Вебхук платёжки» is raised for carry neither a payment
    // id nor an amount — a card binding moves no money, and the two
    // provider-subscription callbacks name the provider's own ids, not ours.
    // Without this they rendered a card whose entire content was the kind
    // line: an operator could not even tell which gateway it came from.
    if (meta['paymentId'] || meta['amount'] || meta['webhookKind']) {
      lines.push('');
      lines.push('💰 <b>Платёж:</b>');
      const payLines: string[] = [];
      if (meta['paymentId']) payLines.push(`🆔 ID: <code>${escapeHtml(meta['paymentId'])}</code>`);
      if (meta['gatewayType'])
        payLines.push(`💳 Способ оплаты: ${escapeHtml(meta['gatewayType'])}`);
      // The provider's own identifiers, carried by the two subscription
      // callbacks. They are the only handle an operator has on an autopay
      // charge: it has no payment of ours until the reconciliation finds one.
      if (isPresent(meta['providerSubscriptionId']))
        payLines.push(
          `🔁 Подписка у провайдера: <code>${escapeHtml(meta['providerSubscriptionId'])}</code>`,
        );
      if (isPresent(meta['providerPaymentId']))
        payLines.push(
          `🧾 Платёж у провайдера: <code>${escapeHtml(meta['providerPaymentId'])}</code>`,
        );
      if (meta['amount']) payLines.push(`💷 Сумма: ${fmtAmount(meta['amount'], meta['currency'])}`);
      if (meta['purchaseType'])
        payLines.push(`💥 Тип покупки: ${humanizePurchaseType(meta['purchaseType'])}`);
      // What a review card is ABOUT. A held underpayment, a partial refund and
      // a short notification each put their one decisive figure in these keys,
      // and the block printed only the booked sum — so «Оплачена неверная
      // сумма!» arrived over «499.00 ₽» and nothing said how much did arrive.
      // Money in the booked currency, formatted like the booked amount.
      if (isPresent(meta['notifiedAmount']))
        payLines.push(`📨 Сумма в уведомлении: ${fmtAmount(meta['notifiedAmount'], meta['currency'])}`);
      if (isPresent(meta['refundedAmount']))
        payLines.push(`↩️ Возвращено сейчас: ${fmtAmount(meta['refundedAmount'], meta['currency'])}`);
      if (isPresent(meta['refundedAmountTotal']))
        payLines.push(
          `↩️ Возвращено всего: ${fmtAmount(meta['refundedAmountTotal'], meta['currency'])}`,
        );
      if (isPresent(meta['notificationClaimedStatus']))
        payLines.push(`📨 Статус в уведомлении: <code>${escapeHtml(meta['notificationClaimedStatus'])}</code>`);
      if (isPresent(meta['providerStatus']))
        payLines.push(`📡 Статус у провайдера: <code>${escapeHtml(meta['providerStatus'])}</code>`);
      if (isPresent(meta['verificationReason']))
        payLines.push(`🛡 Проверка у провайдера: ${humanizeVerificationReason(meta['verificationReason'])}`);
      if (typeof meta['receiptUrl'] === 'string')
        payLines.push(`📃 <a href="${escapeAttr(meta['receiptUrl'])}">Чек</a>`);
      else if (typeof meta['checkoutUrl'] === 'string')
        payLines.push(`🧾 <a href="${escapeAttr(meta['checkoutUrl'])}">Ссылка на оплату</a>`);
      if (meta['paidAt']) payLines.push(`⏰ Оплачено: ${fmtDate(meta['paidAt'], timeZone)}`);
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
        planLines.push(`📃 <a href="${escapeAttr(meta['receiptUrl'])}">Чек</a>`);
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
      // «Подписка улучшена»: the days the old plan's paid remainder added on
      // top of the term bought, which is why «Действует до» is later than the
      // duration alone says. Only when there were some.
      if (typeof meta['paidRemainderDays'] === 'number' && meta['paidRemainderDays'] > 0)
        planLines.push(`📥 Остаток прежнего тарифа: +${meta['paidRemainderDays']} дн.`);
      // «Подписка продлена» by a renewal priced for the plan an upgrade left:
      // what it was priced for, and the days its money bought on this plan.
      // None at all renewed nothing (status and expiry unchanged), and the
      // payment card says so and what to do.
      if (
        typeof meta['renewalPricedForPlan'] === 'string' &&
        typeof meta['renewalPricedDays'] === 'number' &&
        typeof meta['renewalConvertedDays'] === 'number'
      )
        planLines.push(
          `📥 Оплачено по цене «${escapeHtml(meta['renewalPricedForPlan'])}» за ${meta['renewalPricedDays']} дн. — ` +
            (meta['renewalConvertedDays'] > 0
              ? `на этом тарифе это +${meta['renewalConvertedDays']} дн.`
              : 'на этом тарифе это 0 дн.: срок не продлён, деньги нужно вернуть.'),
        );
      // A renewal or an upgrade that met a subscription with no end date: it
      // changed nothing, and the money is to go back — the whole payment on
      // «Платёж получен, но не применён», a combined renewal's line on «Платёж
      // получен, нужна проверка». The note names the subscription and where
      // the refund is made.
      if (meta['lifetimeRenewalNotApplied'] === true)
        planLines.push('♾ Продление бессрочной подписки не применено: деньги за него нужно вернуть.');
      if (meta['lifetimeUpgradeNotApplied'] === true)
        planLines.push('♾ Смена тарифа бессрочной подписки не применена: деньги за неё нужно вернуть.');
      if (meta['isTrial'] !== undefined)
        planLines.push(`🎁 Триал: ${meta['isTrial'] ? 'да' : 'нет'}`);
      const expireRaw = meta['expireAt'] ?? meta['expiresAt'];
      if (expireRaw !== undefined && expireRaw !== null) {
        const remaining = fmtRemaining(expireRaw);
        if (remaining) planLines.push(`⏱ Осталось: ${remaining}`);
        planLines.push(`📅 Действует до: ${fmtDate(expireRaw, timeZone)}`);
      }
      if (meta['source']) planLines.push(`📌 Причина: ${humanizeSource(meta['source'])}`);
      lines.push(`<blockquote>${planLines.join('\n')}</blockquote>`);
    }

    // Remnawave profile block — which panel profile this event refers to.
    // Rendered when the event carries a Remnawave uuid/login and it isn't
    // already covered by the fraud card or the HWID/device block.
    const remnaUuid = meta['remnawaveId'] ?? meta['remnawaveUuid'];
    // The sync jobs name the profile under the key their own code uses — and
    // for a profile left live on the panel, the name IS what the operator has
    // to go and find there.
    const remnaUsername =
      meta['remnawaveUsername'] ??
      (event.type === EVENT_TYPES.SYSTEM_REMNAWAVE_SYNC
        ? (meta['remnawavePanelUsername'] ?? meta['panelUsername'])
        : undefined);
    if ((remnaUuid || remnaUsername) && event.category !== 'FRAUD' && !meta['hwid']) {
      lines.push('');
      lines.push('🌐 <b>Профиль Remnawave:</b>');
      const remnaLines: string[] = [];
      if (remnaUsername)
        remnaLines.push(`🃏 Профиль на панели: <code>${escapeHtml(remnaUsername)}</code>`);
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
        remnaLines.push(`📅 Действует до: ${fmtDate(meta['expireAt'], timeZone)}`);
      lines.push(`<blockquote>${remnaLines.join('\n')}</blockquote>`);
      const panelUrl = buildRemnawavePanelUrl();
      if (panelUrl)
        lines.push(`🔗 <a href="${escapeAttr(panelUrl)}">Открыть в панели Remnawave</a>`);
    }
    // Set when the backup block below has already said why the file is not in
    // Telegram, so the details block does not repeat the raw status under it.
    let backupDeliveryShown = false;
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
      if (meta['deliveredToTelegram'] === false) {
        // Four producers raise this flag and the line used to name one reason
        // — «слишком большой» — for all of them, so a relay that never
        // confirmed, a missing crypt key and a retention sweep that deleted the
        // only copy all read as an oversized file.
        backupLines.push(`📥 Доставка: ${describeBackupDelivery(meta)}`);
        backupDeliveryShown = true;
      }
      // A restore's one outcome that matters beyond "done" (`BackupProcessor`):
      // whether the schema was brought forward to this build. It used to be
      // said only in the English sentence under the title.
      if (typeof meta['migrationsApplied'] === 'boolean')
        backupLines.push(`🧱 Миграции: ${meta['migrationsApplied'] ? 'применены' : 'не применены'}`);
      if (meta['initiatedBy'])
        backupLines.push(`👤 Инициатор: <code>${escapeHtml(meta['initiatedBy'])}</code>`);
      lines.push(`<blockquote>${backupLines.join('\n')}</blockquote>`);
    }

    // ── Facts that used to reach the card only as an English sentence ─────
    //
    // Broadcasts, imports and the Remnawave sync jobs said what happened in
    // their `message` alone — the English text the audit log keeps — and their
    // cards printed that sentence under the title. The numbers are all in the
    // metadata, so the cards say them in Russian instead. An instruction the
    // operator has to act on comes from its producer as a Russian `note`
    // («📝 Заметка»), never as a sentence invented here.
    if (typeof meta['broadcastId'] === 'string') lines.push(...formatBroadcastBlock(meta));
    if (event.type.startsWith('import.') && typeof meta['importRecordId'] === 'string') {
      lines.push(...formatImportBlock(event.type, meta));
    }
    if (event.type === EVENT_TYPES.SYSTEM_REMNAWAVE_SYNC) lines.push(...formatRemnawaveSyncBlock(meta));

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

    // ── Three alerts that used to arrive as a frame with no facts ─────────
    //
    // The card's HEADER is a per-type title, not `event.message` — the title
    // is written for a person. The card prints nothing more of the message
    // (unless its type opts in with `showMessage`), which works because every
    // fact an operator needs is picked out of `metadata` by one of these
    // blocks.
    //
    // For these three it was not. Their whole content lived in the message
    // and their metadata keys matched no block, so the card announced
    // «Концентрация онлайна в одной стране» and then named neither the
    // country nor the share — an alert that states a problem and withholds
    // every fact about it.
    //
    // The geo case had a second near-miss worth naming: the Node block above
    // reads `countryCode` and the detector emits `country`, so even the flag
    // would not have rendered.

    // Geo concentration — which country, and how much of the online base.
    if (meta['percentInCountry'] !== undefined && meta['country']) {
      lines.push('');
      lines.push('🌍 <b>Концентрация:</b>');
      const geoLines: string[] = [];
      // `countryCodeToFlag` already returns "🇩🇪 DE" — appending the code again
      // printed «Страна: 🇩🇪 DE DE». The node block above uses it alone.
      geoLines.push(`🏴 Страна: ${countryCodeToFlag(meta['country'])}`);
      geoLines.push(`📈 Доля онлайна: ${escapeHtml(meta['percentInCountry'])}%`);
      if (meta['usersInCountry'] !== undefined && meta['totalOnline'] !== undefined) {
        geoLines.push(
          `👥 Пользователей: ${escapeHtml(meta['usersInCountry'])} из ${escapeHtml(meta['totalOnline'])}`,
        );
      }
      lines.push(`<blockquote>${geoLines.join('\n')}</blockquote>`);
    }

    // Panel-wide HWID average. `kind` here is `hwid_average`, not `fraudKind`,
    // which is why the fraud block never matched it.
    if (meta['averageDevicesPerUser'] !== undefined) {
      lines.push('');
      lines.push('📱 <b>Устройства:</b>');
      const hwidLines: string[] = [];
      hwidLines.push(
        `📊 В среднем на пользователя: ${escapeHtml(meta['averageDevicesPerUser'])}`,
      );
      if (meta['totalHwidDevices'] !== undefined)
        hwidLines.push(`🔢 Всего привязок: ${escapeHtml(meta['totalHwidDevices'])}`);
      if (meta['totalUniqueDevices'] !== undefined)
        hwidLines.push(`🔹 Уникальных устройств: ${escapeHtml(meta['totalUniqueDevices'])}`);
      lines.push(`<blockquote>${hwidLines.join('\n')}</blockquote>`);
    }

    // A bulk operation over many users. `action` renders in the Error block
    // too, but that one is gated on an error and this event is `.info()`.
    if (meta['action'] && meta['batchId']) {
      lines.push('');
      lines.push('👥 <b>Массовая операция:</b>');
      const bulkLines: string[] = [];
      bulkLines.push(`🛠 Действие: <code>${escapeHtml(meta['action'])}</code>`);
      if (meta['succeeded'] !== undefined && meta['total'] !== undefined) {
        bulkLines.push(
          `✅ Успешно: ${escapeHtml(meta['succeeded'])} из ${escapeHtml(meta['total'])}`,
        );
      }
      if (Number(meta['failed'] ?? 0) > 0)
        bulkLines.push(`⚠️ Ошибок: ${escapeHtml(meta['failed'])}`);
      if (Number(meta['skipped'] ?? 0) > 0)
        bulkLines.push(`⏭ Пропущено: ${escapeHtml(meta['skipped'])}`);
      lines.push(`<blockquote>${bulkLines.join('\n')}</blockquote>`);
    }

    if (meta['partnerId'] || meta['earning']) {
      lines.push('');
      lines.push('🤝 <b>Партнёр:</b>');
      const partnerLines: string[] = [];
      if (meta['partnerId'])
        partnerLines.push(`🗳 ID: <code>${escapeHtml(String(meta['partnerId']).slice(0, 12))}</code>`);
      if (meta['level']) partnerLines.push(`🏮 Уровень: ${escapeHtml(meta['level'])}`);
      if (meta['earning'])
        partnerLines.push(`💴 Начислено: ${(Number(meta['earning']) / 100).toFixed(2)} ₽`);
      if (meta['percent']) partnerLines.push(`🏵 Процент: ${escapeHtml(meta['percent'])}%`);
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
        // Names, usernames and logins are the subscribers' own words: shown as
        // typed, never read as the operator's emoji tokens (`literalCardText`).
        if (meta['referredName']) {
          const h = meta['referredUsername'] ? ` (@${literalCardText(meta['referredUsername'])})` : '';
          refLines.push(`   👤 Имя: ${literalCardText(meta['referredName'])}${h}`);
        } else if (meta['referredUsername']) {
          refLines.push(`   👤 Username: @${literalCardText(meta['referredUsername'])}`);
        }
        if (meta['referredLogin'])
          refLines.push(`   🔑 Login: <code>${literalCardText(meta['referredLogin'])}</code>`);
      }
      if (meta['referrerId']) {
        refLines.push(`👥 Пригласил:`);
        if (meta['referrerTelegramId'])
          refLines.push(
            `   🪪 Telegram ID: <code>${escapeHtml(meta['referrerTelegramId'])}</code>`,
          );
        refLines.push(`   👾 Reiwa ID: <code>${escapeHtml(meta['referrerId'])}</code>`);
        if (meta['referrerName']) {
          const h = meta['referrerUsername'] ? ` (@${literalCardText(meta['referrerUsername'])})` : '';
          refLines.push(`   👤 Имя: ${literalCardText(meta['referrerName'])}${h}`);
        } else if (meta['referrerUsername']) {
          refLines.push(`   👤 Username: @${literalCardText(meta['referrerUsername'])}`);
        }
        if (meta['referrerLogin'])
          refLines.push(`   🔑 Login: <code>${literalCardText(meta['referrerLogin'])}</code>`);
      }
      if (meta['rewardType']) {
        const rv = meta['rewardValue'] !== undefined ? `: ${escapeHtml(meta['rewardValue'])}` : '';
        refLines.push(`🎊 Награда: ${humanizeRewardType(meta['rewardType'])}${rv}`);
      }
      if (meta['historicalPaymentsProcessed'] !== undefined)
        refLines.push(`📈 Платежей обработано: ${escapeHtml(meta['historicalPaymentsProcessed'])}`);
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
      // How much of the code is left. `promocode.archived` has carried
      // `activationsCount` since it was written and nothing printed it, so the
      // card said a code was archived and not whether anybody had used it;
      // «Промокод создан» and «Промокод исчерпан» are about these two numbers
      // and almost nothing else.
      if (isPresent(meta['activationsCount']))
        promoLines.push(`🧮 Активаций: ${escapeHtml(meta['activationsCount'])}`);
      if (isPresent(meta['maxActivations']))
        promoLines.push(`🎚 Лимит активаций: ${escapeHtml(meta['maxActivations'])}`);
      lines.push(`<blockquote>${promoLines.join('\n')}</blockquote>`);
    }

    // Device/HWID block
    //
    // Every value escaped. A HWID is whatever the VPN client sent as its device
    // header, and this card is parsed as HTML: an unescaped `<` either forged
    // markup or — far more often — made Telegram refuse the whole card.
    if (meta['hwid']) {
      lines.push('');
      lines.push('📱 <b>Устройство:</b>');
      const deviceLines: string[] = [];
      deviceLines.push(`🧬 HWID: <code>${escapeHtml(meta['hwid'])}</code>`);
      if (meta['remainingDevices'] !== undefined)
        deviceLines.push(`📱 Осталось устройств: ${escapeHtml(meta['remainingDevices'])}`);
      if (meta['planName']) deviceLines.push(`🏷 План: ${escapeHtml(meta['planName'])}`);
      if (meta['subscriptionId'])
        deviceLines.push(
          `🗳 Подписка ID: <code>${escapeHtml(String(meta['subscriptionId']).slice(0, 12))}</code>`,
        );
      if (meta['remnawaveId'])
        deviceLines.push(
          `🌊 Remnawave: <code>${escapeHtml(String(meta['remnawaveId']).slice(0, 12))}</code>`,
        );
      lines.push(`<blockquote>${deviceLines.join('\n')}</blockquote>`);
    }

    // Error block
    //
    // `error` is usually an exception's `.message`, which quotes whatever it
    // choked on — a URL with `&`, a tag from a provider page, a JSON body. It
    // was interpolated raw, so the card describing a failure was the card
    // Telegram refused to deliver. As `<code>`, like every raw diagnostic on
    // the card: it is the library's words, untranslated, not the card's.
    if (meta['error'] || event.severity === 'ERROR') {
      const errLines: string[] = [];
      if (meta['error']) errLines.push(`💬 Сообщение: <code>${escapeHtml(meta['error'])}</code>`);
      if (meta['action']) errLines.push(`🧷 Действие: <code>${escapeHtml(meta['action'])}</code>`);
      if (meta['attempt']) errLines.push(`🔁 Попытка: ${escapeHtml(meta['attempt'])}`);
      // THROUGH `factBlock`, like every other block on this card: the heading
      // used to be pushed BEFORE the lines were collected, so a producer with
      // none of these three keys would have sent it over an empty quote.
      //
      // A GUARD, not a repair. `severity === 'ERROR'` cannot be true here at
      // all — `isErrorEvent` routes every ERROR to `formatErrorEventCardHtml`
      // before this formatter is reached — so the only way in is `meta.error`,
      // and that fills the block by itself. The clause is kept because it
      // states the intent, and `factBlock` is what makes it safe to keep.
      lines.push(...factBlock('⚠️ <b>Ошибка:</b>', errLines));
    }

    // Extra block — curated leftover keys that carry useful context but don't
    // belong to any dedicated block above. Each is optional and escaped.
    const extraLines: string[] = [];
    if (meta['reason']) extraLines.push(`📌 Причина: ${humanizeReason(meta['reason'])}`);
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
      extraLines.push(`🚓 Тикет: <code>${escapeHtml(String(meta['ticketId']).slice(0, 12))}</code>`);
    // The subject a customer or a guest typed: as typed (`literalCardText`).
    if (meta['subject']) extraLines.push(`📨 Тема: ${literalCardText(meta['subject'])}`);
    // WHOSE authority moved. The role pair below has been rendered since the
    // block was written and had no producer to feed it; the account it
    // belongs to still had no line at all, so a card would have read «Роль:
    // ADMIN → DEV» without saying whose.
    if (typeof meta['targetAdminLogin'] === 'string' && meta['targetAdminLogin'].length > 0)
      extraLines.push(`👮 Учётная запись: <code>${escapeHtml(meta['targetAdminLogin'])}</code>`);
    if (meta['oldRole'] && meta['newRole'])
      extraLines.push(`🥢 Роль: ${escapeHtml(meta['oldRole'])} → ${escapeHtml(meta['newRole'])}`);
    // The evidence a failure card is about. Each of these was carried by a
    // producer and matched no block, so a relay that did not deliver, a card
    // Telegram refused, a broadcast that reached some of its audience and a
    // rule that raised a notification arrived without the status, the chat,
    // the counts or the rule's name.
    if (typeof meta['webhookKind'] === 'string' && meta['webhookKind'].length > 0)
      extraLines.push(`📩 Вид: ${humanizeWebhookKind(meta['webhookKind'])}`);
    if (typeof meta['relayStatus'] === 'string' && !backupDeliveryShown)
      extraLines.push(`📡 Статус доставки: <code>${escapeHtml(meta['relayStatus'])}</code>`);
    if (typeof meta['relayEvent'] === 'string')
      extraLines.push(`📨 Маршрут реле: <code>${escapeHtml(meta['relayEvent'])}</code>`);
    if (typeof meta['sourceEventType'] === 'string')
      extraLines.push(`🏷 Карточка события: <code>${escapeHtml(meta['sourceEventType'])}</code>`);
    // Which message was lost, on a relay card. A broadcast's channel copy is
    // relayed under `broadcast-channel:<broadcastId>`, and since that loss no
    // longer raises a card of its own this line is how the operator learns
    // WHICH broadcast's public post is gone.
    if (typeof meta['relayEventId'] === 'string' && meta['relayEventId'].length > 0) {
      const relayEventId = meta['relayEventId'];
      extraLines.push(
        relayEventId.startsWith(BROADCAST_CHANNEL_EVENT_PREFIX)
          ? `📣 Пост в канал рассылки: <code>${escapeHtml(relayEventId.slice(BROADCAST_CHANNEL_EVENT_PREFIX.length))}</code>`
          : `🔑 Ключ события: <code>${escapeHtml(relayEventId)}</code>`,
      );
    }
    if (typeof meta['chatId'] === 'string' || typeof meta['chatId'] === 'number')
      extraLines.push(`💬 Чат: <code>${escapeHtml(meta['chatId'])}</code>`);
    // The forum topic the lost card was addressed to — the relay record names
    // it `topicId`, the relay job it came from `topicThreadId`.
    const topicId = meta['topicId'] ?? meta['topicThreadId'];
    if (typeof topicId === 'number' || (typeof topicId === 'string' && topicId.length > 0))
      extraLines.push(`🧵 Топик: <code>${escapeHtml(topicId)}</code>`);
    if (typeof meta['httpStatus'] === 'number')
      extraLines.push(`🌐 Ответ HTTP: ${escapeHtml(meta['httpStatus'])}`);
    // Not when the message printed under the title already says it: a revived
    // broadcast's reason is both its detail and the tail of its sentence, and
    // the card printed it twice. As `<code>` — a provider's or a library's
    // words, untranslated.
    if (rawDetail.length > 0 && !(messageShown?.includes(rawDetail) ?? false))
      extraLines.push(`🧾 Подробности: <code>${escapeHtml(clipText(rawDetail, 300))}</code>`);
    // Set only on the direct fallback a producer makes when the queue refused
    // the job — the fact that says "Redis", not "Telegram" (`undelivered-record.ts`).
    if (typeof meta['enqueueError'] === 'string' && meta['enqueueError'].trim().length > 0)
      extraLines.push(
        `🧯 Очередь не приняла задачу: <code>${escapeHtml(clipText(meta['enqueueError'].trim(), 300))}</code>`,
      );
    // How big the cause is. An undelivered alert is coalesced per cause, and
    // the one that goes out carries how many it stands for — a relay refusing
    // a whole broadcast is one card saying 999, not one card saying nothing.
    if (typeof meta['repeatsSincePreviousAlert'] === 'number' && meta['repeatsSincePreviousAlert'] > 0)
      extraLines.push(`🔁 Таких же с прошлого оповещения: ${escapeHtml(meta['repeatsSincePreviousAlert'])}`);
    if (typeof meta['attemptsMade'] === 'number' && typeof meta['attempts'] === 'number')
      extraLines.push(
        `🔂 Попыток: ${escapeHtml(meta['attemptsMade'])} из ${escapeHtml(meta['attempts'])}`,
      );
    if (meta['sentCount'] !== undefined)
      extraLines.push(`📬 Доставлено: ${escapeHtml(meta['sentCount'])}`);
    if (Number(meta['failedCount'] ?? 0) > 0)
      extraLines.push(`📭 Не доставлено: ${escapeHtml(meta['failedCount'])}`);
    if (typeof meta['why'] === 'string' && meta['why'].length > 0)
      extraLines.push(`💡 Почему: ${escapeHtml(meta['why'])}`);
    if (typeof meta['ruleName'] === 'string' && meta['ruleName'].length > 0) {
      extraLines.push(`🤖 Правило: ${escapeHtml(meta['ruleName'])}`);
      // What set the rule off (`chainMetadata`). With the rule's default text
      // no longer printed, this is the line that says what happened.
      if (typeof meta['trigger'] === 'string' && meta['trigger'].length > 0)
        extraLines.push(`⚡ Сработало на: <code>${escapeHtml(meta['trigger'])}</code>`);
    }
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
    // WHO, when a person did it rather than a sweep. Filled by
    // `enrichAdminIdentity` from the `adminId` producers already carry — the
    // card used to name the source («Rezeis Админ-панель») and stop there.
    if (typeof meta['adminLogin'] === 'string' && meta['adminLogin'].length > 0)
      ctxLines.push(`🛠 Админ: <code>${escapeHtml(meta['adminLogin'])}</code>`);
    if (meta['operation'])
      ctxLines.push(`❄️ Операция: <code>${escapeHtml(meta['operation'])}</code>`);
    ctxLines.push(`🧮 Уровень: ${event.severity}`);
    const channel = meta['channel'] ?? meta['purchaseChannel'];
    if (channel) ctxLines.push(`📣 Канал покупки: ${humanizeChannel(channel)}`);
    // Written in the operator's zone and NAMED. It used to be the container's
    // local time with no label — UTC under compose — so «15:30» on a card from
    // an operator in Moscow meant 18:30 and nothing on the card said so.
    ctxLines.push(`⏰ Время: ${fmtDate(event.timestamp, timeZone)}`);
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

    // ── An operator's text gives way to the rest of the card ──────────────
    //
    // It is not capped like a producer's sentence (`isOperatorWrittenMessage`),
    // and it sits directly under the title — so left to the card clipper, a
    // long text kept itself and cut everything after it: «🤖 Правило», the
    // context, the build. The text is the one part that can be shortened
    // without losing what the card is, so it is shortened here, to exactly the
    // room the rest of the card leaves, and says that it was.
    if (messageLineIndex !== -1 && messageShown !== null && isOperatorWrittenMessage(event.type)) {
      const card = lines.join('\n');
      if (card.length > TELEGRAM_TEXT_LIMIT) {
        const room = TELEGRAM_TEXT_LIMIT - (card.length - lines[messageLineIndex]!.length);
        lines[messageLineIndex] = shortenedQuote(messageShown, room);
      }
    }

    return lines.join('\n');
  }

  /**
   * WHO DID IT — the admin's login, for the card.
   *
   * `adminId` has been on `SystemEventPayload` since it was written and two
   * dozen producers fill it, but it only ever reached the audit row. The
   * Telegram card named the subscriber an action was ABOUT and never the
   * person who took it, so on a panel with more than one operator «Подписка
   * удалена!» answered half the question — and the half it withheld is the one
   * another operator needs.
   *
   * An id is not an answer, so it is resolved here to the login they sign in
   * with. Best-effort and bounded exactly like `enrichUserIdentity`: one
   * lookup by primary key, never throws, and an event whose admin row is gone
   * (a revoked account) keeps its id in the audit log and simply prints no
   * line rather than printing a cuid at a person.
   *
   * `metadata.adminId` is read as well as the payload field, because both are
   * in use: `sendTelegramTest` and the device-revoke card carry the actor in
   * metadata, and they would otherwise be the admin-triggered cards still
   * anonymous.
   */
  private async enrichAdminIdentity(
    event: SystemEventPayload & { timestamp: string },
  ): Promise<SystemEventPayload & { timestamp: string }> {
    const meta = event.metadata ?? {};
    // A producer that already knows the login is believed: an event relayed
    // from reiwa names an actor this panel cannot resolve.
    if (typeof meta['adminLogin'] === 'string' && meta['adminLogin'].length > 0) return event;
    const fromPayload =
      typeof event.adminId === 'string' && event.adminId.length > 0 ? event.adminId : null;
    const fromMeta =
      typeof meta['adminId'] === 'string' && meta['adminId'].length > 0
        ? (meta['adminId'] as string)
        : null;
    const adminId = fromPayload ?? fromMeta;
    if (adminId === null) return event;

    try {
      const admin = await this.prismaService.adminUser.findUnique({
        where: { id: adminId },
        select: { login: true },
      });
      if (admin === null) return event;
      return { ...event, metadata: { ...meta, adminLogin: admin.login } };
    } catch {
      return event;
    }
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
   * API. It answers the one question that is knowable up front AND actually
   * stops delivery: does the operator's own event filter let this type through.
   *
   * ── What is deliberately NOT checked, and why ────────────────────────────
   *
   * The master `enabled` toggle. It reads like the obvious first test and it is
   * wrong: `deliverTelegram` never consults it. `enabled` only chooses between
   * the operator's group and the dev DM, and when neither is configured the
   * event still goes to the reiwa bot's dev id. There is no configuration in
   * which switching notifications off stops delivery — the settings screen says
   * so in as many words ("events still arrive here in the bot's DM"). Testing
   * it here turned the false SUCCESS this method was written to fix into a
   * false FAILURE: the card arrives and the rule reports it failed.
   *
   * `null` means "no reason it cannot be delivered", not "it was delivered".
   */
  public async describeTelegramDelivery(
    eventType: string,
  ): Promise<{ readonly deliverable: boolean; readonly reason: string | null }> {
    try {
      const config = await this.loadTelegramConfig();
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
    /** IANA zone the card's times are written in; `UTC` unless the operator set one. */
    timeZone: string;
  }> {
    // `orderBy` matches `SettingsService.getSettingsRecord` and
    // `PaymentOpsAlertService.readSettings`. It was absent here, and an
    // unordered `findFirst` picks whatever row the query plan yields — so on
    // a database that ever grew a second `Settings` row this service could
    // read its Telegram config, and now its bot token, from a DIFFERENT row
    // than the one the Bot Token card writes to. One row is the intent; the
    // ordering is what makes every reader agree on which one that is.
    //
    // `platformPolicy` rides the same read for the operator's time zone — the
    // setting customer notifications already use (`UserNotificationsService.
    // resolveBranding`), so a card and a notification about one deadline name
    // the same hour.
    const settings = await this.prismaService.settings.findFirst({
      orderBy: { updatedAt: 'asc' },
      select: { systemNotifications: true, platformPolicy: true },
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
        timeZone: 'UTC',
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
      timeZone: resolveCardTimeZone(readPlatformBranding(settings.platformPolicy).timezone),
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
 * What Telegram accepts, and the reason this file has to care.
 *
 * A message body may be 4096 characters; a DOCUMENT CAPTION may be 1024. The
 * same card is used for both — as `text` on the plain routes and as `caption`
 * on the two document routes — and nothing trimmed it, so a long card was not
 * shortened, it was REFUSED: `400 Bad Request: message caption is too long`,
 * and on the relay route that refusal is terminal on the first attempt.
 *
 * That is reachable without anything exotic. An error reported by the cabinet
 * carries up to 2000 characters of message, the card frame is roughly 500, and
 * the result is an error report that never arrives — precisely the message an
 * operator most needs.
 */
const TELEGRAM_TEXT_LIMIT = 4096;
const TELEGRAM_CAPTION_LIMIT = 1024;

/**
 * Named rather than written inline, because a literal escape in this file has
 * been silently turned into a real line break by a shell heredoc more than
 * once. A constant cannot be mangled by whatever writes the file next.
 */
const NEWLINE = String.fromCharCode(10);

/**
 * How far back a cut may walk looking for a safe boundary.
 *
 * A bound, not a nicety: an unterminated `&` or `<` further back than this is
 * not the start of an entity or a tag, it is ordinary prose — and treating it
 * as one threw away the rest of the card. `AT&T` followed by five thousand
 * characters used to clip down to the two letters `AT`.
 */
const MAX_MARKUP_LOOKBEHIND = 16;

/** Upper bound on the prefix search, so a huge input cannot make it quadratic. */
const MAX_SAFE_CUT_SEARCH = 8192;

/**
 * Cut an HTML card down to `limit` WITHOUT handing Telegram broken markup.
 *
 * Two rules, and both matter:
 *
 *   1. Cut on LINE boundaries. A cut in the middle of `<blockquote>` or of an
 *      HTML entity produces a body Telegram rejects outright, which is the
 *      failure this function exists to prevent — trading "too long" for
 *      "malformed" would be no improvement at all.
 *   2. Close what is left open. Dropping the tail can strand an opening tag;
 *      the closers are appended in reverse order of opening, which is the only
 *      order that nests correctly.
 *
 * The marker is deliberately visible: a silently shortened card reads as a
 * complete one, and an operator would draw conclusions from a card that stops
 * early without saying so.
 */
export function clipHtmlCard(html: string, limit: number): string {
  if (html.length <= limit) return html;

  const marker = `${NEWLINE}…`;
  // Measured on the FINISHED string, not on a budget guessed in advance. The
  // closers depend on which tags the cut happens to leave open, so reserving
  // room up front means reserving for the wrong prefix — and the first version
  // of this did exactly that and produced results over the limit.
  const fits = (candidate: string): boolean =>
    candidate.length + closersFor(candidate).length + marker.length <= limit;

  let kept = '';
  for (const line of html.split(NEWLINE)) {
    const next = kept.length === 0 ? line : `${kept}${NEWLINE}${line}`;
    if (fits(next)) {
      kept = next;
      continue;
    }
    // This line does not fit WHOLE — so take as much of it as does, and stop.
    //
    // Stopping outright was the first shape and it threw the budget away: the
    // error message is ONE long line in the middle of the card, after a short
    // hashtag line, so a 375-character message produced a 638-character result
    // out of 1024 and the message itself — the only part anybody reads — was
    // not in it. The card was shortened to the last thing that happened to end
    // in a newline.
    kept = headOf(next, fits, limit - marker.length);
    break;
  }
  return `${kept}${closersFor(kept)}${marker}`;
}

/**
 * The longest prefix of `value` that `fits`, cut somewhere it is safe to cut.
 *
 * Three things must not be halved, and all three are ordinary in these cards:
 *
 *   - an HTML entity: half of `&amp;` is not an entity, and Telegram refuses
 *     the whole body over it;
 *   - a tag: `<cod` is not markup, and `closersFor` cannot even see it to
 *     balance it — nor is `<a href="https://recei`, however long the URL;
 *   - a surrogate pair: these cards are full of emoji, and `slice` counts
 *     UTF-16 code units, so an odd offset splits one in half.
 *
 * So the cut walks back from the naive offset to the nearest position that is
 * outside all three, then shrinks further if the closers still do not fit.
 *
 * The walk starts at `maxLength`, the most any candidate can keep, rather than
 * at the end of the line: nothing longer can fit, and an automation's text —
 * uncapped, and one line — made every character above it one more pass.
 */
function headOf(
  value: string,
  fits: (candidate: string) => boolean,
  maxLength: number,
): string {
  let end = Math.min(value.length, MAX_SAFE_CUT_SEARCH, Math.max(0, maxLength));
  while (end > 0) {
    const candidate = value.slice(0, safeCutBefore(value, end));
    if (candidate.length === 0) return '';
    if (fits(candidate)) return candidate;
    end = candidate.length - 1;
  }
  return '';
}

/**
 * Walk `end` back to the first index that splits nothing.
 *
 * A tag is honoured however far back it opened — see {@link openTagAround}.
 * An entity only within {@link MAX_MARKUP_LOOKBEHIND}: an unterminated `&`
 * further back than that is not a real entity, and treating it as one would
 * throw away most of the card — `AT&T` followed by five thousand characters
 * used to cut down to `AT`.
 */
function safeCutBefore(value: string, end: number): number {
  let index = end;
  // Never between the halves of a surrogate pair.
  if (index > 0 && index < value.length) {
    const code = value.charCodeAt(index - 1);
    if (code >= 0xd800 && code <= 0xdbff) index -= 1;
  }
  const openTag = openTagAround(value, index);
  if (openTag !== -1) return openTag;
  const window = value.slice(Math.max(0, index - MAX_MARKUP_LOOKBEHIND), index);
  const amp = window.lastIndexOf('&');
  if (amp !== -1 && !window.slice(amp).includes(';')) {
    return index - (window.length - amp);
  }
  return index;
}

/**
 * Where the tag that a cut at `index` would land inside begins, or -1.
 *
 * NOT bounded by {@link MAX_MARKUP_LOOKBEHIND}, which is what this replaced: a
 * link is `<a href="…">` and is as long as its URL — a receipt, a checkout, a
 * profile — so a cut inside the URL found no `<` in its sixteen-character
 * window, kept `<a href="https://recei`, and Telegram refused the whole card
 * for the half tag. The bound was there for prose, and prose cannot produce
 * this: every card escapes the `<` of its text, so a raw `<` followed by a
 * tag name is always markup the card wrote. A `<` that never reaches a `>`
 * is not a tag at all and is left alone.
 */
function openTagAround(value: string, index: number): number {
  if (index <= 0) return -1;
  const open = value.lastIndexOf('<', index - 1);
  if (open === -1) return -1;
  if (value.lastIndexOf('>', index - 1) > open) return -1;
  if (!/^<\/?[A-Za-z]/.test(value.slice(open, open + 3))) return -1;
  return value.indexOf('>', open) === -1 ? -1 : open;
}

/**
 * Closers for everything `kept` left open, innermost first.
 *
 * A STACK walked in document order, not a per-tag tally. Counting each tag
 * separately loses the nesting: `<blockquote><b><code>` closed by tag order
 * comes out `</blockquote></code></b>`, which is exactly as malformed as
 * leaving them open — the closers have to mirror the order the tags were
 * actually opened in, and only the text knows that.
 *
 * Every tag, attributes and all, not a fixed list of four. The list was
 * `b|i|code|blockquote`, so a cut through a link's text stranded its
 * `<a href="…">` with no `</a>`, and Telegram refused the card over it.
 */
function closersFor(kept: string): string {
  const stack: string[] = [];
  const tag = /<(\/?)([A-Za-z][A-Za-z0-9-]*)(?:\s[^>]*)?>/g;
  for (let match = tag.exec(kept); match !== null; match = tag.exec(kept)) {
    const closing = match[1];
    const name = match[2]!.toLowerCase();
    if (closing === '/') {
      // Pop the matching open, if there is one; a stray closer is ignored
      // rather than treated as an error, because the input is our own card.
      const at = stack.lastIndexOf(name);
      if (at !== -1) stack.splice(at, 1);
    } else {
      stack.push(name);
    }
  }
  return stack
    .reverse()
    .map((name) => `</${name}>`)
    .join('');
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
 * DISTINCT EVENTS MUST NOT COLLIDE. `sysevt:${type}:${timestamp}` — the shape
 * every route here used to use, and the reason this function now serves all
 * six — is not enough. Its whole discriminator is an ISO millisecond, and the
 * characteristic traffic is a burst of same-type events from one detector
 * pass: `emitOperationalAlerts` is a synchronous loop with no `await` in it,
 * so a per-node traffic alert and its neighbour genuinely share a millisecond.
 *
 * A collision is not a harmless duplicate. `enqueue` derives the BullMQ
 * `jobId` from this key, so the second alert is never queued — and `enqueue`
 * still returns `true`, with no log line. Worse, the detector records the
 * crossed band BEFORE emitting, so the swallowed alert is never raised again:
 * past the first node in a run, those alerts were lost permanently and
 * silently.
 *
 * The digest closes it: it covers everything that makes the event itself, so
 * two different cards in the same millisecond get different keys, while a
 * genuinely identical card still collapses — which is the behaviour the
 * deduplication was for.
 *
 * Length is bounded ON PURPOSE. The cabinet parses this with
 * `z.string().trim().min(1).max(128)` and `.catch(undefined)`, so an over-long
 * key does not fail loudly — it is silently dropped and the event degrades to
 * exactly the undeduped state this function exists to end. `event.type` is
 * caller-supplied (automation rules and the reiwa ingest both mint types at
 * runtime), so it is clipped; the digest still covers it in full. Worst case:
 * 7 + 49 + 1 + 33 + 1 + 12 + 1 + 16 = 120 characters.
 */
/**
 * What happened to one card on the Telegram route.
 *
 * Every caller but one ignores this, and should: a card that could not be
 * delivered must never take down the operation that raised it. The Settings
 * test button is the exception, because reporting which of these it got is
 * the button's entire job.
 */
export type TelegramDeliveryResult =
  | { readonly kind: 'sent' }
  | { readonly kind: 'queued' }
  | { readonly kind: 'relayed' }
  | { readonly kind: 'muted'; readonly reason: 'no-transport' | 'not-selected' }
  | { readonly kind: 'failed'; readonly reason: string };

/** Telegram's own words for a refusal, when it gave any. */
function describeTelegramRefusal(description: unknown): string {
  return typeof description === 'string' && description.trim().length > 0
    ? description.trim().slice(0, 300)
    : 'Telegram refused the message without saying why';
}

/**
 * A transport failure in words an operator can act on.
 *
 * Telegram puts the useful sentence in `response.data.description` — "chat not
 * found", "bot was kicked from the supergroup chat", "message thread not
 * found". The axios message alone is `Request failed with status code 400`,
 * which names nothing an operator can fix.
 */
function describeTelegramError(err: unknown): string {
  const response = (err as { response?: { data?: { description?: unknown }; status?: unknown } })
    ?.response;
  const described = response?.data?.description;
  if (typeof described === 'string' && described.trim().length > 0) {
    return described.trim().slice(0, 300);
  }
  if (typeof response?.status === 'number') {
    return `Telegram answered ${response.status}`;
  }
  return err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300);
}

function buildRelayEventId(
  event: SystemEventPayload & { timestamp: string },
  route:
    | 'dev'
    | 'dev-document'
    | 'direct'
    | 'direct-document'
    | 'relay'
    | 'relay-document',
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
 * Escaping for a value inside `href="…"`.
 *
 * `escapeHtml` leaves `"` alone, which is right for text and wrong here: a
 * receipt URL carrying a quote closed the attribute early, and Telegram
 * refuses a card whose markup it cannot parse — the whole card, not the link.
 * `&quot;` is one of the four named entities the Bot API accepts.
 */
function escapeAttr(value: unknown): string {
  return escapeHtml(value).replace(/"/g, '&quot;');
}

/**
 * Trims text to `max` code points, marking the cut.
 *
 * Code points, not UTF-16 units: a message is free text and a cut through an
 * emoji leaves half a surrogate pair, which is not valid UTF-8 on the wire.
 */
function clipText(value: string, max: number): string {
  const points = Array.from(value);
  return points.length > max ? `${points.slice(0, max).join('')}…` : value;
}

/**
 * How much of the producer's message a card prints under its title.
 *
 * Generous, because for the types that print it the message is the substance —
 * but bounded, so one runaway log sentence cannot push every block below it
 * past Telegram's limit. Not applied to an automation's text: see
 * {@link isOperatorWrittenMessage}.
 */
const CARD_MESSAGE_LIMIT = 1000;

/**
 * The producer's sentence to print under the title, or `null`.
 *
 * OPT-IN, per type, through `EventPresentation.showMessage`. It used to be
 * printed on every WARNING, and on the busiest cards that was noise rather
 * than news: «Профиль истёк (Remnawave)!» over `Remnawave: user.expired`,
 * «Платёж не прошёл» over an enum, a device average restated in English under
 * the block that already showed it. The types that opt in are the ones whose
 * producers put facts in the message and nowhere else.
 *
 * Blank, the title again in other letters, or the title as the sentence's own
 * lead-in (`«Title»: the actual news`) is not repeated. Nor is the coalesced
 * repeat count an undelivered alert appends to its sentence: the details block
 * states it from `repeatsSincePreviousAlert`, on both undelivered cards alike.
 *
 * And an automation's DEFAULT text is not printed at all. It is English, it
 * names nothing the card does not already name («🤖 Правило»), and a rule
 * saved with the editor's untouched draft text sends exactly it.
 */
function cardMessageLine(
  event: SystemEventPayload,
  presentation: EventPresentation,
  title: string,
): string | null {
  const when = presentation.showMessage;
  if (when === undefined) return null;
  if (when === 'warning' && event.severity === 'INFO') return null;
  const meta = event.metadata ?? {};
  const message = withoutRepeatsSuffix(withoutLeadingTitle(event.message.trim(), title), meta);
  if (message.length === 0) return null;
  if (isOperatorWrittenMessage(event.type)) {
    return isDefaultAutomationText(message, meta) ? null : message;
  }
  return clipText(message, CARD_MESSAGE_LIMIT);
}

/**
 * `text` as a `<blockquote>` line of at most `room` characters of card HTML,
 * cut on whole code points — an entity is never halved, an emoji never split —
 * and ending in `…` because something was cut.
 */
function shortenedQuote(text: string, room: number): string {
  const open = '<blockquote>';
  const close = '</blockquote>';
  const marker = '…';
  const budget = room - open.length - close.length - marker.length;
  let kept = '';
  for (const point of text) {
    const escaped = escapeHtml(point);
    if (kept.length + escaped.length > budget) break;
    kept += escaped;
  }
  return `${open}${kept}${marker}${close}`;
}

/**
 * The text an automation sends when its rule was given none — never the
 * operator's words.
 *
 * `AutomationActionRegistry` falls back to `Automation rule "<name>" fired`
 * (notify) and `Automation "<name>" fired` (system event), and the rule
 * editor's «new rule» draft carries `Triggered`, which is saved as the rule's
 * text unless somebody replaces it. Matched exactly, against the rule name the
 * event itself carries, so an operator's own sentence can never be mistaken
 * for one of them.
 */
function isDefaultAutomationText(message: string, meta: Readonly<Record<string, unknown>>): boolean {
  if (message === 'Triggered') return true;
  const ruleName = meta['ruleName'];
  if (typeof ruleName !== 'string') return false;
  return (
    message === `Automation rule "${ruleName}" fired` || message === `Automation "${ruleName}" fired`
  );
}

/**
 * `message` without the repeat count the undelivered-alert recorder appends
 * (`createUndeliveredRecorder`), when the metadata says one was appended.
 */
function withoutRepeatsSuffix(message: string, meta: Readonly<Record<string, unknown>>): string {
  const repeats = meta['repeatsSincePreviousAlert'];
  if (typeof repeats !== 'number') return message;
  for (const suffix of [describeTelegramDirectRepeats(repeats), describeRelayRepeats(repeats)]) {
    if (message.endsWith(suffix)) return message.slice(0, message.length - suffix.length).trimEnd();
  }
  return message;
}

/**
 * A sentence as card HTML, with a raw provider text it quotes marked as such.
 *
 * `describeTelegramOutcome` quotes Telegram's own refusal inside its Russian
 * sentence — «Telegram отклонил сообщение: Bad Request: chat not found». Those
 * are Telegram's words, not the card's, and they stay untranslated; `<code>`
 * says so, the same way the details block shows every raw diagnostic.
 */
function sentenceHtml(sentence: string, rawQuote: string | null): string {
  if (rawQuote === null || rawQuote.length === 0) return escapeHtml(sentence);
  const at = sentence.lastIndexOf(rawQuote);
  if (at === -1) return escapeHtml(sentence);
  return (
    `${escapeHtml(sentence.slice(0, at))}<code>${escapeHtml(rawQuote)}</code>` +
    escapeHtml(sentence.slice(at + rawQuote.length))
  );
}

/**
 * The header a card wears: a matching `variants` entry first, then the failure
 * header when the event is a failure, then the type's own title.
 */
function headerFor(
  event: SystemEventPayload,
  presentation: EventPresentation,
): { readonly emoji: string; readonly title: string } {
  const meta = event.metadata ?? {};
  const variant = presentation.variants?.find((candidate) => candidate.when(meta));
  if (variant !== undefined) return variant;
  if (wearsWarningHeader(event, presentation)) return presentation.warning;
  return presentation;
}

/**
 * The header the INCIDENT card wears.
 *
 * `isErrorEvent` sends every ERROR to `formatErrorEventCardHtml`, whose header
 * was a constant — so a broadcast refused for a caption over the Telegram
 * limit announced itself as «Произошла ошибка!», the wording for an unhandled
 * exception, and an operator had to read four blocks to learn it was not one.
 *
 * The registry already holds the right title for these types — that is what
 * the note beside `import.failed` is about. The card simply never asked. A
 * type nobody registered still gets the old wording, which is honest: nobody
 * has said what it is.
 *
 * ONLY A FAILURE HEADER. A type's own title is often a success — ERROR is
 * raised under `promocode.activated` («Промокод активирован») when the reward
 * sync fails, and under `subscription.synced` when a regenerated link was not
 * stored — and over «Необработанная ошибка» that title is worse than the
 * constant it replaced. So: a producer's own variant, else the type's failure
 * header, else its title only when the TYPE names a failure
 * (`FAILURE_NAMED_TYPE`); anything else keeps «Произошла ошибка!».
 */
function errorCardHeader(
  event: SystemEventPayload,
): { readonly emoji: string; readonly title: string } | undefined {
  const present = EVENT_PRESENTATION[event.type];
  if (present === undefined) return undefined;
  const meta = event.metadata ?? {};
  const variant = present.variants?.find((candidate) => candidate.when(meta));
  if (variant !== undefined) return variant;
  if (present.warning !== undefined) return present.warning;
  return FAILURE_NAMED_TYPE.test(event.type) ? present : undefined;
}

/**
 * A type whose own name says it failed — `system.error`, `import.failed`,
 * `partner.balance_refund_failed` — and whose title, accordingly, says so too.
 */
const FAILURE_NAMED_TYPE = /(?:\.error|[._]failed)$/;

/** A metadata value worth a line: not absent, not null, not blank. */
function isPresent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  return typeof value !== 'string' || value.trim().length > 0;
}

/**
 * Why YooKassa's own answer contradicted a completion, in the operator's words
 * (`YookassaPaymentVerificationService`, the CONTRADICTED verdicts). A reason
 * this map does not know is shown raw.
 */
function humanizeVerificationReason(value: unknown): string {
  switch (String(value)) {
    case 'PAYMENT_VERIFICATION_PROVIDER_CANCELED':
      return 'ЮKassa сообщает, что платёж отменён';
    case 'PAYMENT_VERIFICATION_PAYMENT_NOT_FOUND':
      return 'ЮKassa не знает такого платежа';
    case 'PAYMENT_VERIFICATION_PAYMENT_NOT_OURS':
      return 'платёж в ЮKassa относится к другому счёту';
    case 'PAYMENT_VERIFICATION_PAYMENT_ID_MISSING':
      return 'в уведомлении нет ID платежа';
    default:
      return `<code>${escapeHtml(value)}</code>`;
  }
}

/**
 * An automation's message is not a producer's log line: it is the text the
 * operator wrote into the rule, and for `automation.telegram_notify` it is the
 * whole notification. Capping it at {@link CARD_MESSAGE_LIMIT} cut the one
 * part of the card anybody reads and kept the frame around it; the card
 * clipper already bounds the finished card at Telegram's own limit.
 */
function isOperatorWrittenMessage(type: string): boolean {
  return type.startsWith('automation.');
}

/**
 * `message` without a leading copy of `title`.
 *
 * Only when the title is followed by a separator — `Панель не доставила
 * карточку в Telegram: Telegram отклонил токен…` becomes the part after the
 * colon — so a sentence that merely begins with the same words keeps them.
 * The title alone (any case, optional `!`) comes back empty.
 */
function withoutLeadingTitle(message: string, title: string): string {
  const head = message.slice(0, title.length);
  if (title.length === 0 || head.toLocaleLowerCase('ru-RU') !== title.toLocaleLowerCase('ru-RU')) {
    return message;
  }
  const rest = message.slice(title.length);
  if (rest.length === 0) return '';
  const separator = /^\s*[:.!—–-]+\s*/.exec(rest);
  return separator === null ? message : rest.slice(separator[0].length);
}

/**
 * Whether this event wears its type's failure header rather than the title.
 *
 * Any non-INFO severity does. An INFO event does only when its presentation's
 * `warning.whenMetadata` recognises a failure in the metadata — for a producer
 * that reports a partial result at INFO.
 */
function wearsWarningHeader(
  event: SystemEventPayload,
  presentation: EventPresentation,
): presentation is EventPresentation & { readonly warning: EventWarningHeader } {
  const warning = presentation.warning;
  if (warning === undefined) return false;
  if (event.severity !== 'INFO') return true;
  return warning.whenMetadata?.(event.metadata ?? {}) === true;
}

/**
 * Why a backup is not in Telegram, in the operator's words.
 *
 * Keyed by the reasons `BackupService` records: its own terminal outcomes and
 * the relay's `NotifyDeliveryStatus`. A reason nobody taught this map is shown
 * raw rather than dropped — an untranslated truth beats a translated guess.
 */
const BACKUP_DELIVERY_REASONS: Readonly<Record<string, string>> = {
  too_large_for_telegram: 'файл слишком большой для Telegram',
  // `runTelegramDelivery` answers this for BOTH halves of its guard — delivery
  // switched off, and delivery switched on with no Chat ID — so the words must
  // not pick one of them.
  not_configured: 'доставка в Telegram не настроена (выключена или не указан Chat ID)',
  file_missing: 'файл не найден на диске',
  telegram_api_rejected: 'Telegram отклонил файл',
  telegram_api_threw: 'не удалось связаться с Telegram',
  relay_unavailable: 'нет токена бота и связи с reiwa',
  crypt_key_missing: 'не задан REZEIS_CRYPT_KEY',
  unconfirmed: 'reiwa не подтвердила отправку',
  rejected: 'reiwa отказала в отправке',
  timeout: 'reiwa не ответила вовремя',
  failed: 'не удалось передать файл через reiwa',
  disabled: 'связь с reiwa выключена',
};

function describeBackupDelivery(meta: Record<string, unknown>): string {
  if (meta['deletedByRetention'] === true) {
    // Not «только локально»: there is no local copy any more. This is the one
    // outcome where the backup itself is gone.
    return 'копии больше нет — в Telegram она не попала, а локальный файл удалён ротацией';
  }
  const status = typeof meta['relayStatus'] === 'string' ? meta['relayStatus'] : null;
  if (status === null) return 'только локально';
  const reason = BACKUP_DELIVERY_REASONS[status] ?? `<code>${escapeHtml(status)}</code>`;
  return `только локально — ${reason}`;
}

/**
 * The zone a card writes its times in: the operator's IANA zone from platform
 * settings, or `UTC` when none is set or the stored name is not one `Intl`
 * knows. Never throws — a typo in a setting must not cost a card.
 */
function resolveCardTimeZone(timezone: string | null): string {
  const candidate = (timezone ?? '').trim();
  if (candidate.length === 0) return 'UTC';
  try {
    new Intl.DateTimeFormat('ru-RU', { timeZone: candidate });
    return candidate;
  } catch {
    return 'UTC';
  }
}

/** `14.09.2026, 18:30:00 GMT+3` — the instant in `timeZone`, with the zone named. */
function fmtInstant(date: Date, timeZone: string): string {
  return date.toLocaleString('ru-RU', { timeZone, timeZoneName: 'short' });
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
    // The offender's own name, username and address: as typed (`literalCardText`).
    if (meta['fraudUserName']) who.push(`👤 Имя: ${literalCardText(meta['fraudUserName'])}`);
    if (meta['fraudUsername']) who.push(`👤 Username: @${literalCardText(meta['fraudUsername'])}`);
    if (meta['fraudTelegramId'])
      who.push(`🪪 Telegram ID: <code>${escapeHtml(meta['fraudTelegramId'])}</code>`);
    if (meta['fraudUserEmail']) who.push(`📧 Email: ${literalCardText(meta['fraudUserEmail'])}`);
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
    out.push(`🔗 <a href="${escapeAttr(meta['fraudProfileUrl'])}">Открыть профиль в rezeis</a>`);
  }

  return out;
}

/** A non-negative whole count, as producers put them in metadata. */
function countOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** A block of `facts` under `heading`, or nothing when there are none. */
function factBlock(heading: string, facts: readonly string[]): string[] {
  return facts.length === 0 ? [] : ['', heading, `<blockquote>${facts.join('\n')}</blockquote>`];
}

/**
 * A broadcast's facts, read from the keys its producers use:
 * `BroadcastDeliveryService` (staging, recall, the channel copy),
 * `BroadcastProcessor` (fan-out, each batch) and `BroadcastReconcilerService`
 * (a revival). The sentences beside them are English and stay in the audit log.
 */
function formatBroadcastBlock(meta: Record<string, unknown>): string[] {
  const facts: string[] = [`🆔 ID: <code>${escapeHtml(meta['broadcastId'])}</code>`];
  const audience = countOf(meta['recipientCount']) ?? countOf(meta['totalMessages']);
  if (audience !== null) facts.push(`👥 Получателей: ${audience}`);
  const batches = countOf(meta['batches']);
  if (batches !== null) facts.push(`📦 Партий: ${batches}`);
  const batchSize = countOf(meta['batchSize']);
  if (batchSize !== null) facts.push(`🧮 Сообщений в партии: ${batchSize}`);
  const sent = countOf(meta['sent']);
  if (sent !== null) facts.push(`📬 Отправлено: ${sent}`);
  // A recall reports `deleted` and `failed`; a batch reports `sent` and
  // `failed`. The same key means a different loss in each.
  const deleted = countOf(meta['deleted']);
  if (deleted !== null) facts.push(`🗑 Удалено у получателей: ${deleted}`);
  const failed = countOf(meta['failed']);
  if (failed !== null && failed > 0)
    facts.push(deleted !== null ? `⚠️ Не удалось удалить: ${failed}` : `📭 Не доставлено: ${failed}`);
  const unresolved = countOf(meta['unresolved']);
  if (unresolved !== null && unresolved > 0) facts.push(`⏳ Ждут повторной отправки: ${unresolved}`);
  const attempts = countOf(meta['attempts']);
  if (attempts !== null) facts.push(`🔁 Попытка возобновления: ${attempts}`);
  if (typeof meta['channelPost'] === 'string' && meta['channelPost'] !== 'skipped')
    facts.push(`📡 Пост в канал: ${humanizeChannelPost(meta['channelPost'])}`);
  return factBlock('📣 <b>Рассылка:</b>', facts);
}

/** What became of a broadcast's operator-channel copy (`postToChannelIfConfigured`). */
function humanizeChannelPost(value: string): string {
  switch (value) {
    case 'queued':
      return 'поставлен в очередь';
    case 'delivered':
      return 'опубликован';
    case 'recorded':
      return 'не доставлен — подробности в карточке «Вебхук в reiwa не доставлен»';
    case 'dropped':
      return 'не доставлен: пост не удалось собрать или отправить';
    case 'disabled':
      return 'не отправлен: связь панели с reiwa не настроена';
    default:
      return `<code>${escapeHtml(value)}</code>`;
  }
}

/**
 * An import's facts (`ImportProcessor`). `import.completed` keeps its counts in
 * `result`, the importer's `ImportSummary`; the plan assignment and the sync
 * enqueue put theirs at the top level. `import.failed` is ERROR and gets the
 * incident card instead.
 */
function formatImportBlock(type: string, meta: Record<string, unknown>): string[] {
  const facts: string[] = [`🆔 ID: <code>${escapeHtml(meta['importRecordId'])}</code>`];
  if (typeof meta['sourceType'] === 'string')
    facts.push(`📦 Источник: ${humanizeImportSource(meta['sourceType'])}`);
  if (typeof meta['mode'] === 'string') facts.push(`🔀 Режим: ${humanizeImportMode(meta['mode'])}`);

  if (type === EVENT_TYPES.IMPORT_COMPLETED) {
    const result = meta['result'];
    const summary =
      typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : {};
    const counted: ReadonlyArray<readonly [string, string]> = [
      ['fetched', '📥 Прочитано записей'],
      ['created', '🆕 Создано пользователей'],
      ['updated', '✏️ Обновлено пользователей'],
      ['skipped', '⏭ Пропущено'],
      ['subscriptionsCreated', '📦 Создано подписок'],
      ['subscriptionsUpdated', '📦 Обновлено подписок'],
      ['descriptionWritebacks', '📝 Описаний записано в панель'],
    ];
    for (const [key, label] of counted) {
      const value = countOf(summary[key]);
      if (value !== null) facts.push(`${label}: ${value}`);
    }
    if (Array.isArray(summary['errors']) && summary['errors'].length > 0)
      facts.push(`⚠️ Ошибок: ${summary['errors'].length}`);
  }

  if (type === EVENT_TYPES.IMPORT_PLAN_ASSIGNED) {
    if (typeof meta['planId'] === 'string')
      facts.push(`🏷 Тариф: <code>${escapeHtml(meta['planId'])}</code>`);
    const counted: ReadonlyArray<readonly [string, string]> = [
      ['updated', '✅ Тариф назначен подпискам'],
      // A plan of ANY kind: a bought subscription, or one an operator or an
      // earlier run assigned — not necessarily the plan chosen now.
      ['skippedAlreadyAssigned', '⏭ Тариф уже назначен'],
      ['skippedPurchasedHere', '⏭ Куплены или продлены в панели'],
      ['skippedNotImported', '⏭ Не из импорта'],
      ['skippedDeleted', '⏭ Пропущено удалённых'],
      ['skippedNoSubscription', '⏭ Без подписки'],
      ['syncJobsCreated', '🔄 Задач синхронизации'],
    ];
    for (const [key, label] of counted) {
      const value = countOf(meta[key]);
      if (value !== null) facts.push(`${label}: ${value}`);
    }
    const errors = countOf(meta['errors']);
    if (errors !== null && errors > 0) facts.push(`⚠️ Ошибок: ${errors}`);
  }

  if (type === EVENT_TYPES.IMPORT_SYNC_ENQUEUED) {
    const enqueued = countOf(meta['enqueued']);
    const total = countOf(meta['total']);
    if (enqueued !== null)
      facts.push(`🔄 Поставлено в очередь: ${enqueued}${total !== null ? ` из ${total}` : ''}`);
    const skipped = countOf(meta['skipped']);
    if (skipped !== null && skipped > 0)
      facts.push(`⏭ Пропущено — синхронизация уже идёт: ${skipped}`);
  }

  return factBlock('📥 <b>Импорт:</b>', facts);
}

/** The donor an import read from (`ImportProcessor.handleRun`). Product names stay as they are. */
function humanizeImportSource(value: string): string {
  switch (value) {
    case 'remnawave':
      return 'Remnawave';
    case '3xui':
      return '3x-ui';
    case 'remnashop':
      return 'Remnashop';
    case 'altshop':
      return 'Altshop';
    case 'stealthnet':
      return 'StealthNet';
    case 'bedolaga':
      return 'Bedolaga';
    default:
      return `<code>${escapeHtml(value)}</code>`;
  }
}

function humanizeImportMode(value: string): string {
  switch (value) {
    case 'import':
      return 'импорт';
    case 'sync':
      return 'синхронизация';
    default:
      return `<code>${escapeHtml(value)}</code>`;
  }
}

/**
 * The facts of a `system.remnawave_sync` event, from every producer's keys:
 * the expired-profile cleanup, the duplicate merge, the panel-link
 * reconciliation, the user-row shape drift, subscription deletion, the admin
 * subscription edit and the refund revocation.
 *
 * Gated on the type, because these keys — `scanned`, `linked`, `merged` — are
 * generic words another producer may use for something else.
 *
 * Several of these events exist to tell the operator to DO something — run the
 * reconciliation, delete a profile by hand. That instruction is not composed
 * here: it belongs to the producer, as a Russian `note`.
 */
function formatRemnawaveSyncBlock(meta: Record<string, unknown>): string[] {
  const facts: string[] = [];
  if (meta['code'] === 'SUBSCRIPTION_DELETE_STALE_PANEL_LINK')
    facts.push('🚫 Удаление профиля на панели отклонено: сохранённая привязка устарела');
  const subscriptions = countOf(meta['subscriptions']);
  if (subscriptions !== null) facts.push(`📦 Подписок: ${subscriptions}`);
  if (typeof meta['dryRun'] === 'boolean')
    facts.push(`🧪 Пробный прогон: ${meta['dryRun'] ? 'да' : 'нет'}`);
  const counted: ReadonlyArray<readonly [string, string, boolean]> = [
    // [key, label, show a zero]
    ['scanned', '🔎 Проверено строк', true],
    ['linked', '🔗 Привязано', true],
    ['wouldLink', '🔗 Можно привязать', false],
    ['unrepaired', '🛠 Не удалось исправить', false],
    ['staleIdentityScanned', '🧬 Проверено устаревших привязок', false],
    ['duplicatePairs', '👯 Пар-дубликатов', false],
    ['sharedIdentityPairs', '🔀 Пар с общим профилем на панели', false],
    ['pairsExamined', '🔎 Пар проверено', true],
    ['merged', '🔗 Объединено', true],
    ['wouldMerge', '🔗 Можно объединить', false],
    ['refused', '⛔ Отказано', false],
    ['suppressedSinceLastReport', '🔁 Таких же с прошлого оповещения', false],
  ];
  for (const [key, label, showZero] of counted) {
    const value = countOf(meta[key]);
    if (value !== null && (showZero || value > 0)) facts.push(`${label}: ${value}`);
  }
  if (meta['hasMore'] === true) facts.push('➕ Обработано не всё: остались строки на следующий запуск');
  const fieldList = (value: unknown): string | null =>
    Array.isArray(value) && value.length > 0
      ? `<code>${escapeHtml(value.map((field) => String(field)).join(', '))}</code>`
      : null;
  const unknownFields = fieldList(meta['unknownFields']);
  if (unknownFields !== null) facts.push(`🧬 Незнакомые поля: ${unknownFields}`);
  const missingFields = fieldList(meta['missingFields']);
  if (missingFields !== null) facts.push(`🕳 Нет ожидаемых полей: ${missingFields}`);
  if (typeof meta['panelEra'] === 'string' && meta['panelEra'].length > 0)
    facts.push(`🌊 Поколение панели: <code>${escapeHtml(meta['panelEra'])}</code>`);
  if (typeof meta['panelVersion'] === 'string' && meta['panelVersion'].length > 0)
    facts.push(`🏷 Версия панели: <code>${escapeHtml(meta['panelVersion'])}</code>`);
  if (typeof meta['syncJobId'] === 'string')
    facts.push(`🔄 Задача синхронизации: <code>${escapeHtml(meta['syncJobId'])}</code>`);
  if (typeof meta['transactionId'] === 'string')
    facts.push(`🧾 Транзакция: <code>${escapeHtml(meta['transactionId'])}</code>`);
  return factBlock('🔄 <b>Синхронизация:</b>', facts);
}

// ── Event presentation (emoji + Russian title) ──────────────────────────────

/** The failure header of a type whose title announces a success. */
export interface EventWarningHeader {
  readonly emoji: string;
  readonly title: string;
  /**
   * Also wear this header at INFO when the metadata reports a failure.
   *
   * For a producer that raises a partial result without raising the severity:
   * `broadcast.batch_completed` is INFO whether or not the batch lost
   * recipients, and «Партия рассылки отправлена!» over «40 failed» is the same
   * success-titled failure the warning header exists to end.
   */
  readonly whenMetadata?: (metadata: Readonly<Record<string, unknown>>) => boolean;
}

/** How one registered event type looks on its Telegram card. */
export interface EventPresentation {
  readonly emoji: string;
  readonly title: string;
  /**
   * The header for this type when it is raised as a failure — any severity
   * above INFO, or an INFO its `whenMetadata` recognises.
   *
   * For the handful of types whose title announces a success and whose
   * producers also raise failures under the same type: a backup that never
   * reached Telegram arrived as «Резервная копия создана!», a broadcast that
   * reached 40 of 400 as «Рассылка отправлена!».
   *
   * A header, deliberately, and not a new event type per failure. A new type
   * is not ticked in any saved `selected`-mode selection — registering makes a
   * type tickable, never ticked — so every operator who ticked «backup
   * completed» to hear about backups would have stopped hearing about the
   * failed ones, and every automation rule and outbound webhook bound to the
   * old type would have gone quiet the same way. Only the words on the card
   * change; the stream, the audit log and every subscriber see what they saw.
   */
  readonly warning?: EventWarningHeader;
  /**
   * Headers for producers that raise this type about a different situation,
   * chosen by what their metadata carries. Checked before `warning`.
   *
   * `payment.amount_mismatch` is the case: the manual-review hold is one
   * mechanism for every "money situation a human must settle", so a completion
   * YooKassa refused to confirm is held under it too — and arrived as «Оплачена
   * неверная сумма!» about a payment whose sum nobody disputed.
   */
  readonly variants?: readonly EventHeaderVariant[];
  /**
   * Print the producer's message under the title: at WARNING and above
   * (`'warning'`), or at every severity (`'always'`). Absent — the default,
   * and right for almost every type — the card is title + blocks and the
   * message stays in the audit log and the event feed.
   *
   * Opt in ONLY when the message is Russian text meant for the operator: an
   * automation's own text, or a sentence written in Russian for the card.
   * Producer messages are the English audit-log text. Printed, they put English
   * sentences on Russian cards and restated in English what the blocks already
   * said; a fact that lives only in a message belongs in its metadata, rendered
   * by a block, and an instruction belongs in a Russian `note`.
   * `test/system-events-card-language.spec.ts` renders every type that opts in.
   */
  readonly showMessage?: 'warning' | 'always';
}

/** A header one producer of a shared type wears, picked by its metadata. */
export interface EventHeaderVariant {
  readonly emoji: string;
  readonly title: string;
  readonly when: (metadata: Readonly<Record<string, unknown>>) => boolean;
}

/** One variant per `metadata.reason` value — only the producer named in the table sets it. */
function variantsByReason(
  headers: Readonly<Record<string, { readonly emoji: string; readonly title: string }>>,
): readonly EventHeaderVariant[] {
  return Object.entries(headers).map(([reason, header]) => ({
    ...header,
    when: (metadata) => metadata['reason'] === reason,
  }));
}

/**
 * `system.error` is raised for known situations as well as for crashes. Each
 * of these producers names its own, so the card says what happened instead of
 * «Системная ошибка» over every one of them.
 */
const SYSTEM_ERROR_HEADERS = {
  // `ProfileSyncProcessor` — a sync job failed for good (both failure paths).
  profile_sync_failed: { emoji: '🔄', title: 'Подписка не обновилась в Remnawave' },
  // `ProfileSyncProcessor` — two live subscriptions record one panel profile.
  profile_shared: { emoji: '👯', title: 'Две подписки на одном профиле Remnawave' },
  // `ProfileSyncProcessor` — a DELETE named no profile, the row still names one.
  profile_left_live: { emoji: '🧟', title: 'Профиль в Remnawave, скорее всего, не удалён' },
  // `ProfileSyncProcessor` — the profile was deleted, the row still points at it.
  subscription_without_profile: { emoji: '🕳', title: 'Подписка осталась без профиля в Remnawave' },
  // `BackupProcessor` — the create job failed on its last attempt.
  backup_failed: { emoji: '💾', title: 'Бэкап не создан' },
  // `BackupProcessor` — the Telegram delivery job failed on its last attempt.
  backup_delivery_failed: { emoji: '📤', title: 'Бэкап не доставлен в Telegram' },
  // `BackupProcessor` — a restore threw.
  restore_failed: { emoji: '🧯', title: 'Восстановление базы не удалось' },
  // `PaymentSubscriptionMutationService` — raised at WARNING, still an incident
  // card: an upgrade ends the subscription before a paid, queued period that
  // carries add-ons begins, so those add-ons cannot be delivered.
  upgrade_addons_after_end: {
    emoji: '⏭',
    title: 'Тариф улучшен, а оплаченный следующий период начнётся после конца подписки',
  },
} as const;

/**
 * Per-event-type presentation: a distinctive emoji and a human Russian title
 * for the card header. Keeps the firehose readable at a glance — every event
 * type gets its own identity instead of a generic severity icon. Falls back to
 * `severityEmoji` + the raw `event.message` when a type isn't mapped here.
 */
export const EVENT_PRESENTATION: Record<string, EventPresentation> = {
  // User
  'user.registered': { emoji: '🆕', title: 'Новый пользователь' },
  'user.web_registered': { emoji: '🆕', title: 'Регистрация через сайт' },
  'user.blocked': { emoji: '🔴', title: 'Пользователь заблокирован' },
  'user.unblocked': { emoji: '🟢', title: 'Пользователь разблокирован' },
  'user.deleted': { emoji: '🗑', title: 'Пользователь удалён' },
  // Об АДМИНЕ, не о подписчике: `User.role` не меняется нигде в панели, а
  // единственный производитель этого типа — редактирование учётной записи
  // администратора (`admin-admins.controller.ts`). Прежнее название сказало
  // бы оператору, что кто-то тронул клиента.
  'user.role_changed': { emoji: '🛡', title: 'Изменена роль администратора' },
  'user.telegram_linked': { emoji: '🔗', title: 'Привязан Telegram' },
  'user.email_linked': { emoji: '📧', title: 'Привязан Email' },
  'user.accounts_merged': { emoji: '🧬', title: 'Аккаунты объединены' },
  'user.points_adjusted': { emoji: '🎯', title: 'Изменён баланс баллов' },
  'points.cashback_credited': { emoji: '🪙', title: 'Начислен кэшбэк баллами' },
  'points.cashback_reversed': { emoji: '↩️', title: 'Кэшбэк баллами отменён после возврата' },
  'points.cashback_skipped': { emoji: '⚠️', title: 'Кэшбэк баллами не начислен' },
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
  'subscription.synced': {
    emoji: '🔄',
    title: 'Синхронизация подписки',
    // `InternalUserDevicesController`: the panel issued a new link and the row
    // kept the dead one.
    variants: variantsByReason({
      regenerated_link_lost: { emoji: '🔗', title: 'Новая ссылка подписки не сохранилась' },
    }),
  },
  'subscription.trial_granted': { emoji: '🎁', title: 'Выдан триал' },
  // INFO, not a warning: a customer to help at leisure, one card per
  // subscription. How long it has been and which road reached the customer are
  // the producer's Russian `note`; the customer and the plan have their blocks.
  'subscription.not_connected': { emoji: '⏱', title: 'Клиент не подключился после покупки' },
  // Emitted with category PAYMENT (see the emit site in
  // `PaymentSubscriptionMutationService`), which is why its tick-box lives
  // under «Платежи» even though the constant sits in the Subscription block.
  'trial.claim_late_success_over_cap': {
    emoji: '⏳',
    title: 'Поздняя оплата триала прошла сверх квоты',
  },

  // Payment
  'payment.checkout_created': { emoji: '🧾', title: 'Создан счёт на оплату' },
  // WARNING: the money arrived and something about it needs a decision — today
  // that is a customer blocked between invoice and payment.
  'payment.completed': {
    emoji: '💰',
    title: 'Платёж получен',
    warning: { emoji: '⚠️', title: 'Платёж получен, нужна проверка' },
  },
  'payment.failed': { emoji: '❌', title: 'Платёж не прошёл' },
  'payment.refunded': { emoji: '↩️', title: 'Платёж возвращён' },
  'payment.refund_partial': { emoji: '⚠️', title: 'Частичный возврат платежа' },
  'payment.amount_mismatch': {
    emoji: '⚠️',
    title: 'Оплачена неверная сумма',
    variants: [
      {
        // `PaymentReconciliationService.flagUnconfirmedCompletionForReview`:
        // YooKassa's own answer contradicted a "succeeded" notification. Only
        // that producer sets `verificationReason`; the underpayment hold never
        // does, so the key is the whole difference.
        emoji: '🛡',
        title: 'Платёж не подтверждён провайдером',
        when: (metadata) => isPresent(metadata['verificationReason']),
      },
      {
        // `PaymentPendingExpiryService.handImportedPaymentToOperator`: a
        // checkout imported from another bot, still pending there, that
        // YooKassa reports paid. Nobody delivered it and the panel will not.
        // Only that producer sets `importedFrom`.
        emoji: '📦',
        title: 'Перенесённый платёж оплачен, выдачи не было',
        when: (metadata) => isPresent(metadata['importedFrom']),
      },
      {
        // `PaymentReconciliationService.reconcileWebhookEvent`: the provider
        // reports a payment we refunded in full as paid, after the refund. The
        // payment stays refunded; an operator decides. Only that producer sets
        // `paidAfterRefund`.
        emoji: '↩️',
        title: 'Провайдер сообщает об оплате возвращённого платежа',
        when: (metadata) => metadata['paidAfterRefund'] === true,
      },
    ],
  },
  // Reads as a note, not as a task: ℹ️ against the ⚠️ above, and the outcome
  // («Платёж проведён») before the discrepancy. The operator has to be able to
  // skip this one and open the mismatch card without reading either.
  'payment.notified_amount_short': {
    emoji: 'ℹ️',
    title: 'Платёж проведён, но сумма в уведомлении меньше',
  },
  // Money that arrived and was not applied: a task, like the mismatch above.
  // The note says what happened and where the operator records the refund.
  'payment.withheld': {
    emoji: '⚠️',
    title: 'Платёж получен, но не применён',
  },
  // Its refund, told to the operator alone; the message says in full or in part.
  'payment.withheld_refunded': { emoji: '↩️', title: 'Возврат неприменённого платежа' },
  // A dispute the panel could not pin on one charge: a task, with its note.
  'payment.chargeback_unmatched': { emoji: '⚠️', title: 'Оспорено списание по автоплатежу' },
  'payment.expired': { emoji: '⌛', title: 'Счёт на оплату истёк' },
  'payment.webhook_received': { emoji: '📩', title: 'Вебхук платёжки' },
  'payment.fulfillment_recovered': { emoji: '🛟', title: 'Восстановлено исполнение платежа' },
  'payment.method_saved': { emoji: '💳', title: 'Сохранён способ оплаты' },
  'payment.method_unbound': { emoji: '🚫', title: 'Отвязан способ оплаты' },
  'payment.method_autopay_updated': { emoji: '🔁', title: 'Изменено автосписание' },
  // The operator's own switch, from the user's card; the note says what the provider did.
  'payment.autopay_stopped_by_operator': { emoji: '⏹', title: 'Автосписание отключено в панели' },
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
    // `PartnerBalancePaymentService`: the debt is recorded, so the recovery
    // sweep retries it every five minutes — the money is late, not lost.
    variants: variantsByReason({
      refund_owed_retrying: { emoji: '⏳', title: 'Возврат партнёру задержался — панель повторит сама' },
    }),
  },

  // Promocode
  'promocode.activated': {
    emoji: '🎟',
    title: 'Промокод активирован',
    // `PromocodeLifecycleService`, the ERROR branch: the reward's sync job was
    // written but not queued; the sweep queues it within five minutes.
    variants: variantsByReason({
      sync_enqueue_failed: { emoji: '⏳', title: 'Промокод активирован, в Remnawave награда придёт позже' },
    }),
  },
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
  // WARNING is every way a backup failed to get off the box: not delivered,
  // too large, the relay never confirmed, or retention deleted the only copy.
  // The «Доставка» line says which — no `showMessage`: every producer's
  // sentence restates that line (and the file name) in English.
  'system.backup_completed': {
    emoji: '🗄',
    title: 'Резервная копия создана',
    warning: { emoji: '⚠️', title: 'Резервная копия не доставлена в Telegram' },
  },
  // WARNING is a restore whose pending migrations did not run; the backup
  // block's «Миграции» line says so. What to do about it — restart the API
  // container — is its producer's `note` to give, in Russian.
  'system.restore_completed': {
    emoji: '♻️',
    title: 'База восстановлена из копии',
    warning: { emoji: '⚠️', title: 'База восстановлена, но миграции не применены' },
  },
  // WARNING is the partial delivery; delivered-to-nobody is ERROR and gets the
  // incident card. Both counts are in the details block, so no message.
  'system.broadcast_sent': {
    emoji: '📢',
    title: 'Рассылка отправлена',
    warning: { emoji: '⚠️', title: 'Рассылка доставлена не всем' },
    variants: [
      {
        // `BroadcastDeliveryService.checkAndFinalize`, the ERROR branch: not one
        // send went through. «Доставлена не всем» reads as «part of it arrived»
        // about a broadcast none of which did. Only that producer sets the key.
        emoji: '🚫',
        title: 'Рассылка не дошла ни до кого',
        when: (metadata) => metadata['reason'] === 'nobody_reached',
      },
    ],
  },
  'system.bulk_users_executed': { emoji: '👥', title: 'Массовая операция над пользователями' },
  'system.error': {
    emoji: '🚨',
    title: 'Системная ошибка',
    variants: variantsByReason(SYSTEM_ERROR_HEADERS),
  },
  'system.web_push_unconfigured': {
    emoji: '🔕',
    title: 'Web-push не настроен',
    variants: [
      {
        // `WebPushService`, the ERROR branch: keys exist in the environment
        // but could not be moved into the panel, so every push is dropped.
        // Its `reason` is the adoption failure's own text, hence this flag.
        emoji: '🔕',
        title: 'Web-push выключен: ключи не перенесены в панель',
        when: (metadata) => metadata['legacyEnvKeysStranded'] === true,
      },
    ],
  },
  // WARNING is a recall that removed only part of a batch, or a stalled or lost
  // broadcast the reconciler put back in the queue. Every count, the channel
  // copy's fate and the revival attempt are in the «Рассылка» block.
  'broadcast.started': {
    emoji: '📣',
    title: 'Рассылка запущена',
    warning: { emoji: '⚠️', title: 'Проблема с рассылкой' },
  },
  // Always INFO, failures or not (`BroadcastProcessor.handleBatch`); the
  // «Рассылка» block carries its counts.
  'broadcast.batch_completed': {
    emoji: '📬',
    title: 'Партия рассылки отправлена',
    warning: {
      emoji: '⚠️',
      title: 'Партия рассылки доставлена не всем',
      whenMetadata: (metadata) => Number(metadata['failed'] ?? 0) > 0,
    },
  },
  // Why the copy did not go (`channelPost`: `dropped` / `disabled`) is a line
  // of the «Рассылка» block.
  'broadcast.channel_post_undelivered': { emoji: '📭', title: 'Пост в канал не доставлен' },
  // The «Импорт» block carries what the three INFO producers counted;
  // `import.failed` is ERROR and never reaches this card.
  'import.completed': { emoji: '📥', title: 'Импорт завершён' },
  'import.plan_assigned': { emoji: '🏷', title: 'Массовое назначение плана' },
  'plan.retired_removed': { emoji: '🗑', title: 'Тариф удалён: на нём никого не осталось' },
  'import.sync_enqueued': {
    emoji: '🔄',
    title: 'Синхронизация после импорта поставлена в очередь',
  },
  // The message is the operator's own text from the rule; the card without it
  // was a notification that notified nobody of anything. Never capped — see
  // `isOperatorWrittenMessage` — and not printed when it is the rule's
  // English default text (`isDefaultAutomationText`).
  'automation.telegram_notify': {
    emoji: '🤖',
    title: 'Автоматизация: уведомление',
    showMessage: 'always',
  },
  // The DEFAULT type of the `system_event` action. A rule that names its own
  // type keeps doing so and lands under the catch-all tick-box instead — this
  // entry exists so the common case (no `type` in the action params) reads
  // like every other event rather than like an unregistered one.
  'automation.custom': {
    emoji: '🤖',
    title: 'Автоматизация: своё событие',
    showMessage: 'always',
  },
  // These three never reach `formatTelegramMessage`: `isErrorEvent` matches
  // ERROR severity OR a kind ending in `.error`, and error events are rendered
  // by `formatErrorEventCardHtml`. Their titles are NOT unused, though —
  // `errorCardHeader` hands them to that card, which used to open every error
  // with one constant sentence. Registered here so the rest of the card
  // follows if the severity or the routing ever changes, and so no type is
  // registered in two lists out of three.
  'import.failed': { emoji: '🚨', title: 'Импорт не удался' },
  'client.error': { emoji: '🖥', title: 'Ошибка в админ-панели' },
  'reiwa.error': { emoji: '🚨', title: 'Ошибка в reiwa' },
  // No message: its sentence is `Reiwa relay did not deliver <route>
  // (<status>)`, and the route and the status are both in the details block.
  'reiwa.relay_undelivered': { emoji: '📡', title: 'Вебхук в reiwa не доставлен' },
  // The message carries what the operator does about it («Telegram отклонил
  // токен бота — проверьте…»), which no metadata key renders.
  'telegram.direct_undelivered': {
    emoji: '📵',
    title: 'Панель не доставила карточку в Telegram',
    showMessage: 'warning',
  },
  // Ten producers, all of whose sentences are English paragraphs. Their counts
  // and identifiers are in the «Синхронизация» block; the instructions several
  // of them exist to give are their producers' `note`s to write, in Russian.
  'system.remnawave_sync': {
    emoji: '🔄',
    title: 'Синхронизация с Remnawave',
    // `DuplicateSubscriptionMergeService`: a run stopped part-way.
    variants: variantsByReason({
      merge_stopped: { emoji: '⏸', title: 'Слияние подписок-дубликатов остановилось' },
    }),
  },
  'settings.email.updated': { emoji: '⚙️', title: 'Обновлены настройки почты' },
  'notification.template.created': { emoji: '📝', title: 'Создан шаблон уведомления' },
  'notification.template.updated': { emoji: '📝', title: 'Обновлён шаблон уведомления' },
  'notification.template.deleted': { emoji: '🗑', title: 'Удалён шаблон уведомления' },
  'notification.template.seeded': { emoji: '🌱', title: 'Засеяны шаблоны уведомлений' },

  // User traffic usage (detected from Remnawave webhooks; category USER → topic «Пользователи»).
  'user.first_traffic': { emoji: '📶', title: 'Пользователь начал использовать трафик' },
  'user.pwa_installed': { emoji: '📲', title: 'Приложение установлено на устройство' },

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

/**
 * Which notification a payment gateway sent — the one thing «Вебхук
 * платёжки» has to say, because the four kinds mean very different things
 * to an operator: a payment notification is the ordinary case, a
 * subscription callback is an autopay charge, and a card binding is a
 * zero-amount setup that moves no money at all.
 */
function humanizeWebhookKind(value: unknown): string {
  switch (String(value)) {
    case 'payment':
      return 'Уведомление об оплате';
    case 'subscription-status':
      return 'Статус подписки у провайдера';
    case 'subscription-charge':
      return 'Списание по подписке';
    case 'card-binding':
      return 'Привязка карты';
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
    // `SubscriptionDeletionService`: the customer removed it in the cabinet.
    case 'SELF_SERVICE_DELETE':
      return 'Удаление пользователем в кабинете';
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
 * The broadcast refusals' own `reason` codes, in the operator's words.
 *
 * They are not sources, and `humanizeSource` - the map every `reason` went
 * through - hands an unknown value back unchanged. So `connect_signal_down`
 * was printed exactly like that: Latin, snake_case, on a Russian card.
 *
 * Short on purpose. What to DO about it is `why`, printed on the line below
 * this one; this is the handle, not the explanation.
 */
const BROADCAST_REFUSAL_REASONS: Readonly<Record<string, string>> = {
  caption_too_long: 'подпись длиннее предела Telegram',
  promo_unusable: 'промокод нельзя отправить',
  connect_unreadable: 'фильтр «Подключение VPN» не читается',
  connect_signal_down: 'проверка подключений не отличает подключившихся',
  connect_too_many: 'получателей больше предела',
  connect_timeout: 'получателей не удалось посчитать за 10 секунд',
  connect_failed: 'получателей не удалось посчитать',
  recall_no_bot_token: 'не задан токен бота',
  recall_all_rejected: 'не прошло ни одно удаление',
  staging_never_ran: 'ни одного получателя не набралось',
  revived: 'рассылка возвращена в очередь',
  nobody_reached: 'не прошла ни одна отправка',
};

/**
 * A `reason` in the operator's words: a broadcast refusal code first, then the
 * source map, then - deliberately - the raw value. An untranslated truth beats
 * a translated guess, and the raw code is what an operator quotes when asking.
 */
function humanizeReason(value: unknown): string {
  return BROADCAST_REFUSAL_REASONS[String(value)] ?? humanizeSource(value);
}

/**
 * Tolerant date formatter: ISO/Date-ish values render as `ru-RU` locale
 * date+time in `timeZone`, with the zone named; anything else
 * (already-formatted strings, plain labels) is returned escaped as-is so the
 * card never shows "Invalid Date".
 */
function fmtDate(value: unknown, timeZone: string): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? escapeHtml(String(value))
      : fmtInstant(value, timeZone);
  }
  if (typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? escapeHtml(String(value)) : fmtInstant(d, timeZone);
  }
  if (typeof value === 'string') {
    // Only attempt parsing for ISO-like strings to avoid mangling labels.
    if (/^\d{4}-\d{2}-\d{2}[T\s]/.test(value) || /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const d = new Date(value);
      if (!Number.isNaN(d.getTime())) return fmtInstant(d, timeZone);
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
