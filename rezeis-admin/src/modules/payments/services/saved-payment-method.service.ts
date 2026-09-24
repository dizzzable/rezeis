import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PaymentGatewayType, Prisma } from '@prisma/client';

import { OUTBOUND_HTTP_TIMEOUT_MS } from '../../../common/http/outbound-http-options';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { EVENT_TYPES, SystemEventsService } from '../../../common/services/system-events.service';
import { planNamesFromTransactionSnapshot } from '../../../common/utils/plan-snapshot.util';
import { SAVED_CARD_AUTOPAY_OFF_AT_KEY } from '../utils/refund-autopay.util';
import { writeTransactionGatewayData } from '../utils/transaction-gateway-data.util';

/**
 * How an off-session charge holds its saved method's lock, and for how long
 * ({@link SavedPaymentMethodService.withActiveForCharge}).
 *
 * The lock is a row lock inside an interactive transaction, and it lasts as
 * long as that transaction: Prisma rolls the transaction back at its timeout,
 * whatever the callback is still doing. The timeout was 30 s, and the ЮKassa
 * POST inside it may run 45 s (`OUTBOUND_HTTP_TIMEOUT_MS`) — and that is an
 * idle timeout on the socket, not a deadline. So the lock could lapse while
 * the charge was still being submitted, and everything that waits for a charge
 * by waiting for this lock — a refund's switch-off of the autopay above all —
 * went ahead with the charge still in flight.
 *
 * Now the three parts of the transaction are bounded each, and add up to less
 * than its timeout ({@link chargeLockHoldMs}): the wait for the lock
 * (`lock_timeout`), the submission (aborted at its deadline, and the POST ends
 * with it), and a margin for the abort to land and the commit to start. The
 * lock therefore ends after the submission, never before it.
 */
export interface ChargeLockTiming {
  /** The longest a charge waits for the method's lock; then it gives up without submitting. */
  readonly lockWaitMs: number;
  /** The longest the provider submission may run: it is aborted at this deadline. */
  readonly submitMs: number;
  /** Kept free after the deadline: the abort landing, the callback returning, the commit starting. */
  readonly marginMs: number;
}

export const CHARGE_LOCK_TIMING: ChargeLockTiming = {
  lockWaitMs: 15_000,
  submitMs: OUTBOUND_HTTP_TIMEOUT_MS,
  marginMs: 5_000,
};

/** Overrides {@link CHARGE_LOCK_TIMING}; only a spec provides it. */
export const CHARGE_LOCK_TIMING_OVERRIDE = 'CHARGE_LOCK_TIMING_OVERRIDE';

/** How long a charge's transaction, and so its lock, may last: longer than its three parts together. */
export function chargeLockHoldMs(timing: ChargeLockTiming): number {
  return timing.lockWaitMs + timing.submitMs + timing.marginMs;
}

/**
 * The timeout of a transaction that waits for the lock a charge may hold —
 * unbind, the customer's autopay switch, a revoked method, a refund's switch
 * that waits: the charge's whole hold, and its own work after it. Shorter, a
 * waiter behind a slow charge was rolled back the moment it got the lock.
 */
export function chargeLockWaiterTimeoutMs(timing: ChargeLockTiming): number {
  return chargeLockHoldMs(timing) + timing.marginMs;
}

/** The code a charge that could not have its method's lock in time is refused with. */
export const SAVED_PAYMENT_METHOD_BUSY = 'SAVED_PAYMENT_METHOD_BUSY';

/**
 * How long the customer's own «Автосписание» switch and «Отвязать» (the
 * cabinet's «Способы оплаты») wait for the method's lock before answering 409
 * {@link SAVED_PAYMENT_METHOD_BUSY}: a payment with it is in progress, try
 * again in a minute.
 *
 * Long enough for every short holder — another switch, a refund's switch-off,
 * a charge deciding — and far shorter than a charge being submitted, which
 * holds it for as long as its POST runs ({@link chargeLockHoldMs}). Waiting for
 * that one, the request outlived the 30 s cut on it
 * (`request-timeout.middleware.ts`): the cabinet showed an error for a switch
 * that then went through. Refused at once instead of deferred: the switch
 * cannot stop the charge in flight anyway, a refusal keeps no state that a
 * stop could lose or a second click could reorder, and the switch on the
 * screen stays what the method really is.
 */
export const CUSTOMER_SWITCH_LOCK_WAIT_MS = 2_000;

/** A saved method whose autopay a switch turned off, as the operator's card names it. */
export interface SwitchedOffMethod {
  readonly id: string;
  readonly methodType: string;
  readonly title: string;
}

/**
 * Persists provider-saved payment instruments (YooKassa `payment_method`) and
 * exposes list/unbind for the user cabinet.
 *
 * Unbind is intentionally local: YooKassa has no merchant "detach card" API.
 * After unbind we stop using `providerMethodId` for off-session charges.
 */
@Injectable()
export class SavedPaymentMethodService {
  private readonly logger = new Logger(SavedPaymentMethodService.name);
  private readonly chargeLockTiming: ChargeLockTiming;

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly systemEvents: SystemEventsService,
    /** A spec's shorter {@link CHARGE_LOCK_TIMING}; the module provides none. */
    @Optional()
    @Inject(CHARGE_LOCK_TIMING_OVERRIDE)
    chargeLockTiming?: ChargeLockTiming,
  ) {
    this.chargeLockTiming = chargeLockTiming ?? CHARGE_LOCK_TIMING;
  }

  /** {@link chargeLockWaiterTimeoutMs} of this service's timing. */
  private get waiterTimeoutMs(): number {
    return chargeLockWaiterTimeoutMs(this.chargeLockTiming);
  }

  public async listActiveForUser(userId: string) {
    const methods = await this.prismaService.savedPaymentMethod.findMany({
      where: { userId, isActive: true },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        gatewayType: true,
        providerMethodId: true,
        methodType: true,
        title: true,
        cardLast4: true,
        cardFirst6: true,
        cardExpiryMonth: true,
        cardExpiryYear: true,
        cardIssuerCountry: true,
        cardProduct: true,
        autopayEnabled: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return {
      methods: methods.map((method) => ({
        id: method.id,
        gatewayType: method.gatewayType,
        methodType: method.methodType,
        title: method.title ?? buildDisplayTitle(method),
        cardLast4: method.cardLast4,
        cardFirst6: method.cardFirst6,
        cardExpiryMonth: method.cardExpiryMonth,
        cardExpiryYear: method.cardExpiryYear,
        cardIssuerCountry: method.cardIssuerCountry,
        cardProduct: method.cardProduct,
        autopayEnabled: method.autopayEnabled,
        createdAt: method.createdAt.toISOString(),
        updatedAt: method.updatedAt.toISOString(),
      })),
      total: methods.length,
    };
  }

  /**
   * Soft-unbinds a saved method owned by the user. Idempotent when already inactive.
   */
  public async unbindForUser(
    userId: string,
    methodId: string,
  ): Promise<{ unbound: true; id: string }> {
    const { updated, changed } = await this.customerSwitch(() =>
      this.prismaService.$transaction(
        async (tx) => {
          await this.lockForCustomerSwitch(tx, methodId);
          const existing = await tx.savedPaymentMethod.findFirst({
            where: { id: methodId, userId },
          });
          if (existing === null) {
            throw new NotFoundException('Saved payment method not found');
          }
          if (!existing.isActive) {
            return { updated: existing, changed: false };
          }
          const updated = await tx.savedPaymentMethod.update({
            where: { id: existing.id },
            data: {
              isActive: false,
              unboundAt: new Date(),
            },
          });
          return { updated, changed: true };
        },
        { timeout: this.waiterTimeoutMs },
      ),
    );

    if (!changed) {
      return { unbound: true, id: updated.id };
    }

    this.systemEvents.info(
      EVENT_TYPES.PAYMENT_METHOD_UNBOUND,
      'PAYMENT',
      `Способ оплаты отвязан пользователем: ${updated.methodType}`,
      {
        userId,
        savedPaymentMethodId: updated.id,
        gatewayType: updated.gatewayType,
        methodType: updated.methodType,
        cardLast4: updated.cardLast4,
        providerMethodId: updated.providerMethodId,
      },
    );

    return { unbound: true, id: updated.id };
  }

  /**
   * Enables/disables autopay for a bound method without unbinding it.
   * Card stays listed; resolveActiveForCharge rejects when disabled.
   */
  public async setAutopayEnabledForUser(
    userId: string,
    methodId: string,
    autopayEnabled: boolean,
  ): Promise<{ id: string; autopayEnabled: boolean }> {
    const { updated, changed } = await this.customerSwitch(() =>
      this.prismaService.$transaction(
        async (tx) => {
          await this.lockForCustomerSwitch(tx, methodId);
          const existing = await tx.savedPaymentMethod.findFirst({
            where: { id: methodId, userId, isActive: true },
          });
          if (existing === null) {
            throw new NotFoundException('Saved payment method not found');
          }
          if (existing.autopayEnabled === autopayEnabled) {
            return { updated: existing, changed: false };
          }
          const updated = await tx.savedPaymentMethod.update({
            where: { id: existing.id },
            data: { autopayEnabled },
            select: {
              id: true,
              autopayEnabled: true,
              gatewayType: true,
              methodType: true,
              cardLast4: true,
              providerMethodId: true,
            },
          });
          return { updated, changed: true };
        },
        { timeout: this.waiterTimeoutMs },
      ),
    );

    if (!changed) {
      return { id: updated.id, autopayEnabled: updated.autopayEnabled };
    }

    this.systemEvents.info(
      EVENT_TYPES.PAYMENT_METHOD_AUTOPAY_UPDATED,
      'PAYMENT',
      autopayEnabled
        ? `Автосписание включено: ${updated.methodType}`
        : `Автосписание отключено: ${updated.methodType}`,
      {
        userId,
        savedPaymentMethodId: updated.id,
        autopayEnabled: updated.autopayEnabled,
        gatewayType: updated.gatewayType,
        methodType: updated.methodType,
        cardLast4: updated.cardLast4,
        providerMethodId: updated.providerMethodId,
      },
    );

    return { id: updated.id, autopayEnabled: updated.autopayEnabled };
  }

  /** Disables autopay after a provider revokes a reusable instrument. */
  public async disableAutopayForProviderMethod(input: {
    readonly providerMethodId: string;
    readonly reason: string;
    readonly userId?: string;
    readonly gatewayType?: PaymentGatewayType;
  }): Promise<{ id: string; autopayEnabled: false } | null> {
    const providerMethodId = input.providerMethodId.trim();
    if (providerMethodId.length === 0) return null;
    const gatewayType = input.gatewayType ?? PaymentGatewayType.YOOKASSA;
    const candidate = await this.prismaService.savedPaymentMethod.findFirst({
      where: { gatewayType, providerMethodId, isActive: true, autopayEnabled: true, ...(input.userId === undefined ? {} : { userId: input.userId }) },
      select: { id: true },
    });
    if (candidate === null) return null;

    const updated = await this.prismaService.$transaction(async (tx) => {
      await this.lockForChargeDecision(tx, candidate.id);
      const method = await tx.savedPaymentMethod.findFirst({
        where: { id: candidate.id, gatewayType, providerMethodId, isActive: true, autopayEnabled: true, ...(input.userId === undefined ? {} : { userId: input.userId }) },
        select: { id: true, userId: true, gatewayType: true, methodType: true, cardLast4: true, providerMethodId: true },
      });
      if (method === null) return null;
      await tx.savedPaymentMethod.update({ where: { id: method.id }, data: { autopayEnabled: false } });
      return method;
    }, { timeout: this.waiterTimeoutMs });
    if (updated === null) return null;

    this.systemEvents.warn(
      EVENT_TYPES.PAYMENT_METHOD_AUTOPAY_UPDATED,
      'PAYMENT',
      `Автосписание отключено провайдером: ${updated.methodType}`,
      { userId: updated.userId, savedPaymentMethodId: updated.id, gatewayType: updated.gatewayType, methodType: updated.methodType, cardLast4: updated.cardLast4, providerMethodId: updated.providerMethodId, reason: input.reason },
    );
    return { id: updated.id, autopayEnabled: false };
  }

  /**
   * Switches off ЮKassa autopay on every saved method of a user whose payment
   * was refunded — the owner's decision («Да, выключай при возврате»): a
   * refund ends the autopay (`refundEndsAutopay`).
   *
   * The card stays saved and listed; only `autopayEnabled` goes off, which is
   * what `findPreferredForCharge` reads, so the next renewal charges nothing.
   * The switch is the user's, not a subscription's: it stops autopay on all of
   * their subscriptions, and the owner chose that knowingly. Each method is
   * switched under the lock the charge decision takes, so a renewal deciding
   * at the same moment sees one state or the other, never half.
   *
   * `waitForCharges: false` — from an operator's request, which must not wait
   * on a provider — leaves alone a method whose lock is held: a charge of it is
   * being submitted to ЮKassa right now, holding the lock for as long as
   * ЮKassa takes. Those are counted `busy`, for the caller to switch off after
   * its answer, waiting.
   *
   * `transactionId`, the refunded payment, is stamped
   * (`SAVED_CARD_AUTOPAY_OFF_AT_KEY`) in the same database transaction as the
   * switch: another door into the same refund, waiting on the same lock,
   * finds nothing left to switch and reads the stamp — committed before the
   * lock was let go — so its card says the autopay is off too.
   *
   * Raises no event of its own. `payment.method_autopay_updated` is the
   * customer's switch, which rules, outbound webhooks and the email bridge act
   * on; a refund's is told by the refund's card, which is the operator's
   * (`payment.chargeback_unmatched` is operator-only for exactly that reason).
   *
   * Returns how many methods it switched off, and how many it left busy.
   */
  public async disableAutopayForRefund(input: {
    readonly userId: string;
    /** The refunded payment; a chargeback that names none of ours has none. */
    readonly transactionId?: string;
    /** For such a chargeback: the provider subscription it disputes a charge of. */
    readonly providerSubscriptionId?: string;
    readonly waitForCharges?: boolean;
  }): Promise<{ readonly switched: number; readonly busy: number }> {
    const outcome = await this.switchOffYookassaAutopay({
      userId: input.userId,
      waitForCharges: input.waitForCharges,
      stampTransactionId: input.transactionId,
      by: `a refund (${input.transactionId ?? input.providerSubscriptionId ?? 'unnamed'})`,
    });
    return { switched: outcome.switched.length, busy: outcome.busy };
  }

  /**
   * «Выключить автосписание ЮKassa» on the user's card in the panel: an
   * operator stops the customer's ЮKassa autopay without a refund — on every
   * active method, as a refund does ({@link disableAutopayForRefund}), and by
   * the same switch the customer has in the cabinet («Способы оплаты» →
   * «Автосписание»), which stays theirs to turn back on. The methods stay saved.
   *
   * Raises no event: `payment.method_autopay_updated` is the customer's own
   * switch, and rules, outbound webhooks and the email bridge act on it — a
   * letter saying the customer turned it off would be wrong. The operator's
   * card is the caller's (`payment.autopay_stopped_by_operator`).
   *
   * `waitForCharges: false` from the operator's request, as for a refund: a
   * method a charge is being submitted with is left `busy`, for the call after
   * the answer that waits. Returns the methods switched off.
   */
  public async disableAutopayForOperator(input: {
    readonly userId: string;
    readonly adminId: string;
    readonly waitForCharges: boolean;
  }): Promise<{ readonly switched: readonly SwitchedOffMethod[]; readonly busy: number }> {
    return this.switchOffYookassaAutopay({
      userId: input.userId,
      waitForCharges: input.waitForCharges,
      by: `admin ${input.adminId} in the panel`,
    });
  }

  /**
   * Switches off `autopayEnabled` on every active ЮKassa method of `userId`
   * that has it on, each under the lock the charge decision takes. Without
   * waiting (`waitForCharges: false`), a method a charge holds is left and
   * counted `busy`. `stampTransactionId` is stamped in the same database
   * transaction as each switch (see {@link disableAutopayForRefund}).
   */
  private async switchOffYookassaAutopay(input: {
    readonly userId: string;
    readonly waitForCharges?: boolean;
    readonly stampTransactionId?: string;
    /** Who asked, for the log line. */
    readonly by: string;
  }): Promise<{ readonly switched: SwitchedOffMethod[]; readonly busy: number }> {
    const candidates = await this.prismaService.savedPaymentMethod.findMany({
      where: { userId: input.userId, gatewayType: PaymentGatewayType.YOOKASSA, isActive: true, autopayEnabled: true },
      select: { id: true },
    });
    const switched: SwitchedOffMethod[] = [];
    let busy = 0;
    for (const candidate of candidates) {
      const method = await this.prismaService.$transaction(async (tx) => {
        if (input.waitForCharges === false) {
          if (!(await this.tryLockForChargeDecision(tx, candidate.id))) return 'BUSY' as const;
        } else {
          await this.lockForChargeDecision(tx, candidate.id);
        }
        const current = await tx.savedPaymentMethod.findFirst({
          where: { id: candidate.id, isActive: true, autopayEnabled: true },
          select: { id: true, gatewayType: true, methodType: true, title: true, cardLast4: true, providerMethodId: true },
        });
        if (current === null) return null;
        await tx.savedPaymentMethod.update({ where: { id: current.id }, data: { autopayEnabled: false } });
        if (input.stampTransactionId !== undefined) {
          await writeTransactionGatewayData(tx, input.stampTransactionId, {
            merge: { [SAVED_CARD_AUTOPAY_OFF_AT_KEY]: new Date().toISOString() },
          });
        }
        return current;
      }, { timeout: this.waiterTimeoutMs });
      if (method === 'BUSY') {
        busy += 1;
        continue;
      }
      if (method === null) continue;
      switched.push({
        id: method.id,
        methodType: method.methodType,
        title: method.title ?? buildDisplayTitle({ methodType: method.methodType, cardLast4: method.cardLast4 }),
      });
      this.logger.log(
        `Autopay of saved ${method.gatewayType} method ${method.id} (${method.methodType}) of user ${input.userId} ` +
          `switched off by ${input.by}`,
      );
    }
    return { switched, busy };
  }

  /** Emits an operator-visible event when an off-session charge needs 3DS. */
  public notifyAutopayConfirmationRequired(input: {
    readonly userId: string;
    readonly paymentId: string;
    readonly checkoutUrl: string;
    /** The invoice's own snapshot, so the card can say which plan is waiting. */
    readonly planSnapshot?: unknown;
  }): void {
    const { planSnapshot, ...rest } = input;
    this.systemEvents.warn(
      EVENT_TYPES.PAYMENT_AUTOPAY_CONFIRMATION_REQUIRED,
      'PAYMENT',
      'Автосписание ожидает подтверждения пользователя (3DS/redirect)',
      { ...rest, ...planNamesFromTransactionSnapshot(planSnapshot) },
    );
  }

  /**
   * Picks the newest chargeable saved method for autopay (active + autopay on).
   * Prefer YOOKASSA — currently the only off-session charge path.
   */
  public async findPreferredForCharge(userId: string): Promise<{
    readonly id: string;
    readonly gatewayType: PaymentGatewayType;
    readonly providerMethodId: string;
  } | null> {
    const method = await this.prismaService.savedPaymentMethod.findFirst({
      where: {
        userId,
        isActive: true,
        autopayEnabled: true,
        gatewayType: PaymentGatewayType.YOOKASSA,
        providerMethodId: { not: '' },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        gatewayType: true,
        providerMethodId: true,
      },
    });
    if (method === null) {
      return null;
    }
    const providerMethodId = method.providerMethodId.trim();
    if (providerMethodId.length === 0 || providerMethodId.startsWith('demo_pm_')) {
      return null;
    }
    return {
      id: method.id,
      gatewayType: method.gatewayType,
      providerMethodId,
    };
  }

  /**
   * Resolves a user-owned active saved method for off-session charge.
   * Returns the local id + provider payment_method.id used by YooKassa.
   */
  public async resolveActiveForCharge(input: {
    readonly userId: string;
    readonly savedPaymentMethodId: string;
    readonly gatewayType: PaymentGatewayType;
  }): Promise<{ readonly id: string; readonly providerMethodId: string }> {
    return this.withActiveForCharge(input, async (method) => method);
  }

  /**
   * Serializes provider submission with disable/unbind on the saved-method row.
   * The callback must cover only the provider submission, not later fulfillment.
   *
   * The lock ends after the submission, never before it ({@link ChargeLockTiming}):
   * - the wait for it is bounded (`lock_timeout`). A charge that does not get it
   *   in time is refused ({@link SAVED_PAYMENT_METHOD_BUSY}) before anything is
   *   submitted, and so is one that got it too late to have its whole
   *   submission time left inside the transaction;
   * - `submit` is handed a signal that aborts at `submitMs`, and the ЮKassa POST
   *   ends with it (`PaymentProviderExecutionService.createCheckout`, `signal`);
   * - the transaction's timeout — when Prisma rolls it back and lets the lock
   *   go, whatever the callback is doing — is longer than both by `marginMs`.
   */
  public async withActiveForCharge<T>(
    input: {
      readonly userId: string;
      readonly savedPaymentMethodId: string;
      readonly gatewayType: PaymentGatewayType;
    },
    submit: (method: { readonly id: string; readonly providerMethodId: string }, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const timing = this.chargeLockTiming;
    try {
      return await this.prismaService.$transaction(
        async (tx) => {
          const startedAt = Date.now();
          // Ends with this transaction; never reaches the pool's next borrower.
          await tx.$executeRaw(Prisma.raw(`SET LOCAL lock_timeout = '${Math.max(1, Math.floor(timing.lockWaitMs))}ms'`));
          await this.lockForChargeDecision(tx, input.savedPaymentMethodId);
          const method = await tx.savedPaymentMethod.findFirst({
            where: {
              id: input.savedPaymentMethodId,
              userId: input.userId,
              isActive: true,
            },
            select: {
              id: true,
              gatewayType: true,
              providerMethodId: true,
              autopayEnabled: true,
            },
          });
          const resolved = this.assertChargeableMethod(method, input.gatewayType);
          if (Date.now() - startedAt > timing.lockWaitMs) {
            throw chargeRefusedAsBusy();
          }
          const deadline = new AbortController();
          const timer = setTimeout(
            () => deadline.abort(new Error(`The charge was not submitted within ${timing.submitMs} ms`)),
            timing.submitMs,
          );
          try {
            return await submit(resolved, deadline.signal);
          } finally {
            clearTimeout(timer);
          }
        },
        { timeout: chargeLockHoldMs(timing) },
      );
    } catch (error: unknown) {
      // The lock was not free within `lock_timeout` (SQLSTATE 55P03, which the
      // pg adapter reports as P2010 on a raw query): nothing was submitted.
      if (isLockNotAvailable(error)) throw chargeRefusedAsBusy();
      throw error;
    }
  }

  private assertChargeableMethod(
    method: {
      readonly id: string;
      readonly gatewayType: PaymentGatewayType;
      readonly providerMethodId: string;
      readonly autopayEnabled: boolean;
    } | null,
    gatewayType: PaymentGatewayType,
  ): { readonly id: string; readonly providerMethodId: string } {
    if (method === null) {
      throw new BadRequestException({
        code: 'SAVED_PAYMENT_METHOD_NOT_FOUND',
        message: 'Saved payment method not found or inactive',
      });
    }
    if (!method.autopayEnabled) {
      throw new BadRequestException({
        code: 'SAVED_PAYMENT_METHOD_AUTOPAY_DISABLED',
        message: 'Autopay is disabled for this payment method',
      });
    }
    if (method.gatewayType !== gatewayType) {
      throw new BadRequestException({
        code: 'SAVED_PAYMENT_METHOD_GATEWAY_MISMATCH',
        message: 'Saved payment method does not match the selected gateway',
      });
    }
    if (
      typeof method.providerMethodId !== 'string' ||
      method.providerMethodId.trim().length === 0
    ) {
      throw new BadRequestException({
        code: 'SAVED_PAYMENT_METHOD_INVALID',
        message: 'Saved payment method has no provider instrument id',
      });
    }
    return {
      id: method.id,
      providerMethodId: method.providerMethodId.trim(),
    };
  }

  private async lockForChargeDecision(
    tx: Prisma.TransactionClient,
    methodId: string,
  ): Promise<void> {
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "saved_payment_methods" WHERE "id" = ${methodId} FOR UPDATE`,
    );
  }

  /**
   * {@link lockForChargeDecision} for the customer's own switch, waiting at
   * most {@link CUSTOMER_SWITCH_LOCK_WAIT_MS}; past that PostgreSQL gives up
   * with 55P03, which {@link customerSwitch} answers as busy.
   */
  private async lockForCustomerSwitch(tx: Prisma.TransactionClient, methodId: string): Promise<void> {
    await tx.$executeRaw(Prisma.raw(`SET LOCAL lock_timeout = '${CUSTOMER_SWITCH_LOCK_WAIT_MS}ms'`));
    await this.lockForChargeDecision(tx, methodId);
  }

  /** Runs a customer's switch; a lock a charge holds past the wait answers 409 busy. */
  private async customerSwitch<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error: unknown) {
      if (isLockNotAvailable(error)) throw customerSwitchRefusedAsBusy();
      throw error;
    }
  }

  /** {@link lockForChargeDecision} without waiting: false when a charge decision holds it. */
  private async tryLockForChargeDecision(
    tx: Prisma.TransactionClient,
    methodId: string,
  ): Promise<boolean> {
    const locked = await tx.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT "id" FROM "saved_payment_methods" WHERE "id" = ${methodId} FOR UPDATE SKIP LOCKED`,
    );
    return locked.length > 0;
  }

  /**
   * Upserts a YooKassa (or compatible) saved payment_method from a successful payment.
   * Safe to call on every COMPLETED reconciliation — unique on (gateway, providerMethodId).
   */
  public async upsertFromYookassaPayment(input: {
    readonly userId: string;
    readonly transactionId: string | null;
    readonly gatewayId: string | null;
    readonly rawPayload: unknown;
  }): Promise<void> {
    const paymentObject = extractYookassaPaymentObject(input.rawPayload);
    if (paymentObject === null) {
      return;
    }

    const paymentMethod = asRecord(paymentObject.payment_method);
    if (paymentMethod === null) {
      return;
    }

    // Only store methods the provider marked as reusable for autopayments.
    if (paymentMethod.saved !== true) {
      return;
    }

    const providerMethodId = readString(paymentMethod.id);
    if (providerMethodId === null) {
      return;
    }

    const methodType = readString(paymentMethod.type) ?? 'unknown';
    const card = asRecord(paymentMethod.card);
    const cardLast4 = readString(card?.last4);
    const cardFirst6 = readString(card?.first6);
    const cardExpiryMonth = readString(card?.expiry_month);
    const cardExpiryYear = readString(card?.expiry_year);
    const cardIssuerCountry = readString(card?.issuer_country);
    const cardProduct =
      readString(asRecord(card?.card_product)?.name) ?? readString(card?.card_type);
    const title =
      readString(paymentMethod.title) ??
      buildDisplayTitle({
        methodType,
        cardLast4,
        cardProduct,
      });

    const rawSnapshot = {
      id: providerMethodId,
      type: methodType,
      saved: true,
      title,
      card: card
        ? {
            first6: cardFirst6,
            last4: cardLast4,
            expiry_month: cardExpiryMonth,
            expiry_year: cardExpiryYear,
            issuer_country: cardIssuerCountry,
            card_product: cardProduct,
          }
        : null,
    } as Prisma.InputJsonValue;

    try {
      const existing = await this.prismaService.savedPaymentMethod.findUnique({
        where: {
          gatewayType_providerMethodId: {
            gatewayType: PaymentGatewayType.YOOKASSA,
            providerMethodId,
          },
        },
      });

      if (existing !== null) {
        // Never reassign a provider method that already belongs to another user.
        // Same-user rebind is allowed (reactivate after unbind / refresh metadata).
        if (existing.userId !== input.userId) {
          this.logger.warn(
            `Refusing to rebind YOOKASSA method ${providerMethodId}: owned by ${existing.userId}, payment by ${input.userId}`,
          );
          return;
        }
        await this.prismaService.savedPaymentMethod.update({
          where: { id: existing.id },
          data: {
            methodType,
            title,
            cardLast4,
            cardFirst6,
            cardExpiryMonth,
            cardExpiryYear,
            cardIssuerCountry,
            cardProduct,
            isActive: true,
            unboundAt: null,
            sourceTransactionId: existing.sourceTransactionId ?? input.transactionId,
            sourceGatewayId: existing.sourceGatewayId ?? input.gatewayId,
            rawSnapshot,
          },
        });
        return;
      }

      await this.prismaService.savedPaymentMethod.create({
        data: {
          userId: input.userId,
          gatewayType: PaymentGatewayType.YOOKASSA,
          providerMethodId,
          methodType,
          title,
          cardLast4,
          cardFirst6,
          cardExpiryMonth,
          cardExpiryYear,
          cardIssuerCountry,
          cardProduct,
          isActive: true,
          sourceTransactionId: input.transactionId,
          sourceGatewayId: input.gatewayId,
          rawSnapshot,
        },
      });

      this.systemEvents.info(
        EVENT_TYPES.PAYMENT_METHOD_SAVED,
        'PAYMENT',
        `Сохранён способ оплаты: ${methodType}`,
        {
          userId: input.userId,
          gatewayType: PaymentGatewayType.YOOKASSA,
          methodType,
          cardLast4,
          transactionId: input.transactionId,
          providerMethodId,
        },
      );
    } catch (error: unknown) {
      // Unique race: another webhook worker inserted the same method.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        this.logger.debug(
          `Saved payment method race for ${providerMethodId}; treating as upserted`,
        );
        return;
      }
      this.logger.error(
        `Failed to persist saved payment method for user ${input.userId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Persists a method returned by YooKassa's standalone zero-amount binding
   * API. It deliberately reuses the normal ownership and rebind safeguards,
   * but has no source transaction because no money was charged.
   */
  public async upsertFromYookassaPaymentMethod(input: {
    readonly userId: string;
    readonly rawPaymentMethod: unknown;
  }): Promise<void> {
    await this.upsertFromYookassaPayment({
      userId: input.userId,
      transactionId: null,
      gatewayId: null,
      rawPayload: { payment_method: input.rawPaymentMethod },
    });
  }
}

/** A charge that did not have its saved method's lock in time: nothing was submitted, it may be tried again. */
function chargeRefusedAsBusy(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    code: SAVED_PAYMENT_METHOD_BUSY,
    message: 'The saved payment method is busy with another charge; nothing was submitted',
  });
}

/**
 * The customer's switch or unbind met a payment in progress with the method
 * ({@link CUSTOMER_SWITCH_LOCK_WAIT_MS}): nothing changed, and it can be done
 * again in a minute. The cabinet says so in «Способы оплаты».
 */
function customerSwitchRefusedAsBusy(): ConflictException {
  return new ConflictException({
    code: SAVED_PAYMENT_METHOD_BUSY,
    message: 'A payment with this saved payment method is in progress; nothing was changed, try again in a minute',
  });
}

/**
 * PostgreSQL gave up waiting for a row lock at `lock_timeout` (SQLSTATE
 * 55P03). Read the way `isRetryableTransactionConflict` reads a deadlock: with
 * the pg driver adapter the SQLSTATE is in `meta.driverAdapterError.cause`, and
 * the Prisma code is P2010 for a raw query, not a code of its own.
 */
function isLockNotAvailable(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  const meta = error.meta as
    | {
        readonly code?: unknown;
        readonly driverAdapterError?: { readonly cause?: { readonly code?: unknown; readonly originalCode?: unknown } };
      }
    | undefined;
  const cause = meta?.driverAdapterError?.cause;
  const sqlState = cause?.code ?? cause?.originalCode ?? meta?.code;
  return sqlState === '55P03' || /Code: `55P03`/.test(error.message);
}

function extractYookassaPaymentObject(rawPayload: unknown): Record<string, unknown> | null {
  const root = asRecord(rawPayload);
  if (root === null) {
    return null;
  }
  // Webhook shape: { event, object: { id, payment_method, ... } }
  const object = asRecord(root.object);
  if (object !== null && (object.payment_method !== undefined || object.id !== undefined)) {
    return object;
  }
  // Some paths may store the payment object itself.
  if (root.payment_method !== undefined) {
    return root;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function readString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function buildDisplayTitle(input: {
  readonly methodType: string;
  readonly cardLast4?: string | null;
  readonly cardProduct?: string | null;
}): string {
  if (input.cardLast4) {
    const product = input.cardProduct ? `${input.cardProduct} ` : '';
    return `${product}•••• ${input.cardLast4}`.trim();
  }
  switch (input.methodType) {
    case 'bank_card':
      return 'Банковская карта';
    case 'yoo_money':
      return 'ЮMoney';
    case 'sberbank':
      return 'SberPay';
    case 'tinkoff_bank':
      return 'T-Pay';
    case 'sbp':
      return 'СБП';
    default:
      return input.methodType;
  }
}
