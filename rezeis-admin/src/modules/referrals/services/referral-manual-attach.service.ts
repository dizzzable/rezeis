import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ReferralInviteSource, TransactionStatus } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { EVENT_TYPES, SystemEventsService } from '../../../common/services/system-events.service';
import { buildAdminAuditLogData } from '../../../common/utils/admin-audit-log.util';
import { toMinorUnits } from '../../../common/utils/money.util';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { RequestMetadataInterface } from '../../auth/interfaces/request-metadata.interface';
import { PartnerEarningsService } from '../../partners/services/partner-earnings.service';
import { ReferralQualificationService } from './referral-qualification.service';

export interface ManualAttachResult {
  readonly referralCreated: boolean;
  readonly partnerChainAttached: boolean;
  readonly historicalPaymentsProcessed: number;
}

/**
 * ONE audit action for "an operator attached a referrer by hand", whichever
 * screen performed it. The origin lives in `metadata.source`, not in the
 * action name.
 *
 * Four routes reach this service with an operator behind them and they used to
 * disagree three ways: the user card's referral panel wrote
 * `user.referral.attached`, its partner panel wrote
 * `user.partner.referral.attached` (whose `partnerId` key actually held a USER
 * id), and both Referrals-page routes wrote nothing at all — no `@CurrentAdmin`
 * parameter existed on either. Every one of them replays the user's completed
 * payments through the new graph and credits partner earnings, so all four move
 * money, and "who attached this referrer" had three different answers depending
 * on which screen was used.
 *
 * Same reasoning as `partner.balance.adjusted` and `user.subscription.
 * limits_changed`: a reader that has to remember to union a second action name
 * is a reader that will eventually forget.
 *
 *   SELECT metadata->>'userId', metadata->>'referrerId', metadata->>'source',
 *          metadata->>'historicalPaymentsProcessed', created_at
 *   FROM   admin_audit_log
 *   WHERE  action = 'user.referral.attached'
 *   ORDER  BY created_at
 */
const REFERRAL_ATTACHED_ACTION = 'user.referral.attached';

/**
 * Which operator surface performed the attach — see
 * {@link REFERRAL_ATTACHED_ACTION}. The value names the SCREEN, not the HTTP
 * route: `POST /admin/referrals/attach` (what the Referrals page's "Attach
 * referrer" dialog posts) and `POST /admin/referrals/manual-attach` (the same
 * dialog's cuid-addressed variant) are one surface reached with two identifier
 * shapes, and the row records the ids they both resolved to.
 *
 *   'user_detail'          POST /admin/users/:telegramId/referral/attach
 *   'user_detail_partner'  POST /admin/users/:telegramId/partner/attach-referral
 *   'referrals_tab'        POST /admin/referrals/attach
 *                          POST /admin/referrals/manual-attach
 *
 * `user_detail` and `user_detail_partner` are kept apart because they are gated
 * differently — `referrals:edit` and `partners:edit` — so the pair answers "an
 * operator holding only `partners:edit` rewrote the referral graph" without a
 * second query. They are the same ACT: both create one `Referral` edge from
 * referrer to referred and nothing in the resulting rows can tell them apart
 * afterwards; only the panel that addressed it differs.
 */
export type ReferralManualAttachSource =
  | 'user_detail'
  | 'user_detail_partner'
  | 'referrals_tab';

/** The operator behind a manual attach, and the surface they used. */
export interface ReferralManualAttachOperatorInterface {
  readonly currentAdmin: CurrentAdminInterface;
  readonly requestMetadata: RequestMetadataInterface;
  readonly source: ReferralManualAttachSource;
}

/**
 * Manual referral attachment with historical payment replay.
 *
 * Donor: `referral_rewards.attach_referrer_manually`.
 *
 * Use case: admin manually links a user to a referrer after the fact
 * (e.g. the user forgot to use the invite link). The service:
 *   1. Creates the Referral edge.
 *   2. Attaches the partner referral chain (L1/L2/L3).
 *   3. Replays all historical completed payments — qualifying the referral
 *      and crediting partner earnings for each.
 */
@Injectable()
export class ReferralManualAttachService {
  private readonly logger = new Logger(ReferralManualAttachService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly qualificationService: ReferralQualificationService,
    private readonly partnerEarningsService: PartnerEarningsService,
    private readonly events: SystemEventsService,
  ) {}

  /**
   * Manually attaches a referrer to a user and replays historical payments.
   *
   * `inviteSource` is REQUIRED on purpose — no default, no optional. It used to
   * be hardcoded to `UNKNOWN` right here, which is why every organically
   * created edge recorded nothing and `GET /admin/referrals/analytics/
   * source-breakdown` could only ever answer 100 % UNKNOWN. A default would
   * reproduce that exactly: a new call site that forgets the source records
   * nothing and nothing fails. Required means the compiler names every call
   * site that has to decide. Callers that genuinely do not know (an admin
   * attaching after the fact) pass `UNKNOWN` explicitly, which is a decision
   * rather than an omission.
   *
   * `operator` is REQUIRED for exactly the same reason, and nullable for
   * exactly one: this service has SIX call sites and only four of them have an
   * operator. A `?ref=` web sign-up and a `t.me/…?start=ref_` bot deep-link
   * reach it too, and nobody performed those — they pass `null`, which is a
   * decision the compiler made them state. An optional field would have let the
   * next operator route be added recording nothing, which is precisely how two
   * of the four got here.
   *
   * A non-null `operator` writes {@link REFERRAL_ATTACHED_ACTION} and emits
   * `REFERRAL_MANUAL_ATTACHED`. Both live HERE rather than in the controllers
   * so the trail cannot depend on which screen was used, the way
   * `PartnersService.applyBalanceAdjustment` owns `partner.balance.adjusted`.
   *
   * @throws BadRequestException if the user already has a referral or is the same as referrer.
   */
  public async attachReferrerManually(input: {
    readonly userId: string;
    readonly referrerId: string;
    readonly inviteSource: ReferralInviteSource;
    readonly operator: ReferralManualAttachOperatorInterface | null;
  }): Promise<ManualAttachResult> {
    if (input.userId === input.referrerId) {
      throw new BadRequestException('Cannot attach a user as their own referrer');
    }

    // Verify both users exist
    const [user, referrer] = await Promise.all([
      this.prismaService.user.findUnique({ where: { id: input.userId }, select: { id: true } }),
      this.prismaService.user.findUnique({ where: { id: input.referrerId }, select: { id: true } }),
    ]);
    if (!user) throw new NotFoundException('User not found');
    if (!referrer) throw new NotFoundException('Referrer not found');

    // Check no existing referral
    const existingReferral = await this.prismaService.referral.findUnique({
      where: { referredId: input.userId },
      select: { id: true },
    });
    if (existingReferral) {
      throw new BadRequestException('User already has a referral attribution');
    }

    // Check no existing partner attribution
    const existingPartnerRef = await this.prismaService.partnerReferral.findFirst({
      where: { referralUserId: input.userId },
      select: { id: true },
    });
    if (existingPartnerRef) {
      throw new BadRequestException('User already has a partner attribution');
    }

    // 1. Create referral edge
    const referral = await this.prismaService.referral.create({
      data: {
        referrerId: input.referrerId,
        referredId: input.userId,
        level: 1,
        // The caller knows where the edge came from; this service must not
        // guess. See the doc comment on `attachReferrerManually`.
        inviteSource: input.inviteSource,
      },
      select: { id: true },
    });

    // Notify the dev of the new referral edge (covers invite-link sign-ups and
    // admin manual attaches alike — the single creation chokepoint).
    this.events.info(EVENT_TYPES.REFERRAL_ATTACHED, 'REFERRAL', 'Referral attached', {
      referralId: referral.id,
      referrerId: input.referrerId,
      referredUserId: input.userId,
      userId: input.userId,
    });

    // 2. Attach partner referral chain
    const partnerChainAttached = await this.partnerEarningsService.attachPartnerReferralChain({
      newUserId: input.userId,
      referrerUserId: input.referrerId,
    });

    // 3. Replay historical completed payments
    const historicalTransactions = await this.prismaService.transaction.findMany({
      where: {
        userId: input.userId,
        status: TransactionStatus.COMPLETED,
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true, amount: true, gatewayType: true },
    });

    // The replay is the part that MOVES MONEY, and it is the part that can
    // fail halfway. The graph has already changed by the time it starts, so the
    // operator record must not be conditional on it finishing: a throw here
    // used to leave a rewritten referral graph, partner earnings credited for
    // however many transactions got through, and nothing at all naming the
    // operator. The failure is re-thrown unchanged below — the only difference
    // is that the row exists first.
    let historicalPaymentsProcessed = 0;
    let replayFailure: unknown = null;
    try {
      for (const tx of historicalTransactions) {
        // Qualify referral (creates reward for referrer)
        await this.qualificationService.qualifyReferralAfterPurchase(tx.id);

        // Credit partner earnings
        await this.partnerEarningsService.processPartnerEarning({
          payerUserId: input.userId,
          paymentAmountMinorUnits: toMinorUnits(tx.amount), // Decimal → minor units (rounded)
          gatewayType: tx.gatewayType,
          sourceTransactionId: tx.id,
        });

        historicalPaymentsProcessed++;
      }
    } catch (error: unknown) {
      replayFailure = error;
    }

    if (input.operator !== null) {
      await this.recordOperatorAttach(input.operator, {
        userId: input.userId,
        referrerId: input.referrerId,
        referralId: referral.id,
        partnerChainAttached,
        historicalPaymentsProcessed,
        replayFailed: replayFailure !== null,
      });
    }

    if (replayFailure !== null) {
      throw replayFailure;
    }

    this.logger.log(
      `Manual referral attach: ${input.referrerId} → ${input.userId}, ` +
      `partnerChain=${partnerChainAttached}, historicalPayments=${historicalPaymentsProcessed}`,
    );

    return {
      referralCreated: true,
      partnerChainAttached,
      historicalPaymentsProcessed,
    };
  }

  /**
   * The operator record for a manual attach: one audit row under
   * {@link REFERRAL_ATTACHED_ACTION} and one `REFERRAL_MANUAL_ATTACHED` event.
   *
   * The audit row carries `source`; the event deliberately does NOT. It states
   * the same fact whichever screen produced it, exactly as the partner balance
   * and partner activation surfaces already pin their events as identical. The
   * surface-specific extras the user card used to put in its own copy of this
   * event (`telegramId`, and in the audit row a `partnerId` that held a user id
   * and an `identifier` holding whatever the operator pasted) are gone for the
   * same reason: they made two rows describing one act impossible to compare.
   */
  private async recordOperatorAttach(
    operator: ReferralManualAttachOperatorInterface,
    facts: {
      readonly userId: string;
      readonly referrerId: string;
      readonly referralId: string;
      readonly partnerChainAttached: boolean;
      readonly historicalPaymentsProcessed: number;
      readonly replayFailed: boolean;
    },
  ): Promise<void> {
    await this.prismaService.adminAuditLog.create({
      data: buildAdminAuditLogData({
        action: REFERRAL_ATTACHED_ACTION,
        actorId: operator.currentAdmin.id,
        requestMetadata: operator.requestMetadata,
        metadata: {
          requestId: operator.requestMetadata.requestId,
          source: operator.source,
          userId: facts.userId,
          referrerId: facts.referrerId,
          referralId: facts.referralId,
          partnerChainAttached: facts.partnerChainAttached,
          historicalPaymentsProcessed: facts.historicalPaymentsProcessed,
          replayFailed: facts.replayFailed,
        },
      }),
    });

    this.events.info(
      EVENT_TYPES.REFERRAL_MANUAL_ATTACHED,
      'REFERRAL',
      'Referrer manually attached',
      {
        userId: facts.userId,
        referredUserId: facts.userId,
        referrerId: facts.referrerId,
        referralId: facts.referralId,
        partnerChainAttached: facts.partnerChainAttached,
        historicalPaymentsProcessed: facts.historicalPaymentsProcessed,
        replayFailed: facts.replayFailed,
        adminId: operator.currentAdmin.id,
      },
    );
  }
}
