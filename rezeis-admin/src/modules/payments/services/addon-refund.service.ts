import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  AddOnEntitlementActorType,
  AddOnEntitlementState,
  AddOnType,
  Prisma,
  SubscriptionStatus,
  SubscriptionTermStatus,
  SyncAction,
  SyncJobStatus,
  type Transaction,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { readAddOnRolloutFlags } from '../../add-on-entitlements/add-on-rollout.config';
import { ADD_ON_NOTICE_COMMAND_KEY } from '../../add-on-entitlements/addon-expiry-notice.constants';
import { GIB_BYTES } from '../../add-on-entitlements/domain/cutover-baseline';
import { AddOnEntitlementService } from '../../add-on-entitlements/services/add-on-entitlement.service';
import { resolveRecordedAddOnContribution } from '../../add-on-entitlements/services/configured-baseline.util';
import { DeviceReductionExecutionService } from '../../add-on-entitlements/services/device-reduction-execution.service';
import { DeviceReductionPlanService } from '../../add-on-entitlements/services/device-reduction-plan.service';
import { EffectiveProjectionService } from '../../add-on-entitlements/services/effective-projection.service';
import { SubscriptionTermService } from '../../add-on-entitlements/services/subscription-term.service';
import { AddOnSwitchesService } from '../../add-on-entitlements/switches/add-on-switches.service';
import { ProfileSyncQueueService } from '../../profile-sync/profile-sync-queue.service';
import { writeTransactionGatewayData } from '../utils/transaction-gateway-data.util';
import {
  ADD_ON_LEDGER_NO_OP_NOTES,
  ADD_ON_LEDGER_SOURCE,
  PAID_TRAFFIC_RESET_CAUSE,
  paidResetSettledPayloadSql,
  readAddOnNotApplied,
} from '../utils/add-on-not-applied.util';

/**
 * Stamped on a refunded add-on payment, in the same database transaction that
 * took the add-on off the subscription's columns: a second run of the same
 * refund finds it and lowers nothing again.
 */
export const ADDON_REFUND_ENDED_AT_KEY = 'addOnRefundEndedAt';

/** The incident a refund records on a durable add-on (`recordRefundOrChargebackInTransaction`). */
export const ADDON_REFUNDED_SUMMARY = 'ADDON_REFUNDED';
/** The same, for a chargeback. */
export const ADDON_CHARGEBACK_SUMMARY = 'ADDON_CHARGEBACK';

/**
 * `planSnapshot.snapshotSource` of the term a refund rebases the period onto:
 * an add-on bought before the term model is part of the base the cutover
 * minted, and the rest of the period stands on a base without it.
 *
 * Listed by value in `NON_MONEY_TERM_SOURCES` (`cutover-disposal.util.ts`): the
 * rebase records no payment, and the term it replaces stays and keeps its own
 * verdict. Renaming it here without there makes a merge or a deletion refuse.
 */
export const ADDON_REFUND_REBASED_TERM = 'ADDON_REFUND_REBASED_TERM';

/** Which door the money went back through: a refund, or the payer's chargeback. */
export type AddOnRefundKind = 'REFUND' | 'CHARGEBACK';

/** What a refund did to the add-on it paid for. */
export interface AddOnRefundOutcome {
  /** Nothing of the add-on is left to the customer: ended now, or there was nothing left to end. */
  readonly ended: boolean;
  /** The sentence the refund card's «📝 Заметка» carries. */
  readonly note: string;
  /** Folded into the reversal's own `gatewayData` write, beside the rest of its audit. */
  readonly audit: Record<string, unknown>;
  /** Profile-sync jobs written with the change, enqueued once it is committed. */
  readonly syncJobIds: readonly string[];
  /**
   * A subscription whose extra devices the device reduction takes off, after
   * the answer: a durable device add-on that counted when it was refunded.
   */
  readonly reduceDevicesOf: string | null;
  /**
   * With {@link reduceDevicesOf}: what WILL happen to the extra devices, by
   * stage 6 («Удалять лишние устройства автоматически») — the line the card carries unless
   * the refund's own run of the reduction finishes before it goes out
   * ({@link AddOnRefundService.reduceDevices}), whose line replaces it.
   */
  readonly devicesLine: string | null;
  /** The add-on as the card names it (`🛒 Докупка:`). */
  readonly addOnType: AddOnType | null;
  readonly addOnValue: number | null;
}

/** The add-on marker an add-on checkout writes into `planSnapshot` (`AddOnPurchaseService`). */
interface RefundedAddOnMarker {
  readonly addOnType: AddOnType;
  readonly addOnValue: number;
  readonly targetSubscriptionId: string | null;
}

/**
 * «Возврат денег за докупку заканчивает её сразу» — the owner's decision of
 * 24.09.2026: a refund of an add-on ends the add-on at once, and the operator's
 * card says so. Every door into the one reversal
 * (`PaymentReconciliationService.reverseFulfilledPayment`) comes here: the
 * panel's «Вернуть», «Отметить возврат», a provider's refund notice, a
 * chargeback.
 *
 * Two kinds of add-on, one rule:
 *
 *  - DURABLE — the purchase is an entitlement (`AddOnEntitlement`, keyed by the
 *    paying transaction). The refund is recorded on it
 *    (`recordRefundOrChargebackInTransaction`, an incident an operator can
 *    read) and it is REVERSED through the state machine; the projection is
 *    recomputed, the columns mirror it and a sync pushes it — the path an
 *    operator's reversal and an expiry take. A DEVICE add-on that still counts
 *    is handed to the regular device-reduction queue instead: it begins its
 *    expiry now, so the boundary sweep plans the reduction, runs it when
 *    stage 6 is on, retries it as it retries an expiry's (a stop, an
 *    unreachable panel), and completes it as REVERSED — a refund, not an
 *    expiry (`EntitlementBoundaryService`). The refund's own run after the
 *    answer only gets there first ({@link reduceDevices}).
 *  - LEGACY — a raw `+N` on the subscription's columns, with no entitlement.
 *    The column is lowered by the add-on's value from its purchase marker,
 *    never below the plan's value (`planSnapshot`), and pushed. Where the
 *    subscription is in the term model the projection has the last word, and
 *    an add-on bought before the model is inside the base the background
 *    cutover minted from the columns: the rest of the period is rotated onto a
 *    term whose base is lowered by the add-on's value, never below the plan
 *    (`SubscriptionTermService.rebaseActiveTermInTransaction`), then
 *    recomputed and pushed ({@link endLegacyInTermModel}).
 *
 * THE LOCK ORDER is the subscription row, then its add-ons — the order every
 * term writer and the boundary sweep keep. Taken the other way round (the
 * add-on first, then the recompute's subscription lock) a refund and the sweep
 * expiring the same add-on deadlocked.
 *
 * Never throws: the money is already back, and the card says what could not be
 * done.
 */
@Injectable()
export class AddOnRefundService {
  private readonly logger = new Logger(AddOnRefundService.name);
  private readonly terms: SubscriptionTermService;

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly entitlements: AddOnEntitlementService,
    private readonly projections: EffectiveProjectionService,
    private readonly profileSyncQueue: ProfileSyncQueueService,
    @Optional() private readonly devicePlans?: DeviceReductionPlanService,
    @Optional() private readonly deviceExecution?: DeviceReductionExecutionService,
    // `AddOnEntitlementsModule` exports it and `PaymentsModule` imports that
    // module, so Nest injects the shared instance; the fallback — the same
    // stateless service — keeps the hand-built services of the specs as they are.
    @Optional() terms?: SubscriptionTermService,
    /** The stage switches; `@Optional()` only for the specs that build this by hand. */
    @Optional() private readonly addOnSwitches?: AddOnSwitchesService,
  ) {
    this.terms = terms ?? new SubscriptionTermService();
  }

  /**
   * Ends the add-on a refunded payment paid for, in the database, before the
   * refund's answer. `null` when the payment bought no add-on. Never throws.
   */
  public async endForRefund(transaction: Transaction, kind: AddOnRefundKind): Promise<AddOnRefundOutcome | null> {
    const marker = readRefundedAddOnMarker(transaction.planSnapshot);
    // What the add-on is, for a card that has to say it could not be ended.
    let known: { readonly type: AddOnType; readonly value: number } | null =
      marker === null ? null : { type: marker.addOnType, value: marker.addOnValue };
    try {
      const rows = await this.prismaService.addOnEntitlement.findMany({
        where: { sourceTransactionId: transaction.id },
        select: { id: true, subscriptionId: true, type: true, state: true, totalValue: true },
        orderBy: { id: 'asc' },
      });
      if (known === null && rows[0] !== undefined) {
        known = { type: rows[0].type, value: entitlementValue(rows[0].type, rows[0].totalValue) };
      }
      let outcome: AddOnRefundOutcome | null = null;
      if (rows.length > 0) {
        outcome = await this.endDurable(
          transaction,
          kind,
          rows.map((row) => row.subscriptionId),
          marker,
        );
      } else if (marker !== null && (await this.addedNothing(transaction, marker))) {
        // Settled without adding anything — not applied, or on a subscription
        // unlimited in what it adds (`add-on-not-applied.util.ts`). Taken for a
        // raw `+N`, its refund lowered the column, or rebased the ACTIVE term,
        // by a value it never added: traffic or devices the customer had from
        // somewhere else (FX5 item 4).
        outcome = {
          ended: true,
          note: `Докупка «${describeAddOn(marker.addOnType, marker.addOnValue)}» не была применена — отключать нечего.`,
          audit: { addOnRefundNothingApplied: true },
          syncJobIds: [],
          reduceDevicesOf: null,
          devicesLine: null,
          addOnType: marker.addOnType,
          addOnValue: marker.addOnValue,
        };
      } else if (marker !== null) {
        outcome = await this.endLegacy(transaction, marker);
      }
      if (outcome !== null) await this.enqueue(outcome.syncJobIds, transaction.id);
      return outcome;
    } catch (error: unknown) {
      this.logger.error(`Could not end the add-on of refunded transaction ${transaction.id}: ${describeError(error)}`);
      if (known === null) return null;
      const name = describeAddOn(known.type, known.value);
      return {
        ended: false,
        // A reset nobody could read may be performed or not: never «уже
        // выполнен» for one never seen performed (review R5-08).
        note:
          known.type === AddOnType.RESET_TRAFFIC
            ? `Сброс трафика по докупке «${name}»: ${MANUAL_LIMIT_HINT[AddOnType.RESET_TRAFFIC]}`
            : `Докупку «${name}» панель не отключила: ${MANUAL_LIMIT_HINT[known.type]}`,
        audit: { addOnRefundFailed: true },
        syncJobIds: [],
        reduceDevicesOf: null,
        devicesLine: null,
        addOnType: known.type,
        addOnValue: known.value,
      };
    }
  }

  /**
   * The refund's own run of the device reduction, after the answer: the step
   * the boundary sweep takes for the same add-on within five minutes anyway —
   * it is a due EXPIRING row in the regular queue ({@link endDurable}) — taken
   * now, so the card can say what happened. Returns the line the card carries
   * INSTEAD of the one {@link endForRefund} predicted, or `null` when there
   * was nothing to take off. Never throws: what this run cannot finish, the
   * queue retries.
   */
  public async reduceDevices(subscriptionId: string): Promise<string | null> {
    const autoCleanup = await this.readDeviceCleanupAuto(subscriptionId);
    if (autoCleanup === null) return MANUAL_DEVICES_LINE;
    const predicted = predictedDevicesLine(subscriptionId, autoCleanup);
    if (this.devicePlans === undefined) return predicted;
    try {
      const planning = await this.devicePlans.planForSubscription(subscriptionId);
      switch (planning.status) {
        case 'VERIFIED':
        case 'NOT_APPLICABLE':
          return null;
        case 'PLANNED': {
          if (!autoCleanup || this.deviceExecution === undefined) return predicted;
          const run = await this.deviceExecution.executePlan(planning.planId);
          if (run.status === 'APPLIED') {
            return run.deleted > 0 ? `Лишние устройства удалены: ${run.deleted}.` : null;
          }
          this.logger.warn(`Device reduction after the refund on subscription ${subscriptionId} ended ${run.status}`);
          if (run.status === 'DEFERRED') return DEVICES_RETRY_LINE;
          // A stop only a person clears; anything else, the queue runs again.
          return run.status === 'BLOCKED' || run.status === 'REMEDIATION_REQUIRED' ? MANUAL_DEVICES_LINE : predicted;
        }
        case 'DEFERRED':
          this.logger.warn(`Device reduction after the refund on subscription ${subscriptionId}: DEFERRED (${planning.reason})`);
          return autoCleanup ? DEVICES_RETRY_LINE : predicted;
        case 'BLOCKED':
          this.logger.warn(`Device reduction after the refund on subscription ${subscriptionId}: BLOCKED (${planning.reason})`);
          return MANUAL_DEVICES_LINE;
      }
    } catch (error: unknown) {
      this.logger.error(`Device reduction after the refund on subscription ${subscriptionId} failed: ${describeError(error)}`);
      return predicted;
    }
  }

  /**
   * Stage 6 as it stands, for what the card says about the devices — or
   * `null` when the switches cannot be read. Never thrown: a card's forecast
   * must not keep a refund from ending the add-on. Without the switch there is
   * no knowing whether the panel removes the devices itself, and the card must
   * never promise that it does; its caller then gives the hand-made way, which
   * is always right, at worst redundant.
   */
  private async readDeviceCleanupAuto(subscriptionId: string): Promise<boolean | null> {
    try {
      return (await readAddOnRolloutFlags(this.addOnSwitches)).deviceCleanupAuto;
    } catch (error: unknown) {
      this.logger.error(
        `Refund on subscription ${subscriptionId}: the add-on switches could not be read: ${describeError(error)}`,
      );
      return null;
    }
  }

  private async endDurable(
    transaction: Transaction,
    kind: AddOnRefundKind,
    subscriptionIds: readonly string[],
    marker: RefundedAddOnMarker | null,
  ): Promise<AddOnRefundOutcome> {
    const correlationId = `refund:${transaction.paymentId}`;
    const summaryCode = kind === 'CHARGEBACK' ? ADDON_CHARGEBACK_SUMMARY : ADDON_REFUNDED_SUMMARY;
    // Read before the transaction: only the card's forecast for the devices
    // depends on it, and a settings read has no place under these row locks.
    const deviceCleanupAuto = await this.readDeviceCleanupAuto([...subscriptionIds].sort().join(','));
    return this.prismaService.$transaction(async (tx) => {
      // THE SUBSCRIPTION ROWS FIRST, one at a time in id order, and only then
      // the add-ons — the order the boundary sweep and every term writer keep.
      // Taken the other way round (the add-on by the refund's record, the
      // subscription by the recompute after it), a refund and the sweep
      // expiring the same add-on deadlocked, and a refund that lost could not
      // run again.
      const locked = new Set<string>();
      for (const subscriptionId of [...new Set(subscriptionIds)].sort()) {
        await lockSubscription(tx, subscriptionId);
        locked.add(subscriptionId);
      }
      // Read again under those locks: the sweep may have moved one since.
      const rows = await tx.addOnEntitlement.findMany({
        where: { sourceTransactionId: transaction.id },
        select: {
          id: true,
          subscriptionId: true,
          type: true,
          state: true,
          totalValue: true,
          expiresAt: true,
          scheduledActivationAt: true,
        },
        orderBy: { id: 'asc' },
      });
      const lines: string[] = [];
      const syncJobIds: string[] = [];
      const reversed: string[] = [];
      const expiring: string[] = [];
      const touched = new Set<string>();
      const now = new Date();
      let reduceDevicesOf: string | null = null;
      let ended = true;
      for (const row of rows) {
        if (!locked.has(row.subscriptionId)) {
          await lockSubscription(tx, row.subscriptionId);
          locked.add(row.subscriptionId);
        }
        const name = describeAddOn(row.type, entitlementValue(row.type, row.totalValue));
        await this.entitlements.recordRefundOrChargebackInTransaction(tx, {
          entitlementId: row.id,
          commandKey: `refund-record:${transaction.id}`,
          supportRef: `addon-refund:${transaction.id}:${row.id}`,
          summaryCode,
          correlationId,
          metadata: { transactionId: transaction.id, paymentId: transaction.paymentId },
        });
        if (row.state === AddOnEntitlementState.EXPIRED || row.state === AddOnEntitlementState.REVERSED) {
          lines.push(`Докупка «${name}» уже закончилась раньше — отключать было нечего.`);
          continue;
        }
        if (row.state === AddOnEntitlementState.REMEDIATION_REQUIRED) {
          ended = false;
          lines.push(`Докупку «${name}» панель не отключила: она ждёт разбора в «Доп. услуги» → вкладка «Доставка».`);
          continue;
        }
        // A DEVICE add-on that still counts, or whose reduction is under way,
        // goes to the regular reduction queue rather than straight to
        // REVERSED: a REVERSED row leaves the queue, and a reduction the
        // refund's own run could not finish — a stop, a panel that did not
        // answer — was never tried again. As a due EXPIRING row it is
        // planned, run and retried by the boundary sweep as an expiry's is,
        // and completed as REVERSED, the refund it is
        // (`EntitlementBoundaryService`).
        if (
          row.type === AddOnType.EXTRA_DEVICES &&
          (row.state === AddOnEntitlementState.ACTIVE || row.state === AddOnEntitlementState.EXPIRING)
        ) {
          if (row.state === AddOnEntitlementState.ACTIVE) {
            await this.beginExpiryNow(tx, row, { transactionId: transaction.id, correlationId, summaryCode, now });
            touched.add(row.subscriptionId);
          }
          expiring.push(row.id);
          lines.push(`Докупка «${name}» отключена.`);
          reduceDevicesOf = row.subscriptionId;
          continue;
        }
        const reversal = await this.entitlements.transitionInTransaction(tx, {
          entitlementId: row.id,
          command: 'REVERSE',
          commandKey: `refund-reverse:${transaction.id}`,
          correlationId,
          actorType: AddOnEntitlementActorType.SYSTEM,
          reason: summaryCode,
        });
        reversed.push(row.id);
        lines.push(`Докупка «${name}» отключена.`);
        if (reversal.changed) touched.add(row.subscriptionId);
      }
      for (const subscriptionId of touched) {
        const jobId = await this.pushProjection(tx, subscriptionId, transaction.paymentId);
        if (jobId !== null) syncJobIds.push(jobId);
      }
      return {
        ended,
        note: lines.join(' '),
        audit: {
          [ADDON_REFUND_ENDED_AT_KEY]: now.toISOString(),
          addOnRefundReversedEntitlements: reversed,
          ...(expiring.length === 0 ? {} : { addOnRefundDeviceReductionQueued: expiring }),
        },
        syncJobIds,
        reduceDevicesOf,
        devicesLine:
          reduceDevicesOf === null
            ? null
            : deviceCleanupAuto === null
              ? MANUAL_DEVICES_LINE
              : predictedDevicesLine(reduceDevicesOf, deviceCleanupAuto),
        addOnType: marker?.addOnType ?? rows[0]?.type ?? null,
        addOnValue: marker?.addOnValue ?? (rows[0] === undefined ? null : entitlementValue(rows[0].type, rows[0].totalValue)),
      };
    });
  }

  /**
   * Hands a refunded device add-on to the regular reduction queue, under the
   * subscription lock the caller holds: its end is now (never at or before its
   * own start — `add_on_entitlements_boundary_check`) and it begins its
   * expiry, so it drops out of the projection here and is a due EXPIRING row
   * for the boundary sweep.
   *
   * The customer's «Опция закончилась» is decided here as well — not owed: a
   * refunded add-on did not run out, and «Купить снова» under it would be
   * wrong. Recorded the way the notice pass records a decision
   * (`AddOnExpiryNoticeService`, `ADD_ON_NOTICE_COMMAND_KEY.ended`), which is
   * what keeps that pass from ever selecting the row.
   */
  private async beginExpiryNow(
    tx: Prisma.TransactionClient,
    row: { readonly id: string; readonly expiresAt: Date | null; readonly scheduledActivationAt: Date },
    input: { readonly transactionId: string; readonly correlationId: string; readonly summaryCode: string; readonly now: Date },
  ): Promise<void> {
    const endsAt = new Date(Math.max(input.now.getTime(), row.scheduledActivationAt.getTime() + 1_000));
    await tx.addOnEntitlement.updateMany({
      where: { id: row.id, state: AddOnEntitlementState.ACTIVE },
      data: { expiresAt: endsAt, version: { increment: 1 } },
    });
    await this.entitlements.transitionInTransaction(tx, {
      entitlementId: row.id,
      command: 'BEGIN_EXPIRY',
      commandKey: `refund-expire:${input.transactionId}`,
      correlationId: input.correlationId,
      actorType: AddOnEntitlementActorType.SYSTEM,
      reason: input.summaryCode,
      metadata: { previousExpiresAt: row.expiresAt?.toISOString() ?? null, expiresAt: endsAt.toISOString() },
    });
    await tx.addOnEntitlementEvent.createMany({
      data: [
        {
          entitlementId: row.id,
          fromState: AddOnEntitlementState.EXPIRING,
          toState: AddOnEntitlementState.EXPIRING,
          reason: 'CUSTOMER_NOTICE_ENDED',
          actorType: AddOnEntitlementActorType.SYSTEM,
          correlationId: input.correlationId,
          commandKey: ADD_ON_NOTICE_COMMAND_KEY.ended,
          metadata: { outcome: 'refunded', summaryCode: input.summaryCode, expiresAt: endsAt.toISOString() },
        },
      ],
      skipDuplicates: true,
    });
  }

  /**
   * Whether the add-on payment was settled without adding anything: its
   * capture's stamp (`addOnNotApplied`, `add-on-not-applied.util.ts`), or — a
   * capture from before the stamp — the ledger no-op it left, the
   * `ADDON_PURCHASE_LEDGER` push of this payment with a no-op note
   * (`profile_sync_jobs` is never pruned). Read from the rows as they are now.
   * A capture that went down the old raw increment and added nothing (an
   * unlimited column, a refused value) left no such mark; its refund reads the
   * column as before, and an unlimited one is still left alone.
   */
  private async addedNothing(transaction: Transaction, marker: RefundedAddOnMarker): Promise<boolean> {
    const current = await this.prismaService.transaction.findUnique({
      where: { id: transaction.id },
      select: { gatewayData: true, subscriptionId: true },
    });
    if (readAddOnNotApplied(current?.gatewayData ?? transaction.gatewayData) !== null) return true;
    const subscriptionId = current?.subscriptionId ?? transaction.subscriptionId ?? marker.targetSubscriptionId;
    const noOp = await this.prismaService.profileSyncJob.findFirst({
      where: {
        ...(subscriptionId === null ? {} : { subscriptionId }),
        AND: [
          { payload: { path: ['paymentId'], equals: transaction.paymentId } },
          { payload: { path: ['source'], equals: ADD_ON_LEDGER_SOURCE } },
          { OR: ADD_ON_LEDGER_NO_OP_NOTES.map((note) => ({ payload: { path: ['note'], equals: note } })) },
        ],
      },
      select: { id: true },
    });
    return noOp !== null;
  }

  /**
   * The full refund of a paid «Обнулить трафик» (R5-01). A reset performed
   * cannot be taken back. One not performed yet is CLOSED here, in one
   * statement against the claim of whoever would perform it — the capture's
   * run, or the profile-sync worker, both of which claim it the same way — so
   * exactly one of the two wins, and nothing performs it once the money is
   * back. The card says what this transaction read: performed, closed by the
   * refund (not performed, and it will not be), or being performed right now
   * (performed or not: the operator looks at the subscriber's traffic, and the
   * card asks for review).
   *
   * Who hears of the refund is not decided here: the reversal reads whether
   * the sale was told only after the payment turns CANCELED
   * ({@link wasPaidResetSaleTold}, review R5-07).
   */
  private async endPaidTrafficReset(
    transaction: Transaction,
    name: string,
    base: Omit<AddOnRefundOutcome, 'ended' | 'note' | 'audit'>,
  ): Promise<AddOnRefundOutcome> {
    const now = new Date();
    const performedNote = `Сброс трафика по докупке «${name}» уже выполнен — отменить его нельзя.`;
    const closedNote = `Сброс трафика по докупке «${name}» не был выполнен и уже не будет — его отменил возврат.`;
    return this.prismaService.$transaction(async (tx) => {
      const closed = await tx.$queryRaw<Array<{ readonly id: string }>>(Prisma.sql`
        UPDATE "profile_sync_jobs"
           SET "superseded_at" = COALESCE("superseded_at", ${now}),
               "last_error" = 'closed by the refund before the reset',
               "payload" = ${paidResetSettledPayloadSql(Prisma.sql`"payload"`, 'CLOSED', now)}
                           || jsonb_build_object('closedByRefundAt', ${now.toISOString()}::text),
               "updated_at" = ${now}
         WHERE "cause" = ${PAID_TRAFFIC_RESET_CAUSE}
           AND "payload"->>'transactionId' = ${transaction.id}
           AND NOT ("payload" ? 'settledAt')
           AND "status" IN ('PENDING', 'FAILED')
        RETURNING "id"
      `);
      if (closed.length > 0) {
        return { ...base, ended: true, note: closedNote, audit: { addOnRefundResetClosed: true } };
      }
      const [job] = await tx.$queryRaw<Array<{ readonly status: string; readonly payload: unknown }>>(Prisma.sql`
        SELECT "status"::text AS "status", "payload"
          FROM "profile_sync_jobs"
         WHERE "cause" = ${PAID_TRAFFIC_RESET_CAUSE}
           AND "payload"->>'transactionId' = ${transaction.id}
         ORDER BY "created_at" DESC
         LIMIT 1
         FOR SHARE
      `);
      if (job === undefined) {
        // Paid before this release: performed at the capture, or not at all —
        // its record says which. Its sale was told at the capture either way.
        const performed = await tx.subscriptionTrafficReset.count({ where: { transactionId: transaction.id } });
        return performed > 0
          ? { ...base, ended: true, note: performedNote, audit: {} }
          : {
              ...base,
              ended: true,
              note: `Сброс трафика по докупке «${name}» не был выполнен — отменять нечего.`,
              audit: {},
            };
      }
      if (asRecord(job.payload)['settledAs'] === 'CLOSED') {
        return { ...base, ended: true, note: closedNote, audit: {} };
      }
      if (job.status === SyncJobStatus.COMPLETED) {
        return { ...base, ended: true, note: performedNote, audit: {} };
      }
      if (job.status === SyncJobStatus.RUNNING) {
        return {
          ...base,
          ended: false,
          note:
            `Сброс трафика по докупке «${name}» выполняется прямо сейчас: выполнен он или нет, ` +
            'проверьте трафик подписчика в Remnawave.',
          audit: { addOnRefundResetInFlight: true },
        };
      }
      return {
        ...base,
        ended: true,
        note: `Сброс трафика по докупке «${name}» не был выполнен — отменять нечего.`,
        audit: {},
      };
    });
  }

  /**
   * Whether the sale of a paid «Обнулить трафик» was told (`payment.completed`):
   * its job's decision (`announcedAs`), which the telling records before the
   * sale goes out and only while the payment is COMPLETED
   * (`PaymentSubscriptionMutationService.decidePaidResetTelling`). Read by the
   * reversal AFTER the payment turns CANCELED, so no telling can be decided
   * after it (review R5-07). A payment from before this release has no job:
   * its sale was told at the capture. `false` when it cannot be read: the
   * refund of a sale nobody may have been told of is the operator's alone
   * (review R5-08).
   */
  public async wasPaidResetSaleTold(transactionId: string): Promise<boolean> {
    try {
      const [job] = await this.prismaService.$queryRaw<Array<{ readonly announcedAs: string | null }>>(Prisma.sql`
        SELECT "payload"->>'announcedAs' AS "announcedAs"
          FROM "profile_sync_jobs"
         WHERE "cause" = ${PAID_TRAFFIC_RESET_CAUSE}
           AND "payload"->>'transactionId' = ${transactionId}
         ORDER BY "created_at" DESC
         LIMIT 1
      `);
      return job === undefined || job.announcedAs === 'SALE';
    } catch (error: unknown) {
      this.logger.warn(
        `Whether the sale of the paid reset of transaction ${transactionId} was told could not be read: ${describeError(error)}`,
      );
      return false;
    }
  }

  private async endLegacy(transaction: Transaction, marker: RefundedAddOnMarker): Promise<AddOnRefundOutcome> {
    const name = describeAddOn(marker.addOnType, marker.addOnValue);
    const base = {
      syncJobIds: [] as string[],
      reduceDevicesOf: null,
      devicesLine: null,
      addOnType: marker.addOnType,
      addOnValue: marker.addOnValue,
    };
    // A reset is an action, not a grant: once performed, nothing of it can be
    // taken off — and one not performed yet is closed by the refund (R5-01).
    if (marker.addOnType === AddOnType.RESET_TRAFFIC) {
      return this.endPaidTrafficReset(transaction, name, base);
    }
    // The purchase refused an incoherent value and added nothing (`isCoherentAddOnValue`).
    if (marker.addOnValue < 1) {
      return { ...base, ended: true, note: `Докупка «${name}» ничего не добавляла — отключать нечего.`, audit: {} };
    }
    const subscriptionId = transaction.subscriptionId ?? marker.targetSubscriptionId;
    if (subscriptionId === null) {
      return { ...base, ended: true, note: `Докупка «${name}» не была выдана — отключать нечего.`, audit: {} };
    }
    return this.prismaService.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ readonly id: string }>>(Prisma.sql`
        SELECT "id" FROM "subscriptions" WHERE "id" = ${subscriptionId} FOR UPDATE
      `);
      const payment = await tx.transaction.findUnique({ where: { id: transaction.id }, select: { gatewayData: true } });
      const stamped = asRecord(payment?.gatewayData)[ADDON_REFUND_ENDED_AT_KEY];
      if (typeof stamped === 'string') {
        return { ...base, ended: true, note: `Докупка «${name}» отключена.`, audit: {} };
      }
      const subscription =
        locked.length === 1
          ? await tx.subscription.findUnique({
              where: { id: subscriptionId },
              select: { status: true, trafficLimit: true, deviceLimit: true, planSnapshot: true, remnawaveId: true },
            })
          : null;
      if (subscription === null || subscription.status === SubscriptionStatus.DELETED) {
        return { ...base, ended: true, note: `Подписка удалена — докупку «${name}» отключать не нужно.`, audit: {} };
      }
      const lowered = lowerByAddOn(marker, subscription);
      if (lowered.kind === 'UNLIMITED') {
        return {
          ...base,
          ended: true,
          note: `Докупка «${name}» ничего не добавляла: ${marker.addOnType === AddOnType.EXTRA_TRAFFIC ? 'трафик' : 'число устройств'} у подписки без ограничений.`,
          audit: {},
        };
      }
      if (lowered.kind === 'PLAN_UNKNOWN') {
        return {
          ...base,
          ended: false,
          note: `Докупку «${name}» панель не отключила: лимит тарифа у подписки не прочитать. ${MANUAL_LIMIT_HINT[marker.addOnType]}`,
          audit: { addOnRefundNeedsManualReview: true },
        };
      }
      // In the term model the projection decides what the subscription holds,
      // and the add-on may be inside the ACTIVE term's base.
      const terms = await tx.subscriptionTerm.count({
        where: { subscriptionId, status: SubscriptionTermStatus.ACTIVE },
      });
      if (terms === 1) {
        return this.endLegacyInTermModel(tx, { transaction, marker, name, subscriptionId, subscription, base });
      }

      const column = marker.addOnType === AddOnType.EXTRA_TRAFFIC ? 'trafficLimit' : 'deviceLimit';
      const audit: Record<string, unknown> = {
        [ADDON_REFUND_ENDED_AT_KEY]: new Date().toISOString(),
        addOnRefundLimit: { column, from: lowered.from, to: lowered.to },
      };
      if (lowered.to === lowered.from) {
        await writeTransactionGatewayData(tx, transaction.id, { merge: audit });
        return { ...base, ended: true, note: `Докупка «${name}» отключена: лимит уже был на уровне тарифа.`, audit };
      }
      await tx.subscription.update({ where: { id: subscriptionId }, data: { [column]: lowered.to } });
      const jobId = await this.createSyncJob(tx, subscriptionId, subscription.remnawaveId, transaction.paymentId, null);
      await writeTransactionGatewayData(tx, transaction.id, { merge: audit });
      return { ...base, syncJobIds: jobId === null ? [] : [jobId], ended: true, note: `Докупка «${name}» отключена.`, audit };
    });
  }

  /**
   * A legacy add-on (a raw `+N`) refunded on a subscription IN the term model,
   * under the subscription lock the caller holds.
   *
   * The columns mirror `desired = base + recorded contributions`, and an add-on
   * bought before the model sits in the base: the background cutover minted
   * the ACTIVE term's base from the columns, add-on included (owner's answer
   * 1). Lowering the column alone came back at the next recompute — with the
   * add-on taken off, the column reads as the plan's again (INHERITED), and an
   * INHERITED field stands on the term's base. The refund ends the add-on at
   * once (owner, 24.09.2026), so:
   *
   *  1. The subscription's OWN share of the field — the column less the
   *     recorded contributions, which are live add-ons and bonuses and neither
   *     the operator's nor this add-on's — comes down by the add-on's value,
   *     never below the plan's value and never up.
   *  2. The ACTIVE term's base comes down by the add-on's value too, never
   *     below the plan's value and never above that own share: the rest of the
   *     period is rotated onto a term with that base
   *     (`SubscriptionTermService.rebaseActiveTermInTransaction`). A base that
   *     holds no more than that — an add-on bought after the cutover was never
   *     in it — is left alone.
   *  3. The column is written, and the projection recomputed, mirrored and
   *     pushed.
   *
   * What is still held above the lowered share after that is not this add-on
   * (it holds nothing any more), and the card says so rather than claiming it.
   */
  private async endLegacyInTermModel(
    tx: Prisma.TransactionClient,
    input: {
      readonly transaction: Transaction;
      readonly marker: RefundedAddOnMarker;
      readonly name: string;
      readonly subscriptionId: string;
      readonly subscription: {
        readonly trafficLimit: number | null;
        readonly deviceLimit: number;
        readonly planSnapshot: unknown;
        readonly remnawaveId: string | null;
      };
      readonly base: Omit<AddOnRefundOutcome, 'ended' | 'note' | 'audit'>;
    },
  ): Promise<AddOnRefundOutcome> {
    const { marker, name, subscriptionId, subscription, base } = input;
    const traffic = marker.addOnType === AddOnType.EXTRA_TRAFFIC;
    const column = traffic ? 'trafficLimit' : 'deviceLimit';
    // Readable and finite: `lowerByAddOn` answered LOWER, not UNLIMITED or PLAN_UNKNOWN.
    const plan = asRecord(subscription.planSnapshot)[column] as number;
    const current = (traffic ? subscription.trafficLimit : subscription.deviceLimit) as number;
    const recorded = await resolveRecordedAddOnContribution(tx, subscriptionId);
    const recordedShare = traffic
      ? Number(recorded.activeTrafficContributionBytes / GIB_BYTES)
      : recorded.activeDeviceContribution;
    const own = current - recordedShare;
    const loweredOwn = Math.min(own, Math.max(own - marker.addOnValue, plan));
    const next = loweredOwn + recordedShare;

    const active = await tx.subscriptionTerm.findFirst({
      where: { subscriptionId, status: SubscriptionTermStatus.ACTIVE },
      select: { baseTrafficLimitBytes: true, baseDeviceLimit: true },
    });
    const unit = traffic ? GIB_BYTES : 1n;
    const termBase = traffic
      ? (active?.baseTrafficLimitBytes ?? null)
      : active?.baseDeviceLimit === null || active?.baseDeviceLimit === undefined
        ? null
        : BigInt(active.baseDeviceLimit);
    let rebased: { readonly from: string; readonly to: string } | null = null;
    if (termBase !== null) {
      const floor = BigInt(plan) * unit;
      const ceiling = BigInt(Math.max(loweredOwn, plan)) * unit;
      const lowered = termBase - BigInt(marker.addOnValue) * unit;
      const capped = lowered < ceiling ? lowered : ceiling;
      const target = capped > floor ? capped : floor;
      if (target < termBase) {
        const rotation = await this.terms.rebaseActiveTermInTransaction(tx, {
          subscriptionId,
          base: traffic ? { trafficLimitBytes: target } : { deviceLimit: Number(target) },
          snapshotSource: ADDON_REFUND_REBASED_TERM,
        });
        if (rotation.outcome === 'REBASED') rebased = { from: rotation.previousTermId, to: rotation.termId };
      }
    }

    const stampedAt = new Date().toISOString();
    if (next === current && rebased === null) {
      const audit = { [ADDON_REFUND_ENDED_AT_KEY]: stampedAt, addOnRefundLimit: { column, from: current, to: current } };
      await writeTransactionGatewayData(tx, input.transaction.id, { merge: audit });
      return { ...base, ended: true, note: `Докупка «${name}» отключена: лимит уже был на уровне тарифа.`, audit };
    }
    if (next !== current) {
      await tx.subscription.update({ where: { id: subscriptionId }, data: { [column]: next } });
    }
    const projection = await this.projections.recomputeInTransaction(tx, { subscriptionId, mode: 'ACTIVE' });
    const mirrored = mirrorOf(projection);
    await tx.subscription.update({ where: { id: subscriptionId }, data: mirrored });
    const jobId = await this.createSyncJob(
      tx,
      subscriptionId,
      subscription.remnawaveId,
      input.transaction.paymentId,
      projection.desiredRevision,
    );
    const syncJobIds = jobId === null ? [] : [jobId];
    const held = traffic ? mirrored.trafficLimit : mirrored.deviceLimit;
    const heldOwn =
      held === null
        ? null
        : held - (traffic ? Number(projection.activeTrafficContributionBytes / GIB_BYTES) : projection.activeDeviceContribution);
    if (heldOwn === null || heldOwn > loweredOwn) {
      return {
        ...base,
        syncJobIds,
        ended: false,
        note:
          `Докупку «${name}» панель не отключила: после пересчёта у подписки осталось больше, чем без неё. ` +
          MANUAL_LIMIT_HINT[marker.addOnType],
        audit: { addOnRefundNeedsManualReview: true, ...(rebased === null ? {} : { addOnRefundTermRebased: rebased }) },
      };
    }
    const audit = {
      [ADDON_REFUND_ENDED_AT_KEY]: stampedAt,
      addOnRefundLimit: { column, from: current, to: held },
      ...(rebased === null ? {} : { addOnRefundTermRebased: rebased }),
    };
    await writeTransactionGatewayData(tx, input.transaction.id, { merge: audit });
    return { ...base, syncJobIds, ended: true, note: `Докупка «${name}» отключена.`, audit };
  }

  /**
   * Recomputes the projection a reversal changed, mirrors it into the columns
   * and writes the sync that pushes it — the way `reverseEntitlement` and the
   * boundary expiry do. Nothing when the subscription holds no single ACTIVE
   * term (nothing to project against) or is DELETED.
   */
  private async pushProjection(tx: Prisma.TransactionClient, subscriptionId: string, paymentId: string): Promise<string | null> {
    const subscription = await tx.subscription.findUnique({
      where: { id: subscriptionId },
      select: { status: true, remnawaveId: true },
    });
    if (subscription === null || subscription.status === SubscriptionStatus.DELETED) return null;
    const terms = await tx.subscriptionTerm.count({ where: { subscriptionId, status: SubscriptionTermStatus.ACTIVE } });
    if (terms !== 1) return null;
    const projection = await this.projections.recomputeInTransaction(tx, { subscriptionId, mode: 'ACTIVE' });
    if (!projection.changed) return null;
    await tx.subscription.update({ where: { id: subscriptionId }, data: mirrorOf(projection) });
    return this.createSyncJob(tx, subscriptionId, subscription.remnawaveId, paymentId, projection.desiredRevision);
  }

  private async createSyncJob(
    tx: Prisma.TransactionClient,
    subscriptionId: string,
    remnawaveId: string | null,
    paymentId: string,
    desiredRevision: bigint | null,
  ): Promise<string | null> {
    // No panel profile yet: the one created later is created with these columns.
    if (remnawaveId === null) return null;
    const job = await tx.profileSyncJob.create({
      data: {
        subscriptionId,
        action: SyncAction.UPDATE,
        status: SyncJobStatus.PENDING,
        ...(desiredRevision === null ? {} : { aggregateKey: subscriptionId, desiredRevision }),
        cause: 'ADDON_REFUND',
        payload: { source: 'ADDON_REFUND', paymentId } as Prisma.InputJsonObject,
      },
      select: { id: true },
    });
    return job.id;
  }

  /** Enqueued after the commit; a queue that fails leaves the job to the profile-sync sweep. */
  private async enqueue(jobIds: readonly string[], transactionId: string): Promise<void> {
    for (const jobId of jobIds) {
      try {
        await this.profileSyncQueue.enqueue(jobId, true);
      } catch (error: unknown) {
        this.logger.warn(
          `Sync of the add-on refund of transaction ${transactionId} not enqueued (the sweep recovers it): ${describeError(error)}`,
        );
      }
    }
  }
}

/**
 * Where an operator changes a limit by hand, in the words the panel shows —
 * or, for a reset whose state the refund could not read, what to look at.
 */
const MANUAL_LIMIT_HINT: Readonly<Record<AddOnType, string>> = {
  [AddOnType.EXTRA_TRAFFIC]:
    'уменьшите «Лимит трафика (GB)» вручную: «Пользователи» → клиент → вкладка «Подписки» → «Быстрые действия» → «Сохранить».',
  [AddOnType.EXTRA_DEVICES]:
    'уменьшите «Лимит устройств» вручную: «Пользователи» → клиент → вкладка «Подписки» → «Быстрые действия» → «Сохранить».',
  [AddOnType.RESET_TRAFFIC]: 'проверить, выполнен ли он, не удалось — проверьте трафик подписчика в Remnawave.',
};

/**
 * The card's line when the extra devices were not taken off by the panel. The
 * device list's remove control is a trash icon («Удалить устройство» is its
 * label), confirmed with «Удалить» (`user-detail-panel.tsx`, `DevicesSection`).
 */
const MANUAL_DEVICES_LINE =
  'Лишние устройства панель не удалила — удалите их вручную: «Пользователи» → клиент → вкладка «Подписки» → «Быстрые действия» → «Устройства (HWID)» → корзина у устройства → «Удалить».';

/** Stage 6 on, and the panel did not answer this time: the queue tries again. */
const DEVICES_RETRY_LINE =
  'Remnawave не ответила — лишние устройства панель удалит сама при следующей попытке, через 5 минут.';

/**
 * What WILL happen to a refunded device add-on's extra devices, by stage 6
 * («Удалять лишние устройства автоматически»): the line the card carries when it goes out
 * before the refund's own run of the reduction finished — a stop, a panel that
 * did not answer — which the queue then finishes. With stage 6 off the
 * reduction waits for the operator, as an expired add-on's does; the names are
 * the SPA's (`add-on-entitlements-tab.tsx`, `add-on-entitlement-inspector.tsx`:
 * «Открыть инспектор подписки», «ID подписки», «Открыть», «Причина»,
 * «Планы сокращения устройств», «Утвердить», «Утвердить и выполнить»).
 */
export function predictedDevicesLine(subscriptionId: string, deviceCleanupAuto: boolean): string {
  if (deviceCleanupAuto) {
    return 'Лишние устройства панель удалит сама, а если Remnawave не ответит — повторит, пока не удалит.';
  }
  return (
    'Лишние устройства панель сама не удаляет: выключено «Удалять лишние устройства автоматически» ' +
    '(«Доп. услуги» → вкладка «Настройки»). Чтобы удалить их, утвердите план: ' +
    '«Доп. услуги» → вкладка «Доставка» → «Открыть инспектор подписки» → «ID подписки»: ' +
    `${subscriptionId} → «Открыть» → впишите «Причина» → «Планы сокращения устройств» → «Утвердить» → «Утвердить и выполнить».`
  );
}

async function lockSubscription(tx: Prisma.TransactionClient, subscriptionId: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "subscriptions" WHERE "id" = ${subscriptionId} FOR UPDATE`);
}

/** The add-on as a customer bought it: «+2 устройства», «+50 ГБ», «сброс трафика». */
export function describeAddOn(type: AddOnType, value: number): string {
  if (type === AddOnType.EXTRA_TRAFFIC) return `+${value} ГБ`;
  if (type === AddOnType.EXTRA_DEVICES) return `+${value} ${pluralRu(value, 'устройство', 'устройства', 'устройств')}`;
  return 'сброс трафика';
}

function pluralRu(n: number, one: string, few: string, many: string): string {
  const mod100 = Math.abs(n) % 100;
  const mod10 = mod100 % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

/** An entitlement's value in the unit it was sold in: gigabytes, or devices. */
function entitlementValue(type: AddOnType, totalValue: bigint): number {
  return type === AddOnType.EXTRA_TRAFFIC ? Number(totalValue / GIB_BYTES) : Number(totalValue);
}

/** The columns a projection mirrors into (the shape every writer of it uses). */
function mirrorOf(projection: { readonly desiredTrafficLimitBytes: bigint | null; readonly desiredDeviceLimit: number | null }): {
  readonly trafficLimit: number | null;
  readonly deviceLimit: number;
} {
  return {
    trafficLimit: projection.desiredTrafficLimitBytes === null ? null : Number(projection.desiredTrafficLimitBytes / GIB_BYTES),
    deviceLimit: projection.desiredDeviceLimit === null ? 0 : projection.desiredDeviceLimit,
  };
}

type LegacyLowering =
  | { readonly kind: 'UNLIMITED' }
  | { readonly kind: 'PLAN_UNKNOWN' }
  | { readonly kind: 'LOWER'; readonly from: number; readonly to: number };

/**
 * The legacy column after the add-on's value is taken off it: never below the
 * plan's value (`planSnapshot`), and nothing at all on an unlimited column or
 * against a plan value that cannot be read (or is unlimited, so no floor
 * exists). Pure.
 */
export function lowerByAddOn(
  marker: Pick<RefundedAddOnMarker, 'addOnType' | 'addOnValue'>,
  subscription: { readonly trafficLimit: number | null; readonly deviceLimit: number; readonly planSnapshot: unknown },
): LegacyLowering {
  const snapshot = asRecord(subscription.planSnapshot);
  if (marker.addOnType === AddOnType.EXTRA_TRAFFIC) {
    if (subscription.trafficLimit === null) return { kind: 'UNLIMITED' };
    const plan = snapshot['trafficLimit'];
    if (typeof plan !== 'number' || !Number.isInteger(plan) || plan < 1) return { kind: 'PLAN_UNKNOWN' };
    const to = Math.max(subscription.trafficLimit - marker.addOnValue, plan);
    return { kind: 'LOWER', from: subscription.trafficLimit, to: Math.min(to, subscription.trafficLimit) };
  }
  if (subscription.deviceLimit <= 0) return { kind: 'UNLIMITED' };
  const plan = snapshot['deviceLimit'];
  if (typeof plan !== 'number' || !Number.isInteger(plan) || plan < 1) return { kind: 'PLAN_UNKNOWN' };
  const to = Math.max(subscription.deviceLimit - marker.addOnValue, plan);
  return { kind: 'LOWER', from: subscription.deviceLimit, to: Math.min(to, subscription.deviceLimit) };
}

/** The add-on checkout's marker (`snapshotSource: 'ADDON_PURCHASE'`), or `null`. */
export function readRefundedAddOnMarker(planSnapshot: unknown): RefundedAddOnMarker | null {
  const snapshot = asRecord(planSnapshot);
  if (snapshot['snapshotSource'] !== 'ADDON_PURCHASE') return null;
  const type = snapshot['addOnType'];
  const value = snapshot['addOnValue'];
  if (
    (type !== AddOnType.EXTRA_TRAFFIC && type !== AddOnType.EXTRA_DEVICES && type !== AddOnType.RESET_TRAFFIC) ||
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    return null;
  }
  const target = snapshot['targetSubscriptionId'];
  return { addOnType: type, addOnValue: value, targetSubscriptionId: typeof target === 'string' && target.length > 0 ? target : null };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
