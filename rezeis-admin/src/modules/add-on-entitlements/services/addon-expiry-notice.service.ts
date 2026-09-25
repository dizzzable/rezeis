import { InjectQueue } from '@nestjs/bullmq';
import { BeforeApplicationShutdown, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  AddOnEntitlementActorType,
  AddOnEntitlementState,
  AddOnLifetime,
  AddOnType,
  Prisma,
  SubscriptionStatus,
} from '@prisma/client';
import { Queue } from 'bullmq';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { runBullMqEnqueueWithTimeout } from '../../../common/queue/bullmq-enqueue-options';
import { shouldRunSchedules } from '../../../common/runtime/process-role.util';
import { NotificationTemplatesService } from '../../notifications/services/notification-templates.service';
import { UserNotificationsService } from '../../notifications/services/user-notifications.service';
import {
  ADD_ON_EXPIRY_NOTICE_JOB_ID,
  ADD_ON_EXPIRY_NOTICE_QUEUE,
  ADD_ON_EXPIRY_NOTICE_TICK_JOB,
  ADD_ON_NOTICE_BATCH,
  ADD_ON_NOTICE_COMMAND_KEY,
  ADD_ON_NOTICE_DELIVERED_KEY,
  ADD_ON_NOTICE_LEAD_MS,
  ADD_ON_NOTICE_REDELIVER_AFTER_MS,
} from '../addon-expiry-notice.constants';
import { readAddOnRolloutFlags } from '../add-on-rollout.config';
import { entitlementEndBound } from '../domain/add-on-lifetime';
import { RESET_EXPIRY_MARGIN_MS } from '../domain/reset-cycle-policy';
import { LAPSED_TERM_WINDOW_MS } from '../domain/term-window';
import { AddOnSwitchesService } from '../switches/add-on-switches.service';

/** The two moments a customer is told about: three days before the end, and the end. */
export type AddOnNoticeMoment = 'endsSoon' | 'ended';

/** Both moments, in the order a pass takes them. */
const NOTICE_MOMENTS: readonly AddOnNoticeMoment[] = ['endsSoon', 'ended'];

/** What one pass did, for its log line and the tests. */
export interface AddOnNoticeTickReport {
  /** Notices written to the feed and handed to the channels. */
  readonly sent: number;
  /** «Has ended» decided and recorded without a notice: the subscription ended with the add-on. */
  readonly skipped: number;
  /** Left for a later pass: the template is missing or switched off. */
  readonly templateOff: number;
  /** Decided by another runner first. */
  readonly lost: number;
  /** Left for a later pass: the add-on's end moved, or is about to, since it was selected. */
  readonly moved: number;
  /** Decided before, with channels a crash cut off: sent again. */
  readonly resent: number;
  readonly errors: number;
}

const GIB = 1024 ** 3;

/**
 * A reset add-on whose cycle is shorter than this — a daily or a weekly
 * reset — is told about at neither moment. A week, with room for a
 * daylight-saving hour; a monthly cycle is never under 28 days.
 *
 * Why neither, and not only «has ended»: «через 3 дня» cannot fit a daily
 * cycle, and on a weekly one it would arrive every week for three of its seven
 * days. «Закончилась» would come every night (or every Monday) at the reset —
 * the moment the customer's counter starts again, so there is nothing to act
 * on — for a customer who bought it knowing the date: the purchase screen
 * warns before payment and «Мои опции» shows the reset. A monthly reset keeps
 * both notices, in the reset's own words.
 */
export const SHORT_RESET_CYCLE_MS = 8 * 24 * 60 * 60 * 1000;

/**
 * The template a notice is sent with: its moment, and — for devices — what
 * the end does to the devices already connected, which stage 6 — the switch
 * «Удалять лишние устройства автоматически» — decides; for traffic, whether
 * the add-on ends with Remnawave's traffic reset (see `ADD_ON_TEMPLATES`).
 */
export function addOnNoticeType(
  moment: AddOnNoticeMoment,
  addOnType: AddOnType,
  deviceCleanupAuto: boolean,
  endsWithTrafficReset: boolean = false,
): string {
  const kind =
    addOnType === AddOnType.EXTRA_DEVICES
      ? deviceCleanupAuto
        ? 'addon_devices_auto'
        : 'addon_devices'
      : endsWithTrafficReset
        ? 'addon_reset'
        : 'addon';
  return moment === 'endsSoon' ? `${kind}_ends_in_3_days` : `${kind}_ended`;
}

/**
 * The traffic reset an add-on ends with — Remnawave's reset instant, its
 * epoch's `plannedEndsAt` — or `null` when it ends otherwise: «до конца
 * подписки», or a reset add-on the subscription's earlier end caps. The bound
 * is `entitlementEndBound`'s, the one rule every reader of a sold add-on uses.
 */
export function trafficResetEndOf(
  row: Pick<AddOnNoticeRow, 'lifetime' | 'expiresAt' | 'expiryEpoch'>,
): Date | null {
  const bound = entitlementEndBound({
    lifetime: row.lifetime,
    expiresAt: row.expiresAt,
    epochPlannedEndsAt: row.expiryEpoch?.plannedEndsAt ?? null,
  });
  return bound === 'reset' && row.expiryEpoch !== null ? row.expiryEpoch.plannedEndsAt : null;
}

/** A reset add-on on a daily or weekly reset: no notice at either moment (`SHORT_RESET_CYCLE_MS`). */
export function isQuietResetCycle(row: Pick<AddOnNoticeRow, 'lifetime' | 'expiresAt' | 'expiryEpoch'>): boolean {
  if (trafficResetEndOf(row) === null || row.expiryEpoch === null) return false;
  return row.expiryEpoch.plannedEndsAt.getTime() - row.expiryEpoch.startsAt.getTime() < SHORT_RESET_CYCLE_MS;
}

/** Thrown inside a claim to roll its feed row back: another runner recorded the moment first. */
class ClaimLost extends Error {}

/** Thrown inside a claim to roll its feed row back: the add-on's end moved, or is about to, since it was read. */
class EndMoved extends Error {}

type Tally = {
  -readonly [Key in keyof AddOnNoticeTickReport]: number;
};

interface Pass {
  readonly now: Date;
  readonly deviceCleanupAuto: boolean;
  /** Each notice's channels and their record, run after its claim committed; the pass waits for them before it ends. */
  readonly deliveries: Array<Promise<void>>;
  /** One read of each template per pass. */
  readonly templates: Map<string, { readonly isActive: boolean } | null>;
  readonly tally: Tally;
}

/**
 * TELLS A CUSTOMER THAT A DATED ADD-ON IS ABOUT TO END, AND THAT IT HAS.
 *
 * Owner, 24.09.2026: «Предупреждать клиента за 3 дня и в день окончания
 * докупки: бот и письмо, кнопка «Купить снова». Если сгорят устройства,
 * сказать, что лишние отключатся сами». An add-on bought while the durable
 * model is on has an end (`AddOnEntitlement.expiresAt`), and before this
 * nothing told the customer: a device slot or gigabytes were gone the day the
 * boundary sweep took them.
 *
 * ── Which add-ons, and when ───────────────────────────────────────────────
 *
 *  - Only entitlements with an end date. Add-ons bought before the model are
 *    folded into the term's base (grandfathered); they have no row, never
 *    end, and are never told about.
 *  - «Ends in 3 days»: ACTIVE, ending within three days, on a subscription
 *    that is ACTIVE or LIMITED — and not one bought inside those three days,
 *    whose checkout has just shown its date.
 *  - «Has ended»: ended by the boundary sweep (EXPIRING — a device reduction
 *    under way — or EXPIRED) within the last three days. Sent only while the
 *    subscription goes on past the end: an add-on that ends with its
 *    subscription is told about by the subscription's own «Подписка
 *    закончилась», and «Купить снова» has nothing to be bought for. That
 *    decision is recorded too, so it is not taken again.
 *  - Traffic that ends with Remnawave's traffic reset (stage 4) is told in
 *    the reset's words — «действует до сброса трафика 1 октября в 03:20 по
 *    Москве; после сброса лимит вернётся к тарифу» — on a monthly reset only:
 *    a daily or weekly one gets no notice at all (`SHORT_RESET_CYCLE_MS`). A
 *    reset add-on the subscription's earlier end caps is told in the ordinary
 *    words: it ends with the subscription, not at a reset.
 *  - Whatever the rollout flags say. The notices follow the add-on's row, as
 *    the boundary sweep that ends it does (it reads no flag): an add-on sold
 *    while stage 2 («Новый учёт докупок») was on still ends
 *    after stage 2 is turned off, and its customer is told. Only stage 6 is
 *    read, for what the end does to the devices. The model's rule since
 *    24.09.2026: behaviour follows the row, not the flag.
 *
 * ── The date it names is the date the add-on ends ────────────────────────
 *
 * «Ends in 3 days» names the add-on's end, and that end can be about to move:
 * bonus days, the operator's editor or the Remnawave pull move the
 * subscription's expiry and leave the term to the hourly drift sweep, which
 * then moves every add-on sold "until the end of the subscription" with it.
 * Such an add-on is not due until the sweep has caught its term up — the
 * selection leaves it out (`endMovesWithAlignmentSql`, the alignment's own rule
 * read without writing) — and the claim reads the add-on again right before it
 * writes, under a share lock: an end that moved (its `version` changed) or is
 * about to move since the pass read it rolls the claim back, unrecorded, and a
 * later pass decides on the new end — nothing now if it is beyond three days.
 *
 * ── Once, whatever happens — and the channels at least once ─────────────
 *
 * Each moment of each add-on is decided once, and the decision is on the
 * add-on's own event log: an `AddOnEntitlementEvent` under a fixed command key
 * (`ADD_ON_NOTICE_COMMAND_KEY`), unique per entitlement. The event and the
 * notice's feed row are written in ONE transaction (`createInTransaction`), so a
 * retry, a restart or a second worker finds the event and writes no second
 * row — and never a feed row without its record, or a record without its row.
 *
 * The channels — the bot, web push, the letter — cannot join that
 * transaction, so the record is an OUTBOX: they run after the commit, and a
 * second record (`ADD_ON_NOTICE_DELIVERED_KEY`) is written once they have. A
 * crash between the two leaves a decision without it, and every pass first
 * sends such a notice's channels again (`selectUndeliveredAddOnNotices`) —
 * after `ADD_ON_NOTICE_REDELIVER_AFTER_MS`, so a pass still delivering is not
 * raced, and only while the add-on is still in the moment's window. The same
 * feed row, and so the same id the channels deduplicate on: at worst a rare
 * second copy (a channel retries a send whose outcome it cannot tell), never a
 * lost one. A record written before the channels ran would lose them to a
 * crash in between.
 *
 * ── The channels, as the subscription's own expiry notices have them ─────
 *
 * The feed row always; the bot for a linked Telegram; web push; the letter when
 * the customer has a verified address and the operator has «Email (SMTP)» on
 * with «Слать уведомления клиентам на почту»; the operator's mirror when it is
 * on. The customer's switches in the cabinet («Дополнительные опции»: «За 3 дня
 * до окончания опции», «Когда опция закончилась») and the operator's toggles
 * are the fanout's to honour, as for every notice.
 *
 * ── Beside the sweep ─────────────────────────────────────────────────────
 *
 * Its own queue and its own schedule; it only reads the add-on, its
 * subscription and its terms, and writes rows of its own. The one lock it
 * takes is a share lock on the add-on it is claiming, for the few
 * milliseconds of the claim — a sweep or an alignment writing that row waits
 * for it, and nothing it holds waits on them. A notice that fails is its own
 * affair: the pass goes on, the sweep does not hear of it.
 *
 * ── Scheduling ────────────────────────────────────────────────────────────
 *
 * A `@Cron` every ten minutes on the worker queues one pass under a fixed id
 * (`ADD_ON_EXPIRY_NOTICE_JOB_ID`), so only one runs at a time across every
 * process; a pass takes at most `ADD_ON_NOTICE_BATCH` add-ons per moment and
 * the next one carries on. The pass is queued only when something is due:
 * with no dated add-on in either window — an install that never sold one —
 * the cron costs the pass's own four selections (the due, and the undelivered,
 * of each moment), one row each, on the `(state, expires_at)` index, and
 * nothing is queued.
 */
@Injectable()
export class AddOnExpiryNoticeService implements BeforeApplicationShutdown {
  private readonly logger = new Logger(AddOnExpiryNoticeService.name);
  private stopping = false;

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly templatesService: NotificationTemplatesService,
    private readonly notifications: UserNotificationsService,
    @InjectQueue(ADD_ON_EXPIRY_NOTICE_QUEUE) private readonly queue: Queue,
    /** The stage switches; `@Optional()` only for the specs that build this by hand. */
    @Optional() private readonly addOnSwitches?: AddOnSwitchesService,
  ) {}

  /**
   * Every ten minutes on the worker: queue a pass when an add-on's moment is
   * due, whatever the flags say. No parameters: the cron library calls a job
   * with its own `onComplete`, and Nest passes it on.
   */
  @Cron(CronExpression.EVERY_10_MINUTES, { name: 'add-on-expiry-notice' })
  public async schedule(): Promise<boolean> {
    if (!shouldRunSchedules()) return false;
    if (!(await this.anyDue(new Date()))) return false;
    return this.enqueueTick();
  }

  /**
   * Whether a pass would find anything: the pass's own selections, one row
   * each, so it can never skip what the pass would send — a moment due, or a
   * decided notice whose channels a crash cut off. Never thrown: the next cron
   * looks again.
   */
  private async anyDue(now: Date): Promise<boolean> {
    try {
      for (const moment of NOTICE_MOMENTS) {
        const undelivered = await selectUndeliveredAddOnNotices(this.prismaService, moment, now, 1);
        if (undelivered.length > 0) return true;
        const due = await selectAddOnNoticeCandidates(this.prismaService, moment, now, 1);
        if (due.length > 0) return true;
      }
      return false;
    } catch (error: unknown) {
      this.logger.warn(
        `Add-on notice check failed; the next cron looks again: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  public beforeApplicationShutdown(): void {
    // A pass in flight finishes the add-on it is on and stops there.
    this.stopping = true;
  }

  /** Queues one pass under the fixed id. Bounded, and never thrown: the next cron queues it again. */
  public async enqueueTick(): Promise<boolean> {
    try {
      await runBullMqEnqueueWithTimeout(() =>
        this.queue.add(
          ADD_ON_EXPIRY_NOTICE_TICK_JOB,
          {},
          {
            jobId: ADD_ON_EXPIRY_NOTICE_JOB_ID,
            attempts: 1,
            removeOnComplete: true,
            removeOnFail: true,
          },
        ),
      );
      return true;
    } catch (error: unknown) {
      this.logger.warn(
        `Add-on notice pass not queued; the next cron retries: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  /**
   * One pass, as the processor runs it — whatever stage 2 says: a dated
   * add-on ends by its row, and its customer is told. Stage 6 is read here,
   * at the pass, for the device texts.
   */
  public async runTick(now: Date = new Date()): Promise<AddOnNoticeTickReport> {
    const flags = await readAddOnRolloutFlags(this.addOnSwitches);
    const pass: Pass = {
      now,
      deviceCleanupAuto: flags.deviceCleanupAuto,
      deliveries: [],
      templates: new Map(),
      tally: { sent: 0, skipped: 0, templateOff: 0, lost: 0, moved: 0, resent: 0, errors: 0 },
    };
    for (const moment of NOTICE_MOMENTS) {
      // The outbox first: notices decided before whose channels never ran.
      await this.resendUndelivered(moment, pass);
      const candidates = await selectAddOnNoticeCandidates(this.prismaService, moment, now);
      for (const entitlementId of candidates) {
        if (this.stopping) break;
        try {
          await this.noticeOne(entitlementId, moment, pass);
        } catch (error: unknown) {
          pass.tally.errors += 1;
          this.logger.warn(
            `Add-on notice ${moment} for entitlement ${entitlementId} failed; the next pass tries again: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }
    await Promise.allSettled(pass.deliveries);
    const report: AddOnNoticeTickReport = { ...pass.tally };
    if (report.sent + report.skipped + report.errors + report.lost + report.moved + report.resent > 0) {
      this.logger.log(
        `Add-on notices: sent ${report.sent}, recorded without a notice ${report.skipped}, ` +
          `template off ${report.templateOff}, decided elsewhere ${report.lost}, end moved ${report.moved}, ` +
          `sent again after a crash ${report.resent}, failed ${report.errors}`,
      );
    }
    return report;
  }

  /**
   * The outbox: each notice of `moment` decided before, whose channels have no
   * record of running, sent again on its own feed row and then recorded.
   */
  private async resendUndelivered(moment: AddOnNoticeMoment, pass: Pass): Promise<void> {
    const undelivered = await selectUndeliveredAddOnNotices(this.prismaService, moment, pass.now);
    for (const notice of undelivered) {
      if (this.stopping) break;
      try {
        const found =
          notice.notificationEventId !== null && (await this.notifications.redeliver(notice.notificationEventId));
        // A feed row that is gone has nothing left to send: recorded, so it is
        // not looked for again every pass.
        await this.recordDelivered(notice.entitlementId, moment, notice.notificationEventId, found ? 'again' : 'row_gone');
        if (found) pass.tally.resent += 1;
      } catch (error: unknown) {
        pass.tally.errors += 1;
        this.logger.warn(
          `Add-on notice ${moment} for entitlement ${notice.entitlementId} could not be sent again; ` +
            `the next pass tries again: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /** A decided notice's channels, then the record that they ran. Never rejects: a failure is left for the outbox. */
  private async deliverAndRecord(
    deliver: () => Promise<void>,
    entitlementId: string,
    moment: AddOnNoticeMoment,
    notificationEventId: string,
    pass: Pass,
  ): Promise<void> {
    try {
      await deliver();
      await this.recordDelivered(entitlementId, moment, notificationEventId, 'first');
    } catch (error: unknown) {
      pass.tally.errors += 1;
      this.logger.warn(
        `Add-on notice ${moment} for entitlement ${entitlementId}: its channels did not finish; a pass sends them ` +
          `again in ${ADD_ON_NOTICE_REDELIVER_AFTER_MS / 60_000} minutes: ${
            error instanceof Error ? error.message : String(error)
          }`,
      );
    }
  }

  /** The outbox's other half: this moment's channels ran (`ADD_ON_NOTICE_DELIVERED_KEY`). Once per add-on and moment. */
  private async recordDelivered(
    entitlementId: string,
    moment: AddOnNoticeMoment,
    notificationEventId: string | null,
    attempt: 'first' | 'again' | 'row_gone',
  ): Promise<void> {
    const current = await this.prismaService.addOnEntitlement.findUnique({
      where: { id: entitlementId },
      select: { state: true },
    });
    if (current === null) return;
    await this.prismaService.addOnEntitlementEvent.createMany({
      data: [
        {
          entitlementId,
          fromState: current.state,
          toState: current.state,
          reason: moment === 'endsSoon' ? 'CUSTOMER_NOTICE_ENDS_SOON_DELIVERED' : 'CUSTOMER_NOTICE_ENDED_DELIVERED',
          actorType: AddOnEntitlementActorType.SYSTEM,
          correlationId: `addon-notice:${entitlementId}`,
          commandKey: ADD_ON_NOTICE_DELIVERED_KEY[moment],
          metadata: { notificationEventId, attempt },
        },
      ],
      skipDuplicates: true,
    });
  }

  /**
   * One add-on's moment: read again, decided, and — in one transaction, after
   * the add-on is read once more under a share lock — its notice's feed row and
   * the record that it was decided. The channels go once that has committed,
   * and are recorded once they have run.
   */
  private async noticeOne(entitlementId: string, moment: AddOnNoticeMoment, pass: Pass): Promise<void> {
    const row = await this.prismaService.addOnEntitlement.findUnique({
      where: { id: entitlementId },
      select: {
        id: true,
        subscriptionId: true,
        type: true,
        state: true,
        version: true,
        receiptName: true,
        totalValue: true,
        activatedAt: true,
        expiresAt: true,
        lifetime: true,
        expiryEpoch: { select: { startsAt: true, plannedEndsAt: true } },
        subscription: {
          select: {
            userId: true,
            status: true,
            expiresAt: true,
            planSnapshot: true,
            trafficLimit: true,
            deviceLimit: true,
            remnawavePanelUsername: true,
          },
        },
      },
    });
    if (row === null || row.expiresAt === null) return;
    const verdict = decideAddOnNotice(row, moment, pass.now);
    if (verdict === 'notDue') return;

    const type = addOnNoticeType(moment, row.type, pass.deviceCleanupAuto, trafficResetEndOf(row) !== null);
    if (verdict === 'send' && !(await this.templateOn(type, pass))) {
      // Not recorded: switched on again while the add-on is still due, it goes.
      pass.tally.templateOff += 1;
      return;
    }

    let notice: { readonly eventId: string; readonly deliver: () => Promise<void> } | null = null;
    try {
      notice = await this.prismaService.$transaction(
        async (tx) => {
          // Right before the notice is written: the end it names is still the
          // add-on's, and not about to move. Under a share lock, so neither
          // the sweep nor an alignment moves it before this commits.
          if (!(await endStillStands(tx, row.id, row.version, moment))) throw new EndMoved();
          const created =
            verdict === 'send'
              ? await this.notifications.createInTransaction(tx, {
                  userId: row.subscription.userId,
                  type,
                  payload: noticePayload(row),
                })
              : null;
          const claimed = await tx.addOnEntitlementEvent.createMany({
            data: [
              {
                entitlementId: row.id,
                fromState: row.state,
                toState: row.state,
                reason: moment === 'endsSoon' ? 'CUSTOMER_NOTICE_ENDS_SOON' : 'CUSTOMER_NOTICE_ENDED',
                actorType: AddOnEntitlementActorType.SYSTEM,
                correlationId: `addon-notice:${row.id}`,
                commandKey: ADD_ON_NOTICE_COMMAND_KEY[moment],
                metadata: {
                  outcome: verdict === 'send' ? 'sent' : 'subscription_ended',
                  notificationType: type,
                  notificationEventId: created?.eventId ?? null,
                  expiresAt: row.expiresAt?.toISOString() ?? null,
                  // When it was decided, on the pass's clock: the outbox
                  // sends its channels again only once this is long past.
                  decidedAt: pass.now.toISOString(),
                },
              },
            ],
            skipDuplicates: true,
          });
          // Another runner recorded this moment between the selection and
          // here: its notice stands, this one's feed row rolls back.
          if (claimed.count !== 1) throw new ClaimLost();
          return created;
        },
        { maxWait: 10_000, timeout: 20_000 },
      );
    } catch (error: unknown) {
      if (error instanceof ClaimLost) {
        pass.tally.lost += 1;
        return;
      }
      if (error instanceof EndMoved) {
        // Not recorded: a later pass decides on the end the add-on has then.
        pass.tally.moved += 1;
        return;
      }
      throw error;
    }
    if (notice === null) {
      pass.tally.skipped += 1;
      return;
    }
    pass.tally.sent += 1;
    pass.deliveries.push(this.deliverAndRecord(notice.deliver, row.id, moment, notice.eventId, pass));
  }

  private async templateOn(type: string, pass: Pass): Promise<boolean> {
    if (!pass.templates.has(type)) {
      const template = await this.templatesService.getByType(type);
      pass.templates.set(type, template === null ? null : { isActive: template.isActive });
    }
    return pass.templates.get(type)?.isActive === true;
  }
}

/**
 * The add-ons due for `moment`, soonest end first; one whose moment is decided
 * is never among them, and neither is one that will not be due before it
 * leaves the window — else such rows would come back every pass and could fill
 * it:
 *   • «ends in 3 days»: ACTIVE, ending within three days, not bought inside
 *     them (its checkout has just shown the date), on a subscription that is
 *     ACTIVE or LIMITED — and with an end that stands: not one the next tail
 *     alignment moves (`endMovesWithAlignmentSql`), which is due only once the
 *     drift sweep has caught its term up;
 *   • «has ended»: EXPIRING or EXPIRED — only the boundary sweep ends an add-on
 *     so — within the last three days;
 *   • at neither moment, a reset add-on on a daily or weekly reset
 *     (`quietResetCycleSql`).
 * Only the `(state, expires_at)` index and the event log's unique key are read,
 * and for a row in the window its subscription's terms and its reset epoch.
 */
export async function selectAddOnNoticeCandidates(
  client: Pick<PrismaService, '$queryRaw'>,
  moment: AddOnNoticeMoment,
  now: Date,
  limit: number = ADD_ON_NOTICE_BATCH,
): Promise<string[]> {
  const lead = new Date(now.getTime() + ADD_ON_NOTICE_LEAD_MS);
  const since = new Date(now.getTime() - ADD_ON_NOTICE_LEAD_MS);
  const rows =
    moment === 'endsSoon'
      ? await client.$queryRaw<Array<{ readonly id: string }>>(Prisma.sql`
            SELECT e."id"
            FROM "add_on_entitlements" e
            JOIN "subscriptions" s ON s."id" = e."subscription_id"
            WHERE e."state" = 'ACTIVE'
              AND e."type" IN ('EXTRA_TRAFFIC', 'EXTRA_DEVICES')
              AND e."expires_at" > ${now}
              AND e."expires_at" <= ${lead}
              AND (e."activated_at" IS NULL OR e."activated_at" < e."expires_at" - make_interval(secs => ${ADD_ON_NOTICE_LEAD_MS / 1000}::double precision))
              AND s."status" IN ('ACTIVE', 'LIMITED')
              AND NOT ${endMovesWithAlignmentSql()}
              AND NOT ${quietResetCycleSql()}
              AND NOT EXISTS (
                SELECT 1 FROM "add_on_entitlement_events" c
                WHERE c."entitlement_id" = e."id" AND c."command_key" = ${ADD_ON_NOTICE_COMMAND_KEY.endsSoon}
              )
            ORDER BY e."expires_at" ASC, e."id" ASC
            LIMIT ${limit}
          `)
      : await client.$queryRaw<Array<{ readonly id: string }>>(Prisma.sql`
            SELECT e."id"
            FROM "add_on_entitlements" e
            WHERE e."state" IN ('EXPIRING', 'EXPIRED')
              AND e."type" IN ('EXTRA_TRAFFIC', 'EXTRA_DEVICES')
              AND e."expires_at" <= ${now}
              AND e."expires_at" > ${since}
              AND NOT ${quietResetCycleSql()}
              AND NOT EXISTS (
                SELECT 1 FROM "add_on_entitlement_events" c
                WHERE c."entitlement_id" = e."id" AND c."command_key" = ${ADD_ON_NOTICE_COMMAND_KEY.ended}
              )
            ORDER BY e."expires_at" ASC, e."id" ASC
            LIMIT ${limit}
          `);
  return rows.map((row) => row.id);
}

/** The 1-second window `LAPSED_TERM_WINDOW_MS` as SQL seconds. */
const LAPSED_SECONDS = LAPSED_TERM_WINDOW_MS / 1000;

/**
 * `isQuietResetCycle` for add-on `e`, in SQL: a reset add-on ending at its
 * reset (`entitlementEndBound`: `expires_at` at or past the epoch's reset +
 * the margin) on a cycle shorter than `SHORT_RESET_CYCLE_MS`. The selections
 * leave such a row out — decided nowhere, it would otherwise come back every
 * pass and could fill the batch. The same rule as the function; the
 * PostgreSQL spec holds the two together.
 */
function quietResetCycleSql(): Prisma.Sql {
  return Prisma.sql`(
    e."lifetime" = 'UNTIL_NEXT_RESET'
    AND EXISTS (
      SELECT 1 FROM "subscription_reset_epochs" ep
      WHERE ep."id" = e."expiry_epoch_id"
        AND e."expires_at" >= ep."planned_ends_at" + make_interval(secs => ${RESET_EXPIRY_MARGIN_MS / 1000}::double precision)
        AND ep."planned_ends_at" - ep."starts_at" < make_interval(secs => ${SHORT_RESET_CYCLE_MS / 1000}::double precision)
    )
  )`;
}

/**
 * Whether the next tail alignment moves the end of add-on `e` (on subscription
 * `s`) — its subscription's expiry moved, and the hourly drift sweep has not
 * caught the term up yet. The rule is
 * `SubscriptionTermService.alignTailToExpiryInTransaction`'s, read here without
 * writing, because the notice must not write the model:
 *   - the tail is the last SCHEDULED term, else the ACTIVE one (no ACTIVE term:
 *     not in the model, nothing moves);
 *   - its target end is `expires_at` when that is after the tail's start, one
 *     second after the start for an ACTIVE tail it is not after, open for a
 *     lifetime row — and nothing at all for a SCHEDULED tail it is not after
 *     (an incident, not an alignment);
 *   - a tail already there moves nothing;
 *   - an add-on sold "until the end of the subscription" moves when it ended
 *     with the old tail or would outlive the target — to the target, never to
 *     or before its own activation — unless it is already there.
 * The PostgreSQL spec checks this against the real alignment, so the copy
 * cannot drift from the rule unnoticed.
 */
function endMovesWithAlignmentSql(): Prisma.Sql {
  return Prisma.sql`EXISTS (
    SELECT 1
    FROM (
      SELECT t."starts_at", t."ends_at", t."status"
      FROM "subscription_terms" t
      WHERE t."subscription_id" = e."subscription_id" AND t."status" IN ('ACTIVE', 'SCHEDULED')
      ORDER BY (t."status" = 'SCHEDULED') DESC, t."generation" DESC
      LIMIT 1
    ) tail
    CROSS JOIN LATERAL (
      SELECT CASE
        WHEN s."expires_at" IS NULL THEN NULL
        WHEN s."expires_at" > tail."starts_at" THEN s."expires_at"
        ELSE tail."starts_at" + make_interval(secs => ${LAPSED_SECONDS}::double precision)
      END AS "target"
    ) aligned
    WHERE EXISTS (
        SELECT 1 FROM "subscription_terms" a
        WHERE a."subscription_id" = e."subscription_id" AND a."status" = 'ACTIVE'
      )
      AND NOT (tail."status" = 'SCHEDULED' AND s."expires_at" IS NOT NULL AND s."expires_at" <= tail."starts_at")
      AND aligned."target" IS DISTINCT FROM tail."ends_at"
      AND e."lifetime" = 'UNTIL_SUBSCRIPTION_END'
      AND (
        e."expires_at" IS NOT DISTINCT FROM tail."ends_at"
        OR (aligned."target" IS NOT NULL AND (e."expires_at" IS NULL OR e."expires_at" > aligned."target"))
      )
      AND (
        CASE
          WHEN aligned."target" IS NULL THEN NULL
          ELSE GREATEST(
            aligned."target",
            e."scheduled_activation_at" + make_interval(secs => ${LAPSED_SECONDS}::double precision)
          )
        END
      ) IS DISTINCT FROM e."expires_at"
  )`;
}

/**
 * Right before a notice is written: whether the add-on is still the row it was
 * decided on (`version` — every move and every transition bumps it) and, for
 * «ends in 3 days», its end does not move with the next alignment. Read under
 * a share lock on the add-on, held to the claim's commit, so the end the
 * notice names is the end the add-on has when it is recorded.
 */
async function endStillStands(
  tx: Prisma.TransactionClient,
  entitlementId: string,
  version: number,
  moment: AddOnNoticeMoment,
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ readonly version: number; readonly moves: boolean }>>(Prisma.sql`
    SELECT e."version", ${moment === 'endsSoon' ? endMovesWithAlignmentSql() : Prisma.sql`false`} AS "moves"
    FROM "add_on_entitlements" e
    JOIN "subscriptions" s ON s."id" = e."subscription_id"
    WHERE e."id" = ${entitlementId}
    FOR SHARE OF e
  `);
  const current = rows[0];
  return current !== undefined && current.version === version && !current.moves;
}

/** A decided notice whose channels have no record of running (see the outbox in the class's header). */
export interface UndeliveredAddOnNotice {
  readonly entitlementId: string;
  /** The notice's feed row, as the decision recorded it; `null` on a malformed record. */
  readonly notificationEventId: string | null;
}

/**
 * The outbox's due entries for `moment`: notices decided to be SENT, with no
 * record that their channels ran (`ADD_ON_NOTICE_DELIVERED_KEY`), decided at
 * least `ADD_ON_NOTICE_REDELIVER_AFTER_MS` before `now` — a pass still
 * delivering is not raced — and still worth sending: the add-on is in the
 * moment's window yet. A notice about an end that has passed, or moved out of
 * the three days, is not sent late. Oldest decision first; the same index as
 * the selection, then the event log's unique key.
 */
export async function selectUndeliveredAddOnNotices(
  client: Pick<PrismaService, '$queryRaw'>,
  moment: AddOnNoticeMoment,
  now: Date,
  limit: number = ADD_ON_NOTICE_BATCH,
): Promise<UndeliveredAddOnNotice[]> {
  const lead = new Date(now.getTime() + ADD_ON_NOTICE_LEAD_MS);
  const since = new Date(now.getTime() - ADD_ON_NOTICE_LEAD_MS);
  const decidedBefore = new Date(now.getTime() - ADD_ON_NOTICE_REDELIVER_AFTER_MS);
  const window =
    moment === 'endsSoon'
      ? Prisma.sql`e."state" = 'ACTIVE' AND e."expires_at" > ${now} AND e."expires_at" <= ${lead}`
      : Prisma.sql`e."state" IN ('EXPIRING', 'EXPIRED') AND e."expires_at" <= ${now} AND e."expires_at" > ${since}`;
  return client.$queryRaw<UndeliveredAddOnNotice[]>(Prisma.sql`
    SELECT e."id" AS "entitlementId", c."metadata"->>'notificationEventId' AS "notificationEventId"
    FROM "add_on_entitlements" e
    JOIN "add_on_entitlement_events" c
      ON c."entitlement_id" = e."id" AND c."command_key" = ${ADD_ON_NOTICE_COMMAND_KEY[moment]}
    WHERE ${window}
      AND c."metadata"->>'outcome' = 'sent'
      AND (c."metadata"->>'decidedAt')::timestamptz <= ${decidedBefore}
      AND NOT EXISTS (
        SELECT 1 FROM "add_on_entitlement_events" d
        WHERE d."entitlement_id" = e."id" AND d."command_key" = ${ADD_ON_NOTICE_DELIVERED_KEY[moment]}
      )
    ORDER BY c."metadata"->>'decidedAt' ASC, e."id" ASC
    LIMIT ${limit}
  `);
}

/** The fields of an add-on a notice is decided and written from. */
export interface AddOnNoticeRow {
  readonly id: string;
  readonly subscriptionId: string;
  readonly type: AddOnType;
  readonly state: AddOnEntitlementState;
  readonly receiptName: string;
  readonly totalValue: bigint;
  readonly activatedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly lifetime: AddOnLifetime;
  /** The reset cycle the add-on is bound to; `null` for one bound to none. */
  readonly expiryEpoch: { readonly startsAt: Date; readonly plannedEndsAt: Date } | null;
  readonly subscription: {
    readonly userId: string;
    readonly status: SubscriptionStatus;
    readonly expiresAt: Date | null;
    readonly planSnapshot: unknown;
    readonly trafficLimit: number | null;
    readonly deviceLimit: number;
    readonly remnawavePanelUsername: string | null;
  };
}

/**
 * Whether this moment of the add-on is due now, on the row read again at the
 * moment of deciding — the selection is a batch old by then, and the sweep, an
 * alignment or the operator may have moved the add-on or its subscription
 * since: `send`; `skip` — «has ended» with the subscription ended too, recorded
 * without a notice; `notDue` — nothing recorded, a later pass looks again (or
 * never, once it is out of the window, or for a reset add-on on a daily or
 * weekly reset, which the selections leave out too).
 */
export function decideAddOnNotice(
  row: AddOnNoticeRow,
  moment: AddOnNoticeMoment,
  now: Date,
): 'send' | 'skip' | 'notDue' {
  const endsAt = row.expiresAt;
  if (endsAt === null) return 'notDue';
  if (isQuietResetCycle(row)) return 'notDue';
  const live = row.subscription.status === SubscriptionStatus.ACTIVE || row.subscription.status === SubscriptionStatus.LIMITED;
  if (moment === 'endsSoon') {
    if (row.state !== AddOnEntitlementState.ACTIVE) return 'notDue';
    if (endsAt.getTime() <= now.getTime() || endsAt.getTime() > now.getTime() + ADD_ON_NOTICE_LEAD_MS) return 'notDue';
    if (row.activatedAt !== null && row.activatedAt.getTime() >= endsAt.getTime() - ADD_ON_NOTICE_LEAD_MS) return 'notDue';
    return live ? 'send' : 'notDue';
  }
  if (row.state !== AddOnEntitlementState.EXPIRING && row.state !== AddOnEntitlementState.EXPIRED) return 'notDue';
  if (endsAt.getTime() > now.getTime() || endsAt.getTime() <= now.getTime() - ADD_ON_NOTICE_LEAD_MS) return 'notDue';
  const goesOn = row.subscription.expiresAt === null || row.subscription.expiresAt.getTime() > now.getTime();
  return live && goesOn ? 'send' : 'skip';
}

/**
 * What the notice's words are made from, as raw facts — the renderer turns them
 * into words in the customer's language (`buildAddOnFacts`,
 * `buildSubscriptionFacts`). `subscriptionId` is what «Купить снова», the push
 * and the cabinet's feed open the add-on page on. `addonResetAt` — only for an
 * add-on that ends with the traffic reset — is the reset the texts name.
 */
function noticePayload(row: AddOnNoticeRow): Record<string, unknown> {
  const plan = planNameOf(row.subscription.planSnapshot);
  const resetAt = trafficResetEndOf(row);
  return {
    subscriptionId: row.subscriptionId,
    entitlementId: row.id,
    addon: row.receiptName,
    addonType: row.type,
    // Gigabytes for traffic (the ledger keeps bytes), a count for devices.
    addonTotal:
      row.type === AddOnType.EXTRA_TRAFFIC
        ? Math.round((Number(row.totalValue) / GIB) * 100) / 100
        : Number(row.totalValue),
    addonEndsAt: row.expiresAt?.toISOString() ?? null,
    ...(resetAt === null ? {} : { addonResetAt: resetAt.toISOString() }),
    plan,
    planName: plan,
    expiresAt: row.subscription.expiresAt?.toISOString() ?? null,
    trafficLimitGb: row.subscription.trafficLimit,
    deviceLimit: row.subscription.deviceLimit,
    ...(row.subscription.remnawavePanelUsername === null ? {} : { profile: row.subscription.remnawavePanelUsername }),
  };
}

/** The plan's name from the purchase-time snapshot, or an empty string. */
function planNameOf(planSnapshot: unknown): string {
  if (planSnapshot === null || typeof planSnapshot !== 'object' || Array.isArray(planSnapshot)) return '';
  const name = (planSnapshot as Record<string, unknown>)['name'];
  return typeof name === 'string' ? name : '';
}
