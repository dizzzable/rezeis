import { Injectable, Logger, NotFoundException, OnModuleDestroy } from '@nestjs/common';
import { PaymentGatewayType, ProviderSubscription } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { EVENT_TYPES, SystemEventsService } from '../../../common/services/system-events.service';
import { buildAdminAuditLogData } from '../../../common/utils/admin-audit-log.util';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { RequestMetadataInterface } from '../../auth/interfaces/request-metadata.interface';
import { type AutopayRefundOutcome, UNKNOWN_AUTOPAY_GATEWAY } from '../utils/refund-autopay.util';
import { AFTER_RESPONSE_SHUTDOWN_WAIT_MS } from './payment-reconciliation.service';
import { OperatorProviderSubscriptionInterface, ProviderSubscriptionService } from './provider-subscription.service';
import { SavedPaymentMethodService, SwitchedOffMethod } from './saved-payment-method.service';

/** A saved ЮKassa method as the user's card in the panel shows it. */
export interface AdminYookassaMethodInterface {
  readonly id: string;
  readonly title: string;
  readonly methodType: string;
  readonly cardLast4: string | null;
  readonly autopayEnabled: boolean;
}

/** The customer's autopays, for the user's card in the panel. */
export interface AdminUserAutopayInterface {
  /** Platega and RollyPay subscriptions the provider charges on its own schedule, live ones. */
  readonly providerSubscriptions: readonly OperatorProviderSubscriptionInterface[];
  /** The customer's active ЮKassa methods; the panel charges them itself where `autopayEnabled`. */
  readonly yookassaMethods: readonly AdminYookassaMethodInterface[];
}

/** What «Отменить автосписание» did, as the operator's answer says it. */
export interface AdminProviderAutopayCancelResultInterface {
  /**
   * `CANCELLING` — marked, and the provider is asked after this answer;
   * `ENDED` — it was not live any more; `REFUND_ENDING` — a refund is already
   * cancelling it.
   */
  readonly state: 'CANCELLING' | 'ENDED' | 'REFUND_ENDING';
}

/** What «Выключить автосписание ЮKassa» did. */
export interface AdminYookassaAutopayDisableResultInterface {
  /** Switched off in the request. */
  readonly switched: number;
  /** Held by a charge being submitted: switched off after the answer, when that charge ends. */
  readonly pending: number;
}

/**
 * The operator's «Отменить автосписание» on the user's card in the panel,
 * without a refund: a Platega or RollyPay subscription cancelled at the
 * provider, or the ЮKassa autopay switched off on every saved method.
 *
 * The answer never waits on a provider. A provider subscription is marked in
 * the request (`OPERATOR_CANCELLED_BY`), so the sweep finishes a cancel the
 * provider does not take, and the provider is asked after the answer. A
 * ЮKassa method a charge is being submitted with is switched off after the
 * answer too, when that charge lets go of it.
 *
 * Told to the operator by an operator-only card
 * (`payment.autopay_stopped_by_operator`), after the provider said what it
 * did, and written to the audit log. The customer is told nothing: the
 * customer's own switch raises `payment.method_autopay_updated`, and a letter
 * or a rule bound to it would say the customer did it. In the cabinet
 * («Способы оплаты») a cancelled provider autopay is gone from the list, and a
 * ЮKassa method shows its «Автосписание» switch off, the customer's to turn
 * back on.
 */
@Injectable()
export class AdminAutopayService implements OnModuleDestroy {
  private readonly logger = new Logger(AdminAutopayService.name);
  /** The work after an answer, each with what its card says if the panel stops first. */
  private readonly underWay = new Map<Promise<void>, { readonly label: string; readonly interrupted: () => void }>();

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly providerSubscriptions: ProviderSubscriptionService,
    private readonly savedPaymentMethods: SavedPaymentMethodService,
    private readonly systemEvents: SystemEventsService,
  ) {}

  public async listForUser(userId: string): Promise<AdminUserAutopayInterface> {
    await this.requireUser(userId);
    const [providerSubscriptions, saved] = await Promise.all([
      this.providerSubscriptions.listForOperator(userId),
      this.savedPaymentMethods.listActiveForUser(userId),
    ]);
    return {
      providerSubscriptions,
      yookassaMethods: saved.methods
        .filter((method) => method.gatewayType === PaymentGatewayType.YOOKASSA)
        .map((method) => ({
          id: method.id,
          title: method.title,
          methodType: method.methodType,
          cardLast4: method.cardLast4,
          autopayEnabled: method.autopayEnabled,
        })),
    };
  }

  /**
   * «Отменить автосписание» of one Platega or RollyPay subscription: marked
   * now, cancelled at the provider after the answer, then the card.
   */
  public async cancelProviderSubscription(input: {
    readonly userId: string;
    readonly providerSubscriptionRowId: string;
    readonly currentAdmin: CurrentAdminInterface;
    readonly requestMetadata: RequestMetadataInterface;
  }): Promise<AdminProviderAutopayCancelResultInterface> {
    const owned = await this.prismaService.providerSubscription.findFirst({
      where: { id: input.providerSubscriptionRowId, userId: input.userId },
      select: { id: true },
    });
    if (owned === null) {
      throw new NotFoundException('Provider subscription not found');
    }
    const marked = await this.providerSubscriptions.markForOperatorCancel(owned.id);
    if (marked.state === 'NOT_FOUND') {
      throw new NotFoundException('Provider subscription not found');
    }
    if (marked.state !== 'MARKED') {
      return { state: marked.state };
    }
    const row = marked.row;
    await this.prismaService.adminAuditLog.create({
      data: buildAdminAuditLogData({
        action: 'payments.autopay.provider_subscription_cancelled',
        actorId: input.currentAdmin.id,
        requestMetadata: input.requestMetadata,
        metadata: {
          requestId: input.requestMetadata.requestId,
          userId: input.userId,
          providerSubscriptionRowId: row.id,
          gatewayType: row.gatewayType,
          providerSubscriptionId: row.providerSubscriptionId,
          subscriptionId: row.subscriptionId,
          amount: row.amount.toString(),
          currency: row.currency,
        },
      }),
    });
    const planName = await this.planName(row.planId);
    let told = false;
    const tell = (outcome: AutopayRefundOutcome | 'INTERRUPTED'): void => {
      if (told) return;
      told = true;
      this.announceProviderCancel(row, input.currentAdmin.id, planName, outcome);
    };
    this.runAfterResponse(
      `the operator's cancel of provider subscription ${row.id}`,
      async () => tell(await this.providerSubscriptions.cancelForOperator(row.id)),
      () => tell('INTERRUPTED'),
    );
    return { state: 'CANCELLING' };
  }

  /**
   * «Выключить автосписание ЮKassa»: every active ЮKassa method of the
   * customer stops being charged by the renewal. The methods stay saved.
   */
  public async disableYookassaAutopay(input: {
    readonly userId: string;
    readonly currentAdmin: CurrentAdminInterface;
    readonly requestMetadata: RequestMetadataInterface;
  }): Promise<AdminYookassaAutopayDisableResultInterface> {
    await this.requireUser(input.userId);
    const first = await this.savedPaymentMethods.disableAutopayForOperator({
      userId: input.userId,
      adminId: input.currentAdmin.id,
      waitForCharges: false,
    });
    if (first.switched.length === 0 && first.busy === 0) {
      return { switched: 0, pending: 0 };
    }
    await this.prismaService.adminAuditLog.create({
      data: buildAdminAuditLogData({
        action: 'payments.autopay.yookassa_disabled',
        actorId: input.currentAdmin.id,
        requestMetadata: input.requestMetadata,
        metadata: {
          requestId: input.requestMetadata.requestId,
          userId: input.userId,
          switchedMethodIds: first.switched.map((method) => method.id),
          pending: first.busy,
        },
      }),
    });
    if (first.busy === 0) {
      this.announceYookassaDisable(input.userId, input.currentAdmin.id, first.switched, { failed: false, interrupted: false });
      return { switched: first.switched.length, pending: 0 };
    }
    let told = false;
    const tell = (late: readonly SwitchedOffMethod[], failed: boolean, interrupted: boolean): void => {
      if (told) return;
      told = true;
      this.announceYookassaDisable(input.userId, input.currentAdmin.id, [...first.switched, ...late], { failed, interrupted });
    };
    this.runAfterResponse(
      `the operator's switch-off of the ЮKassa autopay of user ${input.userId}`,
      async () => {
        try {
          const late = await this.savedPaymentMethods.disableAutopayForOperator({
            userId: input.userId,
            adminId: input.currentAdmin.id,
            waitForCharges: true,
          });
          tell(late.switched, false, false);
        } catch (error: unknown) {
          this.logger.error(
            `Could not switch off the ЮKassa autopay of user ${input.userId} after a charge: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          tell([], true, false);
        }
      },
      () => tell([], false, true),
    );
    return { switched: first.switched.length, pending: first.busy };
  }

  /** Waits for the work after the answers under way (a spec's, and a stop's, handle). */
  public async settleAfterResponse(): Promise<void> {
    while (this.underWay.size > 0) {
      await Promise.all([...this.underWay.keys()]);
    }
  }

  /**
   * A stop never loses a card: the work under way gets
   * {@link AFTER_RESPONSE_SHUTDOWN_WAIT_MS}, then every card still owed goes
   * out saying the provider had not answered. The rows are marked, so the
   * sweep finishes a cancel the stop cut.
   */
  public async onModuleDestroy(): Promise<void> {
    if (this.underWay.size === 0) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.settleAfterResponse(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, AFTER_RESPONSE_SHUTDOWN_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
    for (const { label, interrupted } of this.underWay.values()) {
      this.logger.warn(`${label} was cut by the stop; its card goes out as it stands`);
      try {
        interrupted();
      } catch (error: unknown) {
        this.logger.error(`${label}: its card could not be sent: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** Runs `work` past the answer, tracked until done. Never rejects. */
  private runAfterResponse(label: string, work: () => Promise<void>, interrupted: () => void): void {
    const task: Promise<void> = work()
      .catch((error: unknown) => {
        this.logger.error(`${label} failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        this.underWay.delete(task);
      });
    this.underWay.set(task, { label, interrupted });
  }

  private announceProviderCancel(
    row: ProviderSubscription,
    adminId: string,
    planName: string | null,
    outcome: AutopayRefundOutcome | 'INTERRUPTED',
  ): void {
    this.systemEvents.warn(
      EVENT_TYPES.PAYMENT_AUTOPAY_STOPPED_BY_OPERATOR,
      'PAYMENT',
      `Автосписание отключено в панели: ${row.gatewayType}`,
      {
        userId: row.userId,
        adminId,
        gatewayType: row.gatewayType,
        providerSubscriptionId: row.providerSubscriptionId,
        ...(row.subscriptionId === null ? {} : { subscriptionId: row.subscriptionId }),
        ...(planName === null ? {} : { planName }),
        amount: row.amount.toString(),
        currency: row.currency,
        note: describeOperatorProviderCancel(row.gatewayType, outcome),
      },
    );
  }

  private announceYookassaDisable(
    userId: string,
    adminId: string,
    switched: readonly SwitchedOffMethod[],
    how: { readonly failed: boolean; readonly interrupted: boolean },
  ): void {
    this.systemEvents.warn(
      EVENT_TYPES.PAYMENT_AUTOPAY_STOPPED_BY_OPERATOR,
      'PAYMENT',
      'Автосписание отключено в панели: YOOKASSA',
      {
        userId,
        adminId,
        gatewayType: PaymentGatewayType.YOOKASSA,
        note: describeOperatorYookassaDisable(switched, how),
      },
    );
  }

  private async planName(planId: string): Promise<string | null> {
    try {
      const plan = await this.prismaService.plan.findUnique({ where: { id: planId }, select: { name: true } });
      return plan?.name ?? null;
    } catch {
      return null;
    }
  }

  private async requireUser(userId: string): Promise<void> {
    const user = await this.prismaService.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (user === null) {
      throw new NotFoundException('User not found');
    }
  }
}

/** The name the panel shows for a gateway that runs a provider subscription. */
function providerName(gatewayType: string): string {
  if (gatewayType === PaymentGatewayType.PLATEGA) return 'Platega';
  if (gatewayType === PaymentGatewayType.ROLLYPAY) return 'RollyPay';
  return gatewayType;
}

/**
 * The «📝 Заметка» of the operator's cancel of a provider autopay: what the
 * provider did, what the customer sees, and what to do when it did not answer.
 */
export function describeOperatorProviderCancel(
  gatewayType: string,
  outcome: AutopayRefundOutcome | 'INTERRUPTED',
): string {
  const provider = providerName(gatewayType);
  if (outcome === 'INTERRUPTED') {
    return (
      `Отмена у ${provider} не успела завершиться до перезапуска панели: панель повторяет её каждые 10 минут. ` +
      `Чтобы остановить списания сразу, отмените подписку в личном кабинете ${provider}.`
    );
  }
  if (outcome.cancelled.length > 0) {
    return (
      `Автосписание отменено у ${provider}: новых списаний не будет. Оплаченный срок подписки не меняется. ` +
      'Клиенту панель ничего не сообщала; в кабинете, в «Способах оплаты», этого автосписания больше нет.'
    );
  }
  if (outcome.failed.some((row) => row.gatewayType === UNKNOWN_AUTOPAY_GATEWAY)) {
    return (
      'Проверить автосписание не удалось: панель повторяет отмену каждые 10 минут. ' +
      `Проверьте подписку клиента в личном кабинете ${provider} и при необходимости отмените её там.`
    );
  }
  if (outcome.failed.length > 0) {
    return (
      `Отменить автосписание у ${provider} сразу не удалось: панель повторяет отмену каждые 10 минут. ` +
      `Чтобы остановить списания сразу, отмените подписку в личном кабинете ${provider}.`
    );
  }
  return 'Автосписание уже было отменено раньше — отменять было нечего.';
}

/** The «📝 Заметка» of the operator's switch-off of the ЮKassa autopay. */
export function describeOperatorYookassaDisable(
  switched: readonly SwitchedOffMethod[],
  how: { readonly failed: boolean; readonly interrupted: boolean },
): string {
  const parts: string[] = [];
  if (switched.length > 0) {
    parts.push(
      `Автосписание через ЮKassa выключено: ${switched.map((method) => method.title).join(', ')}. ` +
        'Способы оплаты остались привязанными. Клиенту панель ничего не сообщала; в кабинете, в «Способах оплаты», ' +
        'у них выключен переключатель «Автосписание», и клиент может включить его снова.',
    );
  }
  if (how.failed) {
    parts.push(
      'Один способ оплаты в этот момент использовался для списания, и выключить на нём автосписание потом не удалось: ' +
        'следующее продление может списать деньги. Нажмите «Выключить автосписание ЮKassa» в карточке клиента ещё раз.',
    );
  } else if (how.interrupted) {
    parts.push(
      'Один способ оплаты в этот момент использовался для списания, а панель перезапустилась раньше, чем оно кончилось: ' +
        'автосписание на нём могло остаться включённым. Нажмите «Выключить автосписание ЮKassa» в карточке клиента ещё раз.',
    );
  }
  return parts.length === 0 ? 'Автосписание через ЮKassa уже было выключено.' : parts.join(' ');
}
