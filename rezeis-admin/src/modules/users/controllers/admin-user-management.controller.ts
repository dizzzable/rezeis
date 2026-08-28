/**
 * AdminUserManagementController
 * ─────────────────────────────
 * Full user management endpoints for the admin panel. Covers:
 *   - User profile read/update (role, discounts, points, max subscriptions)
 *   - Block/Unblock
 *   - Delete user
 *   - Partner lifecycle (create, toggle, adjust balance, individual settings)
 *   - Referral management (attach referrer, invite settings)
 *   - Plan access control
 *   - Subscription mutations (assign plan, manage squads, extend, traffic/device limits)
 *   - Send notification
 *   - Grant trial
 *
 * All endpoints require AdminJwtAuthGuard.
 */

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Currency, Prisma, ReferralInviteSource, SubscriptionStatus, SyncJobStatus, UserRole } from '@prisma/client';
import { Request } from 'express';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { SystemEventsService, EVENT_TYPES } from '../../../common/services/system-events.service';
import { parsePostgresBigInt, parseTelegramId } from '../../../common/utils/postgres-bigint.util';
import { CurrentAdmin } from '../../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../../rbac/guards/rbac.guard';
import { RbacService } from '../../rbac/services/rbac.service';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { extractRequestMetadata } from '../../auth/utils/request-metadata.util';
import {
  isNotificationDeliveryChannel,
  NOTIFICATION_DELIVERY_CHANNELS,
  UserNotificationsService,
  type ChannelAvailability,
  type NotificationDeliveryChannel,
  type OperatorMessageResult,
} from '../../notifications/services/user-notifications.service';
import { PartnerEarningsService } from '../../partners/services/partner-earnings.service';
import { PartnersService } from '../../partners/services/partners.service';
import { PlansAdminService } from '../../plans/services/plans-admin.service';
import { ReferralInviteLimitsService } from '../../referrals/services/referral-invite-limits.service';
import { ReferralManualAttachService } from '../../referrals/services/referral-manual-attach.service';
import { ReferralQualificationService } from '../../referrals/services/referral-qualification.service';
import {
  storedIdentityOf,
  type PanelIdentityColumns,
} from '../../remnawave/services/panel-user-address';
import { RemnawaveApiService } from '../../remnawave/services/remnawave-api.service';
import { StealthnetReferralSyncService } from '../../imports/services/stealthnet-referral-sync.service';
import { AdjustUserPartnerBalanceDto } from '../dto/adjust-user-partner-balance.dto';
import { AdjustUserPointsDto } from '../dto/adjust-user-points.dto';
import { UpdatePartnerSettingsDto } from '../dto/update-partner-settings.dto';
import { UpdateUserInviteSettingsDto } from '../dto/update-user-invite-settings.dto';
import { UserBlockService } from '../services/user-block.service';
import { UserDeletionService } from '../services/user-deletion.service';
import { resolveIdentityKind } from '../utils/identity-kind.util';

@Controller('admin/users')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
@RequirePermission('users', 'view')
export class AdminUserManagementController {
  private readonly logger = new Logger(AdminUserManagementController.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly events: SystemEventsService,
    private readonly partnerEarningsService: PartnerEarningsService,
    private readonly referralManualAttachService: ReferralManualAttachService,
    private readonly referralQualificationService: ReferralQualificationService,
    private readonly stealthnetReferralSyncService: StealthnetReferralSyncService,
    private readonly referralInviteLimitsService: ReferralInviteLimitsService,
    private readonly remnawaveApiService: RemnawaveApiService,
    private readonly userNotifications: UserNotificationsService,
    private readonly rbacService: RbacService,
    private readonly userDeletionService: UserDeletionService,
    private readonly partnersService: PartnersService,
    private readonly plansAdminService: PlansAdminService,
    private readonly userBlockService: UserBlockService,
  ) {}

  // ── User Profile ────────────────────────────────────────────────────────────

  /** Create a new user manually (admin-initiated). */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('users', 'create')
  public async createUser(
    @Body() body: { telegramId?: string; username?: string; name?: string; email?: string },
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ) {
    // This body has no DTO, so nothing validates `telegramId` before it reaches
    // here: `BigInt('abc')` threw a raw 500, and a digit string past `int8`
    // parsed fine and then died in Postgres with `22003 numeric field value out
    // of range` — also a 500, and only after the duplicate check had run. Both
    // are operator input errors, so answer them as one. `parsePostgresBigInt`
    // and not `parseTelegramId`: this endpoint accepts (and stores) a negative
    // id today, and tightening that here would be a behaviour change, not a fix.
    let newTelegramId: bigint | null = null;
    if (body.telegramId) {
      newTelegramId = parsePostgresBigInt(body.telegramId);
      if (newTelegramId === null) {
        throw new BadRequestException('telegramId must be a 64-bit integer in decimal notation');
      }
      const existing = await this.prismaService.user.findFirst({
        where: { telegramId: newTelegramId },
      });
      if (existing) throw new BadRequestException('User with this Telegram ID already exists');
    }
    const user = await this.prismaService.user.create({
      data: {
        telegramId: newTelegramId,
        username: body.username || null,
        name: body.name || '',
        email: body.email || null,
      },
    });
    await this.auditLog(admin, req, 'user.created', { userId: user.id, telegramId: body.telegramId ?? null });
    return { ...user, telegramId: user.telegramId?.toString() ?? null };
  }

  /**
   * Paginated, typed user history. Payments remain payment records, while
   * promocode activations and referral point exchanges keep their own domain
   * semantics instead of being forged into zero-value transactions.
   */
  @Get(':telegramId/operations')
  public async listUserOperations(
    @Param('telegramId') telegramId: string,
    @Query('page') pageInput?: string,
    @Query('limit') limitInput?: string,
  ) {
    const user = await this.findUserByTelegramId(telegramId);
    // We merge three independently ordered timelines in memory. Keep the
    // bounded prefix finite so a crafted page value cannot load millions of
    // records from every table.
    const page = normalizePositiveInteger(pageInput, 1, 1, 100);
    const limit = normalizePositiveInteger(limitInput, 25, 1, 100);
    const take = page * limit;

    const [transactions, promocodes, exchanges, transactionCount, promocodeCount, exchangeCount] = await Promise.all([
      this.prismaService.transaction.findMany({
        where: { userId: user.id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take,
        select: {
          id: true,
          paymentId: true,
          status: true,
          purchaseType: true,
          gatewayType: true,
          currency: true,
          amount: true,
          createdAt: true,
        },
      }),
      this.prismaService.promocodeActivation.findMany({
        where: { userId: user.id },
        orderBy: [{ activatedAt: 'desc' }, { id: 'desc' }],
        take,
        select: {
          id: true,
          promocodeCode: true,
          rewardType: true,
          rewardValue: true,
          activatedAt: true,
          targetSubscription: { select: { id: true, planSnapshot: true } },
        },
      }),
      this.prismaService.referralPointsExchange.findMany({
        where: { userId: user.id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take,
        select: {
          id: true,
          type: true,
          pointsSpent: true,
          rewardValue: true,
          expiresAtBefore: true,
          expiresAtAfter: true,
          trafficLimitBefore: true,
          trafficLimitAfter: true,
          personalDiscountBefore: true,
          personalDiscountAfter: true,
          createdAt: true,
          targetSubscription: { select: { id: true, planSnapshot: true } },
          profileSyncJob: { select: { status: true, lastError: true } },
        },
      }),
      this.prismaService.transaction.count({ where: { userId: user.id } }),
      this.prismaService.promocodeActivation.count({ where: { userId: user.id } }),
      this.prismaService.referralPointsExchange.count({ where: { userId: user.id } }),
    ]);

    const items = [
      ...transactions.map((transaction) => ({
        id: transaction.id,
        kind: 'PAYMENT' as const,
        occurredAt: transaction.createdAt,
        payload: {
          paymentId: transaction.paymentId,
          status: transaction.status,
          purchaseType: transaction.purchaseType,
          gatewayType: transaction.gatewayType,
          currency: transaction.currency,
          amount: transaction.amount.toString(),
        },
      })),
      ...promocodes.map((activation) => ({
        id: activation.id,
        kind: 'PROMOCODE_ACTIVATION' as const,
        occurredAt: activation.activatedAt,
        payload: {
          codeMasked: maskPromocode(activation.promocodeCode),
          rewardType: activation.rewardType,
          rewardValue: activation.rewardValue,
          targetSubscription: serializeOperationSubscription(activation.targetSubscription),
        },
      })),
      ...exchanges.map((exchange) => ({
        id: exchange.id,
        kind: 'POINTS_EXCHANGE' as const,
        occurredAt: exchange.createdAt,
        payload: {
          type: exchange.type,
          pointsSpent: exchange.pointsSpent,
          rewardValue: exchange.rewardValue,
          expiresAtBefore: exchange.expiresAtBefore?.toISOString() ?? null,
          expiresAtAfter: exchange.expiresAtAfter?.toISOString() ?? null,
          trafficLimitBefore: exchange.trafficLimitBefore,
          trafficLimitAfter: exchange.trafficLimitAfter,
          personalDiscountBefore: exchange.personalDiscountBefore,
          personalDiscountAfter: exchange.personalDiscountAfter,
          targetSubscription: serializeOperationSubscription(exchange.targetSubscription),
          sync: exchange.profileSyncJob
            ? { status: exchange.profileSyncJob.status, lastError: exchange.profileSyncJob.lastError }
            : null,
        },
      })),
    ]
      .sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime() || right.id.localeCompare(left.id))
      .slice((page - 1) * limit, page * limit)
      .map((item) => ({ ...item, occurredAt: item.occurredAt.toISOString() }));

    return {
      items,
      total: transactionCount + promocodeCount + exchangeCount,
      page,
      limit,
    };
  }

  /** Get full user detail by telegramId (aggregated view for admin panel). */
  @Get(':telegramId')
  public async getUser(
    @Param('telegramId') telegramId: string,
    @CurrentAdmin() admin: CurrentAdminInterface,
  ) {
    const user = await this.findUserByTelegramId(telegramId);
    const [subscriptions, transactions, referral, referralsGiven, partner, webAccount, acquisitionPlacement] =
      await Promise.all([
        this.prismaService.subscription.findMany({
          where: { userId: user.id, NOT: { status: SubscriptionStatus.DELETED } },
          orderBy: { createdAt: 'desc' },
        }),
        this.prismaService.transaction.findMany({
          where: { userId: user.id },
          orderBy: { createdAt: 'desc' },
          take: 50,
        }),
        this.prismaService.referral.findFirst({
          where: { referredId: user.id },
          include: { referrer: { select: { id: true, name: true, username: true, telegramId: true } } },
        }),
        this.prismaService.referral.findMany({
          where: { referrerId: user.id },
          include: { referred: { select: { id: true, name: true, username: true, telegramId: true } } },
          orderBy: { createdAt: 'desc' },
          take: 50,
        }),
        this.prismaService.partner.findUnique({
          where: { userId: user.id },
          include: {
            referrals: {
              orderBy: { createdAt: 'desc' },
              take: 50,
              include: {
                referral: { select: { id: true, name: true, username: true, telegramId: true } },
              },
            },
            transactions: {
              orderBy: { createdAt: 'desc' },
              take: 50,
            },
          },
        }),
        this.prismaService.webAccount.findFirst({ where: { userId: user.id } }),
        user.acquisitionPlacementId
          ? this.prismaService.adPlacement.findUnique({
              where: { id: user.acquisitionPlacementId },
              select: {
                id: true,
                platform: true,
                channel: true,
                trackingCode: true,
                status: true,
                ownerType: true,
                campaign: { select: { id: true, name: true } },
              },
            })
          : Promise.resolve(null),
      ]);

    const partnerReferral = await this.prismaService.partnerReferral.findFirst({
      where: { referralUserId: user.id },
      select: {
        id: true,
        level: true,
        partner: {
          select: {
            id: true,
            user: { select: { id: true, name: true, username: true, telegramId: true } },
          },
        },
      },
    });
    const hasReferralAttribution = referral !== null;
    const hasPartnerAttribution = partnerReferral !== null;
    const attachReferrerReason = hasReferralAttribution
      ? 'REFERRAL_EXISTS'
      : hasPartnerAttribution
        ? 'PARTNER_EXISTS'
        : null;

    const effectiveInviteSettings =
      await this.referralInviteLimitsService.getEffectiveLimitsForUser(user.id);

    const identityKind = resolveIdentityKind({
      telegramId: user.telegramId,
      webAccount: webAccount
        ? {
            login: webAccount.login,
            credentialsBootstrappedAt: webAccount.credentialsBootstrappedAt,
          }
        : null,
    });

    const canViewRegistration = await this.rbacService.hasPermission(
      { id: admin.id, role: admin.role, rbacRoleId: admin.rbacRoleId ?? null },
      'users',
      'view_registration',
    );

    // Drop raw registration columns from the spread; re-attach under RBAC.
    const {
      registrationIp: _rip,
      registrationUserAgent: _rua,
      registrationReferer: _rr,
      registrationUtm: _rutm,
      registrationChannel: _rch,
      acquisitionAt: _acqAt,
      acquisitionPlacementId: _acqId,
      ...userPublic
    } = user;

    const base = {
      ...userPublic,
      telegramId: user.telegramId?.toString() ?? null,
      identityKind,
      subscriptions: await this.enrichSubscriptionsWithRemnawave(subscriptions).then((enriched) =>
        enriched.map((s) => ({
          ...s,
          expireAt: s.expiresAt?.toISOString(),
          plan: s.planSnapshot,
        })),
      ),
      transactions: transactions.map((t) => ({
        ...t,
        amount: t.amount.toString(),
        createdAt: t.createdAt.toISOString(),
      })),
      referral: referral ? {
        ...referral,
        referrer: referral.referrer ? { ...referral.referrer, telegramId: referral.referrer.telegramId?.toString() } : null,
      } : null,
      referralsGiven: referralsGiven.map((r) => ({
        ...r,
        referred: r.referred ? { ...r.referred, telegramId: r.referred.telegramId?.toString() } : null,
      })),
      partner,
      isPartner: partner !== null && partner.isActive,
      hasPartnerAttribution,
      hasReferralAttribution,
      canAttachReferrer: !hasReferralAttribution && !hasPartnerAttribution,
      attachReferrerReason,
      effectiveInviteSettings,
      userInviteSettingsOverride: user.referralInviteSettings,
      webAccount: webAccount
        ? {
            id: webAccount.id,
            login: webAccount.login,
            email: webAccount.email,
            emailVerifiedAt: webAccount.emailVerifiedAt?.toISOString() ?? null,
            requiresPasswordChange: webAccount.requiresPasswordChange,
            temporaryPasswordExpiresAt:
              webAccount.temporaryPasswordExpiresAt?.toISOString() ?? null,
            credentialsBootstrappedAt:
              webAccount.credentialsBootstrappedAt?.toISOString() ?? null,
          }
        : null,
      currentSubscriptionId: user.currentSubscriptionId,
      acquisitionAt: user.acquisitionAt?.toISOString() ?? null,
      acquisitionPlacement: acquisitionPlacement
        ? {
            id: acquisitionPlacement.id,
            platform: acquisitionPlacement.platform,
            channel: acquisitionPlacement.channel,
            trackingCode: acquisitionPlacement.trackingCode,
            status: acquisitionPlacement.status,
            ownerType: acquisitionPlacement.ownerType,
            campaignId: acquisitionPlacement.campaign.id,
            campaignName: acquisitionPlacement.campaign.name,
          }
        : null,
      acquiredByPartner: partnerReferral?.partner
        ? {
            partnerId: partnerReferral.partner.id,
            level: partnerReferral.level,
            name: partnerReferral.partner.user?.name ?? null,
            username: partnerReferral.partner.user?.username ?? null,
            telegramId: partnerReferral.partner.user?.telegramId?.toString() ?? null,
          }
        : null,
      canViewRegistration,
    };

    if (!canViewRegistration) {
      // Strip raw registration PII for roles without users:view_registration.
      return {
        ...base,
        registrationIp: null,
        registrationUserAgent: null,
        registrationReferer: null,
        registrationUtm: null,
        registrationChannel: user.registrationChannel ?? null,
      };
    }

    return {
      ...base,
      registrationIp: user.registrationIp ?? null,
      registrationUserAgent: user.registrationUserAgent ?? null,
      registrationReferer: user.registrationReferer ?? null,
      registrationUtm: user.registrationUtm ?? null,
      registrationChannel: user.registrationChannel ?? null,
    };
  }

  /** Update user profile fields (role, discounts, maxSubscriptions, etc.) */
  @Patch(':telegramId/profile')
  @RequirePermission('users', 'edit')
  public async updateProfile(
    @Param('telegramId') telegramId: string,
    @Body() body: Record<string, unknown>,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ) {
    const user = await this.findUserByTelegramId(telegramId);
    const data: Prisma.UserUpdateInput = {};

    if (body.role !== undefined) data.role = body.role as UserRole;
    if (body.personalDiscount !== undefined) data.personalDiscount = Number(body.personalDiscount);
    if (body.purchaseDiscount !== undefined) data.purchaseDiscount = Number(body.purchaseDiscount);
    if (body.maxSubscriptions !== undefined) data.maxSubscriptions = body.maxSubscriptions === null ? undefined : Number(body.maxSubscriptions);
    if (body.partnerBalanceCurrencyOverride !== undefined) data.partnerBalanceCurrencyOverride = (body.partnerBalanceCurrencyOverride as Currency) || null;

    const updated = await this.prismaService.user.update({ where: { id: user.id }, data });
    await this.auditLog(admin, req, 'user.profile.updated', { userId: user.id, changes: Object.keys(data) });
    return { ...updated, telegramId: updated.telegramId?.toString() ?? null };
  }

  /** Update per-user referral invite limits override. */
  @Patch(':telegramId/invite-settings')
  @RequirePermission('users', 'edit')
  public async updateInviteSettings(
    @Param('telegramId') telegramId: string,
    @Body() body: UpdateUserInviteSettingsDto,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ) {
    const user = await this.findUserByTelegramId(telegramId);
    const settings = buildInviteSettingsValue(body);
    const updated = await this.prismaService.user.update({
      where: { id: user.id },
      data: { referralInviteSettings: settings },
      select: { id: true, referralInviteSettings: true },
    });
    await this.auditLog(admin, req, 'user.invite-settings.updated', {
      userId: user.id,
      override: settings === Prisma.JsonNull ? null : settings,
    });
    return {
      id: updated.id,
      referralInviteSettings: updated.referralInviteSettings,
    };
  }

  /**
   * Add/subtract points — the only operator-facing write to `User.points`.
   *
   * ── THE FLOOR RIDES IN THE `WHERE` OF THE WRITE ─────────────────────────────
   *
   * This used to read the row, compute `(user.points ?? 0) + delta` in JS,
   * refuse a negative result, and then issue an UNCONDITIONAL
   * `{ points: { increment: delta } }`. `points` is a SHARED wallet — the
   * referral points exchange spends it and quests credit it — so between the
   * read and the write a subscriber could spend the balance this check was
   * evaluated against, and the debit then drove the column negative. The guard
   * was real and its subject was a number from the past.
   *
   * `points >= -delta` is "the resulting balance must not be negative"
   * rearranged so the only column in it is the one the database is already
   * locking. Postgres evaluates it against the row it locks, so `count === 0`
   * IS the refusal and no read-then-check window exists. It is the shape
   * `referral-points-exchange.service.ts` (`spendPoints`) and
   * `partners.service.ts` (`applyBalanceAdjustment`) already use for the same
   * invariant; three writers of one wallet disagreeing about how to guard it is
   * how a wallet goes negative.
   *
   * `gte`, not `gt`: a debit landing exactly on zero still matches, the same
   * boundary the replaced `newPoints < 0` had. The floor cannot block a credit —
   * for a positive `delta` the predicate is `points >= -delta`, which every
   * non-negative balance clears. `delta` is validated non-zero by the DTO.
   *
   * ── AND IT LEAVES A TRAIL ───────────────────────────────────────────────────
   *
   * It wrote no audit row and emitted no system event, while its money sibling
   * four routes away is transactional, audited and evented. One action name
   * carrying the amounts before and after, following `partner.balance.adjusted`.
   * `previousPoints` is derived by SUBTRACTING the delta from the value read
   * back after the write — this transaction holds the row lock until it commits,
   * so the row it reads back is this adjustment's own result. Pre-reading would
   * put the stale number back into the audit row after taking it out of the
   * arithmetic.
   *
   * The response body is unchanged: `{ points }`.
   */
  @Post(':telegramId/points')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('users', 'edit')
  public async adjustPoints(
    @Param('telegramId') telegramId: string,
    @Body() body: AdjustUserPointsDto,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ) {
    const user = await this.findUserByTelegramId(telegramId);
    const requestMetadata = extractRequestMetadata(req);
    const result = await this.prismaService.$transaction(async (tx) => {
      const written = await tx.user.updateMany({
        where: { id: user.id, points: { gte: -body.delta } },
        data: { points: { increment: body.delta } },
      });
      if (written.count === 0) {
        // Zero rows is either "no such user" or "the floor refused it", and the
        // count cannot say which. Only this branch pays for telling them apart;
        // the path that succeeds never reads the balance before writing it.
        const existing = await tx.user.findUnique({
          where: { id: user.id },
          select: { id: true },
        });
        if (existing === null) throw new NotFoundException('User not found');
        throw new BadRequestException('Resulting points would be below zero. Cannot go below zero.');
      }
      const updated = await tx.user.findUnique({
        where: { id: user.id },
        select: { points: true },
      });
      if (updated === null) {
        // Unreachable: this transaction holds the lock on the row it has just
        // written. Kept so the type stays honest without a non-null assertion.
        throw new NotFoundException('User not found');
      }
      const newPoints = updated.points;
      const previousPoints = newPoints - body.delta;
      await tx.adminAuditLog.create({
        data: {
          action: 'user.points.adjusted',
          ipAddress: requestMetadata.remoteAddress,
          userAgent: requestMetadata.userAgent,
          metadata: {
            requestId: requestMetadata.requestId,
            userId: user.id,
            adjustment: body.delta,
            previousPoints,
            newPoints,
          } as Prisma.InputJsonObject,
          adminUser: { connect: { id: admin.id } },
        },
      });
      return { previousPoints, newPoints };
    });
    this.events.info(
      EVENT_TYPES.USER_POINTS_ADJUSTED,
      'USER',
      `User points adjusted by ${body.delta}`,
      {
        userId: user.id,
        telegramId,
        adjustment: body.delta,
        previousPoints: result.previousPoints,
        newPoints: result.newPoints,
        adminId: admin.id,
      },
    );
    return { points: result.newPoints };
  }

  // ── Block/Unblock ───────────────────────────────────────────────────────────

  /**
   * These three and their bulk-toolbar counterparts are the same three acts,
   * so they write the same three action names and are told apart by
   * `metadata.source` — `'user_detail'` here, `'bulk'` in
   * `bulk-user-operations.service.ts`, which wrote NO audit row at all until
   * now. "Who deleted this account" is asked about one user, so it has to be
   * one query over one action name whichever screen performed it.
   *
   * `telegramId` in the row is the STORED value, not the path parameter. The
   * parameter is named `telegramId` but `findUserByTelegramId` also accepts a
   * cuid, so `user.deleted` rows could carry a cuid under a key naming a
   * Telegram id — and the bulk rows, which resolve from four identifier kinds,
   * could not have matched a raw token anyway.
   */

  @Post(':telegramId/block')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('users', 'edit')
  public async blockUser(@Param('telegramId') telegramId: string, @CurrentAdmin() admin: CurrentAdminInterface, @Req() req: Request) {
    const user = await this.findUserByTelegramId(telegramId);
    // Everything a block MEANS lives in the service, not here — see its own
    // header for why it had to stop being an inline UPDATE written twice.
    const report = await this.userBlockService.block({ userId: user.id, adminId: admin.id });
    await this.auditLog(admin, req, 'user.blocked', {
      userId: user.id,
      telegramId: user.telegramId?.toString() ?? null,
      source: 'user_detail',
      // The cascade is part of the act, so it belongs in the row that records
      // the act. `devicesUnreadable` above zero is the one field that says the
      // ban is INCOMPLETE, and an audit row is where that has to be readable
      // months later.
      identitiesCaptured: report.identitiesCaptured,
      devicesCaptured: report.devicesCaptured,
      devicesUnreadable: report.devicesUnreadable,
      subscriptionsQueued: report.subscriptionsQueued,
    });
    this.events.warn(EVENT_TYPES.USER_BLOCKED, 'USER', `User blocked: ${telegramId}`, { userId: user.id, telegramId, adminId: admin.id });
    return { blocked: true, cascade: report };
  }

  @Post(':telegramId/unblock')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('users', 'edit')
  public async unblockUser(@Param('telegramId') telegramId: string, @CurrentAdmin() admin: CurrentAdminInterface, @Req() req: Request) {
    const user = await this.findUserByTelegramId(telegramId);
    const report = await this.userBlockService.unblock({ userId: user.id, adminId: admin.id });
    await this.auditLog(admin, req, 'user.unblocked', {
      userId: user.id,
      telegramId: user.telegramId?.toString() ?? null,
      source: 'user_detail',
      entriesReleased: report.entriesReleased,
      subscriptionsQueued: report.subscriptionsQueued,
    });
    this.events.info(EVENT_TYPES.USER_UNBLOCKED, 'USER', `User unblocked: ${telegramId}`, { userId: user.id, telegramId, adminId: admin.id });
    return { blocked: false, cascade: report };
  }

  // ── Delete User ─────────────────────────────────────────────────────────────

  @Delete(':telegramId')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('users', 'delete')
  public async deleteUser(@Param('telegramId') telegramId: string, @CurrentAdmin() admin: CurrentAdminInterface, @Req() req: Request) {
    const user = await this.findUserByTelegramId(telegramId);
    await this.userDeletionService.deleteUser(user.id);
    await this.auditLog(admin, req, 'user.deleted', {
      userId: user.id,
      telegramId: user.telegramId?.toString() ?? null,
      source: 'user_detail',
    });
    this.events.warn(EVENT_TYPES.USER_DELETED, 'USER', 'User account deleted', { userId: user.id, telegramId, adminId: admin.id });
    return { deleted: true };
  }

  // ── Partner Lifecycle ───────────────────────────────────────────────────────

  /**
   * These routes sit under `/admin/users/:telegramId/...` but every one of
   * them writes a `Partner` row - create it, flip `isActive`, move `balance`,
   * rewrite the per-level commission settings, attach a referral into a
   * partner chain. They are gated on `partners:edit`, not on `users:edit`,
   * because the blast radius is the partner ledger rather than the user
   * profile.
   *
   * Three places already agreed on that and this one did not: the SPA hides
   * all five behind `<PermissionGate resource="partners" action="edit">`
   * (`web/src/features/users/user-detail-panel.tsx`), and the duplicate
   * toggle / adjust-balance endpoints on `admin-partners.controller.ts`
   * require `partners:edit`. Only these copies were on `users:edit` - which
   * the shipped `operator` role holds while holding merely `partners:view`,
   * so the button operator cannot see answered anyway and let it move a
   * partner's balance.
   */

  /**
   * Partner lifecycle from this panel goes through `PartnersService`, which is
   * the same code path the Partners tab uses
   * (`POST /admin/partners/:partnerId/toggle`). These two endpoints used to
   * write the `Partner` row inline: no `PARTNER_ACTIVATED` event from either,
   * while the Partners tab emitted one. The same operator act therefore left a
   * different audit trail depending on which screen it was performed from.
   *
   * `partner/adjust-balance` was the last one still inline, and the worst of
   * them: a non-transactional read-then-update writing its own
   * `user.partner.balance.adjusted` with no before/after amounts in it and no
   * system event at all. It now shares `PartnersService.adjustBalanceForUser`
   * with the Partners tab — one transaction, one audit action, the origin in
   * `metadata.source`.
   *
   * The response bodies stay what they always were — the bare `Partner` row,
   * not the mapped `PartnerInterface` — because the SPA is pinned to them.
   */
  @Post(':telegramId/create-partner')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('partners', 'edit')
  public async createPartner(@Param('telegramId') telegramId: string, @CurrentAdmin() admin: CurrentAdminInterface, @Req() req: Request) {
    const user = await this.findUserByTelegramId(telegramId);
    const partner = await this.partnersService.createPartnerForUser({ userId: user.id, telegramId });
    await this.auditLog(admin, req, 'user.partner.created', { userId: user.id, partnerId: partner.id });
    return partner;
  }

  @Post(':telegramId/partner/toggle')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('partners', 'edit')
  public async togglePartner(@Param('telegramId') telegramId: string) {
    const user = await this.findUserByTelegramId(telegramId);
    return this.partnersService.togglePartnerStatusForUser(user.id);
  }

  @Post(':telegramId/partner/adjust-balance')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('partners', 'edit')
  public async adjustPartnerBalance(
    @Param('telegramId') telegramId: string,
    @Body() body: AdjustUserPartnerBalanceDto,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ) {
    const user = await this.findUserByTelegramId(telegramId);
    return this.partnersService.adjustBalanceForUser({
      userId: user.id,
      amount: body.amount,
      reason: body.reason ?? null,
      currentAdmin: admin,
      requestMetadata: extractRequestMetadata(req),
    });
  }

  /** Update partner individual settings (percent per level, reward type, accrual strategy). */
  @Patch(':telegramId/partner/settings')
  @RequirePermission('partners', 'edit')
  public async updatePartnerSettings(
    @Param('telegramId') telegramId: string,
    @Body() body: UpdatePartnerSettingsDto,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ) {
    const user = await this.findUserByTelegramId(telegramId);
    const partner = await this.prismaService.partner.findUnique({ where: { userId: user.id } });
    if (!partner) throw new NotFoundException('Partner not found');

    const data: Prisma.PartnerUpdateInput = {};
    if (body.useGlobalSettings !== undefined) data.useGlobalSettings = body.useGlobalSettings;
    if (body.accrualStrategy !== undefined) data.accrualStrategy = body.accrualStrategy;
    if (body.rewardType !== undefined) data.rewardType = body.rewardType;
    if (body.level1Percent !== undefined) data.level1Percent = body.level1Percent;
    if (body.level2Percent !== undefined) data.level2Percent = body.level2Percent;
    if (body.level3Percent !== undefined) data.level3Percent = body.level3Percent;
    if (body.level1FixedAmount !== undefined) data.level1FixedAmount = body.level1FixedAmount;
    if (body.level2FixedAmount !== undefined) data.level2FixedAmount = body.level2FixedAmount;
    if (body.level3FixedAmount !== undefined) data.level3FixedAmount = body.level3FixedAmount;
    // Per-level accrual mode — the three nullable columns that sit beside the
    // partner-wide `accrualStrategy`. They were absent from this builder, so a
    // PATCH carrying them validated, answered 200 with a `Partner` body, and
    // wrote nothing at all.
    //
    // The guard MUST stay `!== undefined`. `null` is not "no value" on these
    // columns, it is the value that MEANS "inherit `accrualStrategy` above" —
    // so omitting a field leaves the column alone, and sending an explicit
    // `null` clears the override. A truthiness check collapses those two
    // different operator intentions into one and makes the second impossible
    // to express. `resolveAccrualStrategy` in `partner-earnings.service.ts` is
    // the consumer that reads `null` as inherit on every accrual.
    if (body.level1AccrualStrategy !== undefined)
      data.level1AccrualStrategy = body.level1AccrualStrategy;
    if (body.level2AccrualStrategy !== undefined)
      data.level2AccrualStrategy = body.level2AccrualStrategy;
    if (body.level3AccrualStrategy !== undefined)
      data.level3AccrualStrategy = body.level3AccrualStrategy;

    const updated = await this.prismaService.partner.update({
      where: { id: partner.id },
      data,
    });
    await this.auditLog(admin, req, 'user.partner.settings.updated', {
      partnerId: partner.id,
      changes: Object.keys(data),
    });
    return updated;
  }

  // ── Referral Attach ─────────────────────────────────────────────────────────

  /**
   * `referrals:edit`, matching its two siblings below - `referral/sync-stealthnet`
   * and `referral/qualify`. Attaching a referrer rewrites the referral graph and
   * replays historical payments through it, so it needs the same authority they
   * do; it was the only one of the three still on `users:edit`.
   *
   * The audit row and the system event are NOT written here any more. Four
   * routes reach `attachReferrerManually` with an operator behind them and this
   * one was the only one that recorded both; its partner-panel sibling recorded
   * a different action name and no event, and the two Referrals-page routes
   * recorded nothing. The service owns them now, so the trail cannot depend on
   * which screen was used — the same move `partner.balance.adjusted` made.
   */

  @Post(':telegramId/referral/attach')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('referrals', 'edit')
  public async attachReferrer(
    @Param('telegramId') telegramId: string,
    @Body() body: { referrerTelegramId: string },
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ) {
    const user = await this.findUserByTelegramId(telegramId);
    const referrer = await this.findUserByTelegramId(body.referrerTelegramId);
    return this.referralManualAttachService.attachReferrerManually({
      userId: user.id,
      referrerId: referrer.id,
      // Admin attaching after the fact: no invite link was observed, and the
      // enum has no MANUAL member, so UNKNOWN is the honest answer here.
      inviteSource: ReferralInviteSource.UNKNOWN,
      operator: {
        currentAdmin: admin,
        requestMetadata: extractRequestMetadata(req),
        source: 'user_detail',
      },
    });
  }

  /** Retry this user's source referral edge from a completed STEALTHNET import. */
  @Post(':telegramId/referral/sync-stealthnet')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('referrals', 'edit')
  public async syncStealthnetReferrer(
    @Param('telegramId') telegramId: string,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ) {
    const user = await this.findUserByTelegramId(telegramId);
    const result = await this.stealthnetReferralSyncService.syncForUser(user.id);
    await this.auditLog(admin, req, 'user.referral.stealthnet_synced', {
      userId: user.id,
      telegramId,
      ...result,
    });
    if (result.status === 'CREATED') {
      this.events.info(EVENT_TYPES.REFERRAL_MANUAL_ATTACHED, 'REFERRAL', 'Referral restored from STEALTHNET', {
        userId: user.id,
        referredUserId: user.id,
        referrerId: result.referrerUserId,
        telegramId,
        importRecordId: result.importRecordId,
        source: 'stealthnet',
      });
    }
    return result;
  }

  /** Manually qualifies the user's existing referral edge and stages configured rewards. */
  @Post(':telegramId/referral/qualify')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('referrals', 'edit')
  public async qualifyReferral(
    @Param('telegramId') telegramId: string,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ) {
    const user = await this.findUserByTelegramId(telegramId);
    const result = await this.referralQualificationService.qualifyReferralManually({
      referredUserId: user.id,
      actorAdminId: admin.id,
    });
    await this.auditLog(admin, req, 'user.referral.manually_qualified', {
      userId: user.id,
      telegramId,
      ...result,
    });
    return result;
  }

  /**
   * Attach a user as a referral to this user's partner account.
   *
   * The identifier can be: reiwa id (CUID), telegram id (numeric),
   * email, or web login. We resolve it the same way as `findUserByTelegramId`
   * but with extended lookup.
   *
   * SAME ACT as `attachReferrer` above, addressed from the other end: there the
   * path names the referred user, here it names the referrer. One `Referral`
   * edge is created either way and nothing in the resulting rows can tell the
   * two apart afterwards, so they write ONE audit action and are told apart by
   * `metadata.source` — `user_detail_partner` here, which also happens to be
   * the only one of the four gated on `partners:edit`.
   *
   * It used to write its own `user.partner.referral.attached` and no system
   * event, and the `partnerId` in that row held a USER id, not a `Partner.id`.
   * Both go away: the row now names `userId` (referred) and `referrerId` the
   * same way every other surface does.
   */
  @Post(':telegramId/partner/attach-referral')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('partners', 'edit')
  public async attachPartnerReferral(
    @Param('telegramId') telegramId: string,
    @Body() body: { referralIdentifier: string },
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ) {
    const partnerUser = await this.findUserByTelegramId(telegramId);
    const referralUser = await this.resolveUserByIdentifier(body.referralIdentifier);
    if (!referralUser) {
      throw new NotFoundException('Referral user not found by the given identifier');
    }
    if (referralUser.id === partnerUser.id) {
      throw new BadRequestException('Cannot attach user as their own referral');
    }
    // Use the same service — partnerUser is the referrer, referralUser is the referred
    return this.referralManualAttachService.attachReferrerManually({
      userId: referralUser.id,
      referrerId: partnerUser.id,
      // Admin attaching after the fact — see `attachReferrer` above.
      inviteSource: ReferralInviteSource.UNKNOWN,
      operator: {
        currentAdmin: admin,
        requestMetadata: extractRequestMetadata(req),
        source: 'user_detail_partner',
      },
    });
  }

  /**
   * Add this user to a restricted plan's allow-list.
   *
   * `plans:edit`, NOT `users:edit`. The row this writes is `Plan.allowedUserIds`
   * — the same column the plan editor writes under `plans:edit`, and the one
   * that decides who may buy an `ALLOWED` plan. Gated on `users:edit` it was
   * open to the shipped `operator` role, which holds `users:edit` and only
   * `plans:view`: a role DELIBERATELY denied plan editing could hand out (or
   * take away) access to any restricted tariff. Identical reasoning to the five
   * partner routes above, which moved to `partners:edit` for the same reason.
   *
   * The subject of the write is a plan, so the permission follows the plan.
   * That the row is addressed through a user id is a property of the screen,
   * not of the data.
   *
   * The body shape `{ granted: true }` is unchanged; the SPA ignores it and
   * refetches.
   */
  @Post(':telegramId/plan-access/:planId')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('plans', 'edit')
  public async grantPlanAccess(
    @Param('telegramId') telegramId: string,
    @Param('planId') planId: string,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ) {
    const user = await this.findUserByTelegramId(telegramId);
    await this.plansAdminService.setUserPlanAccess({
      planId,
      userId: user.id,
      granted: true,
      context: { currentAdmin: admin, requestMetadata: extractRequestMetadata(req) },
    });
    return { granted: true };
  }

  /**
   * Remove this user from a restricted plan's allow-list. See
   * {@link grantPlanAccess} for why this is `plans:edit`.
   *
   * This used to read the array, filter it in this process and write the whole
   * thing back — a lost update that silently discarded any grant, from either
   * screen, that landed in between. `PlansAdminService.setUserPlanAccess` sends
   * the removal of one element instead, and the audit row it writes is the
   * first trace this route has ever left.
   */
  @Delete(':telegramId/plan-access/:planId')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('plans', 'edit')
  public async revokePlanAccess(
    @Param('telegramId') telegramId: string,
    @Param('planId') planId: string,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ) {
    const user = await this.findUserByTelegramId(telegramId);
    await this.plansAdminService.setUserPlanAccess({
      planId,
      userId: user.id,
      granted: false,
      context: { currentAdmin: admin, requestMetadata: extractRequestMetadata(req) },
    });
    return { revoked: true };
  }

  // ── Send Notification ───────────────────────────────────────────────────────

  /**
   * Which channels this particular user can be reached on. Drives the send
   * dialog so the operator is never offered a channel that cannot work —
   * `telegram` needs a linked, positive `telegramId` and an unblocked bot,
   * `webpush` needs deployment VAPID keys AND a browser this user registered.
   */
  @Get(':telegramId/notify/channels')
  @RequirePermission('users', 'edit')
  public async getNotifyChannels(
    @Param('telegramId') telegramId: string,
  ): Promise<{ channels: readonly ChannelAvailability[] }> {
    const user = await this.findUserByTelegramId(telegramId);
    return { channels: await this.userNotifications.getChannelAvailability(user.id) };
  }

  @Post(':telegramId/notify')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('users', 'edit')
  public async sendNotification(
    @Param('telegramId') telegramId: string,
    @Body() body: { message: string; channels?: unknown },
  ): Promise<OperatorMessageResult & { sent: boolean }> {
    const user = await this.findUserByTelegramId(telegramId);
    // The cabinet-feed row is written unconditionally — it is the durable
    // record. `channels` selects only the DELIVERY surfaces, and the send is
    // awaited so the response can say what each one actually did. Omitting the
    // field keeps the pre-channel-selector behaviour (try every channel),
    // which is what an older SPA build still posts.
    const result = await this.userNotifications.sendOperatorMessage({
      userId: user.id,
      text: body.message,
      channels: parseRequestedChannels(body.channels),
    });
    // `sent` is no longer a constant: it is false when the operator asked for
    // delivery and none of it got through. A 2xx with `sent: false` is the
    // honest answer to "the row is stored but nobody was told", and it is what
    // the SPA now renders instead of a green toast.
    const attempted = result.outcomes.filter((o) => o.status !== 'notSelected');
    return {
      ...result,
      sent: attempted.length === 0 || attempted.some((o) => o.status === 'delivered'),
    };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /**
   * Augments a list of local subscription rows with the matching Remnawave
   * panel-user `username` and `description` so the admin "User → Subscription"
   * card can display the live profile name instead of the bare UUID.
   *
   * - Skips subscriptions that have no `remnawaveId` yet (e.g. provisioning).
   * - Tolerates upstream errors per-row: a single missing/404 panel user
   *   never breaks the whole user-detail response.
   * - Done in parallel via `Promise.allSettled` to keep the user-detail
   *   endpoint snappy even when the panel is slow.
   *
   * THE FULL IDENTITY IS PASSED, not the bare `remnawaveId` string, and on a
   * 3.x panel that is the difference between a name and a blank. A profile
   * created on 2.x still stores its uuid here after the operator upgrades —
   * the panel's own migration drops the column, we do not — and a uuid in a
   * 3.x id slot earns `400 expected number, received NaN`, which this method
   * swallows into `null`. `storedIdentityOf` hands the adapter the numeric id
   * and the panel username as well, which is what every other caller already
   * does; the columns it reads are already in the row (the `findMany` behind
   * this list runs without a `select`).
   */
  private async enrichSubscriptionsWithRemnawave<T extends PanelIdentityColumns & { id: string }>(
    subscriptions: readonly T[],
  ): Promise<Array<T & {
    readonly remnawaveProfileName: string | null;
    readonly remnawaveProfileDescription: string | null;
    readonly remnawaveSyncState: 'UNLINKED' | 'PENDING' | 'SYNCED' | 'MISSING' | 'UNAVAILABLE' | 'FAILED';
    readonly remnawaveSyncJob: {
      readonly status: string;
      readonly action: string;
      readonly attempts: number;
      readonly lastError: string | null;
      readonly updatedAt: string;
    } | null;
  }>> {
    const profileSyncJobDelegate = this.prismaService.profileSyncJob;
    // No subscriptions means no `subscriptionId` to ask about, and `in: []` is
    // a round trip that can only answer nothing. This runs on every user-card
    // open, which an operator hits constantly, so the empty case is skipped
    // rather than sent.
    const latestJobs = profileSyncJobDelegate === undefined || subscriptions.length === 0
      ? []
      : await profileSyncJobDelegate.findMany({
          where: { subscriptionId: { in: subscriptions.map((sub) => sub.id) }, supersededAt: null },
          orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
          select: { subscriptionId: true, status: true, action: true, attempts: true, lastError: true, updatedAt: true },
        });
    const jobBySubscription = new Map<string, (typeof latestJobs)[number]>();
    for (const job of latestJobs) {
      if (!jobBySubscription.has(job.subscriptionId)) jobBySubscription.set(job.subscriptionId, job);
    }

    const enriched = await Promise.allSettled(
      subscriptions.map(async (sub): Promise<T & {
        remnawaveProfileName: string | null;
        remnawaveProfileDescription: string | null;
        remnawaveSyncState: 'UNLINKED' | 'PENDING' | 'SYNCED' | 'MISSING' | 'UNAVAILABLE' | 'FAILED';
        remnawaveSyncJob: {
          status: string;
          action: string;
          attempts: number;
          lastError: string | null;
          updatedAt: string;
        } | null;
      }> => {
        const job = jobBySubscription.get(sub.id) ?? null;
        const syncJob = job === null ? null : {
          status: job.status,
          action: job.action,
          attempts: job.attempts,
          lastError: job.lastError,
          updatedAt: job.updatedAt.toISOString(),
        };
        const identity = storedIdentityOf(sub);
        if (identity === null) {
          return {
            ...sub,
            remnawaveProfileName: null,
            remnawaveProfileDescription: null,
            remnawaveSyncState: job?.status === SyncJobStatus.PENDING || job?.status === SyncJobStatus.RUNNING
              ? 'PENDING'
              : job?.status === SyncJobStatus.FAILED ? 'FAILED' : 'UNLINKED',
            remnawaveSyncJob: syncJob,
          };
        }
        const outcome = await this.remnawaveApiService.getPanelUserOutcome(identity);
        const panelUser = outcome.kind === 'ok' ? outcome.user : null;
        return {
          ...sub,
          remnawaveProfileName: panelUser?.username ?? null,
          remnawaveProfileDescription: panelUser?.description ?? null,
          remnawaveSyncState: outcome.kind === 'ok'
            ? job?.status === SyncJobStatus.PENDING || job?.status === SyncJobStatus.RUNNING
              ? 'PENDING'
              : job?.status === SyncJobStatus.FAILED ? 'FAILED' : 'SYNCED'
            : outcome.kind === 'missing' ? 'MISSING' : 'UNAVAILABLE',
          remnawaveSyncJob: syncJob,
        };
      }),
    );
    return enriched.map((result, index): T & {
      remnawaveProfileName: string | null;
      remnawaveProfileDescription: string | null;
      remnawaveSyncState: 'UNLINKED' | 'PENDING' | 'SYNCED' | 'MISSING' | 'UNAVAILABLE' | 'FAILED';
      remnawaveSyncJob: {
        status: string;
        action: string;
        attempts: number;
        lastError: string | null;
        updatedAt: string;
      } | null;
    } => {
      if (result.status === 'fulfilled') return result.value;
      const fallback = subscriptions[index];
      const job = jobBySubscription.get(fallback.id) ?? null;
      return {
        ...fallback,
        remnawaveProfileName: null,
        remnawaveProfileDescription: null,
        remnawaveSyncState: storedIdentityOf(fallback) === null ? 'UNLINKED' : 'UNAVAILABLE',
        remnawaveSyncJob: job === null ? null : {
          status: job.status,
          action: job.action,
          attempts: job.attempts,
          lastError: job.lastError,
          updatedAt: job.updatedAt.toISOString(),
        },
      };
    });
  }

  private async findUserByTelegramId(telegramId: string) {
    // The param is named "telegramId" for historical reasons but the FE
    // may pass either a numeric Telegram ID or a CUID (internal user id).
    // Try numeric first; fall back to CUID lookup.
    const isNumeric = /^\d+$/.test(telegramId);
    const numericId = isNumeric ? parseTelegramId(telegramId) : null;
    // Digits that overflow `int8` have no second branch to fall through to:
    // no row can hold that value, and an all-digit string is not a CUID either.
    // Binding it anyway reached Postgres and came back as `22003 numeric field
    // value out of range` — a 500 where 404 is the truthful answer.
    if (isNumeric && numericId === null) throw new NotFoundException('User not found');
    const user = numericId !== null
      ? await this.prismaService.user.findFirst({
          where: { telegramId: numericId },
        })
      : await this.prismaService.user.findUnique({
          where: { id: telegramId },
        });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  /**
   * Resolves a user by any identifier: reiwa id (CUID), telegram id (numeric),
   * email, or web login. Returns null if not found.
   */
  private async resolveUserByIdentifier(identifier: string) {
    const trimmed = identifier.trim();
    if (!trimmed) return null;

    // 1. Numeric → telegramId. A digit string `int8` cannot hold skips straight
    // to the next branch: no row can match it, so this is exactly what the
    // lookup would have done had it run and returned null — except it used to
    // fail the request with `22003 numeric field value out of range` instead.
    const numericId = parseTelegramId(trimmed);
    if (numericId !== null) {
      const user = await this.prismaService.user.findFirst({
        where: { telegramId: numericId },
      });
      if (user) return user;
    }

    // 2. CUID-like → id
    if (/^c[a-z0-9]{20,}$/i.test(trimmed)) {
      const user = await this.prismaService.user.findUnique({
        where: { id: trimmed },
      });
      if (user) return user;
    }

    // 3. Email
    if (trimmed.includes('@') && trimmed.includes('.')) {
      const user = await this.prismaService.user.findFirst({
        where: { email: { equals: trimmed, mode: 'insensitive' } },
      });
      if (user) return user;
    }

    // 4. Web login
    const webAccount = await this.prismaService.webAccount.findFirst({
      where: { loginNormalized: trimmed.toLowerCase() },
      select: { userId: true },
    });
    if (webAccount) {
      return this.prismaService.user.findUnique({ where: { id: webAccount.userId } });
    }

    // 5. Username
    const byUsername = await this.prismaService.user.findFirst({
      where: { username: { equals: trimmed, mode: 'insensitive' } },
    });
    return byUsername;
  }

  private async auditLog(
    admin: CurrentAdminInterface,
    req: Request,
    action: string,
    metadata: Record<string, unknown>,
  ) {
    const rm = extractRequestMetadata(req);
    await this.prismaService.adminAuditLog.create({
      data: {
        action,
        ipAddress: rm.remoteAddress,
        userAgent: rm.userAgent,
        metadata: { requestId: rm.requestId, ...metadata } as Prisma.InputJsonObject,
        adminUser: { connect: { id: admin.id } },
      },
    });
  }
}

/**
 * Translates the incoming DTO into a value suitable for
 * `Prisma.UserUpdateInput.referralInviteSettings`.
 *
 * - If the operator selects "use global" AND no `bypassInviteGate` is
 *   set, we wipe the column to NULL via `Prisma.JsonNull`. This keeps
 *   query semantics identical to a freshly-created user.
 * - Otherwise we collapse the body into a small JSON object and only
 *   keep the fields that were explicitly provided. Implicit fields
 *   continue to fall back to the global config at read time.
 * - `bypassInviteGate` is independent of `useGlobalSettings` — when set,
 *   it is always persisted, even alongside `useGlobalSettings: true`,
 *   so a VIP user can keep using the global referral limits while still
 *   bypassing the platform-wide `INVITED` gate.
 */
function buildInviteSettingsValue(
  body: UpdateUserInviteSettingsDto,
): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  const out: Record<string, unknown> = {};
  if (body.useGlobalSettings === true) {
    if (body.bypassInviteGate === true) {
      return { bypassInviteGate: true };
    }
    return Prisma.JsonNull;
  }
  if (body.useGlobalSettings === false) {
    out.useGlobalSettings = false;
  }
  if (body.linkTtlEnabled !== undefined) out.linkTtlEnabled = body.linkTtlEnabled;
  if (body.linkTtlSeconds !== undefined) out.linkTtlSeconds = body.linkTtlSeconds;
  if (body.slotsEnabled !== undefined) out.slotsEnabled = body.slotsEnabled;
  if (body.initialSlots !== undefined) out.initialSlots = body.initialSlots;
  if (body.refillThresholdQualified !== undefined) {
    out.refillThresholdQualified = body.refillThresholdQualified;
  }
  if (body.refillAmount !== undefined) out.refillAmount = body.refillAmount;
  if (body.bypassInviteGate !== undefined) out.bypassInviteGate = body.bypassInviteGate;

  if (Object.keys(out).length === 0) {
    return Prisma.JsonNull;
  }
  return out as Prisma.InputJsonValue;
}

function normalizePositiveInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function maskPromocode(code: string): string {
  if (code.length <= 4) return '••••';
  return `${code.slice(0, 2)}••••${code.slice(-2)}`;
}

function serializeOperationSubscription(
  subscription: { readonly id: string; readonly planSnapshot: unknown } | null,
): { id: string; label: string | null } | null {
  if (subscription === null) return null;
  const snapshot = subscription.planSnapshot;
  const label =
    snapshot !== null && typeof snapshot === 'object' && !Array.isArray(snapshot)
      ? readOperationPlanLabel(snapshot as Record<string, unknown>)
      : null;
  return { id: subscription.id, label };
}

function readOperationPlanLabel(snapshot: Record<string, unknown>): string | null {
  const direct = snapshot.name;
  if (typeof direct === 'string' && direct.trim().length > 0) return direct.trim();
  const nested = snapshot.originalPlanSnapshot;
  if (nested !== null && typeof nested === 'object' && !Array.isArray(nested)) {
    const name = (nested as Record<string, unknown>).name;
    if (typeof name === 'string' && name.trim().length > 0) return name.trim();
  }
  return null;
}

/**
 * Normalise the operator's channel selection off the wire.
 *
 * Absent field ⇒ every channel, which is what the pre-selector SPA build
 * posts; an explicit empty array ⇒ nothing, which is the operator deliberately
 * choosing "record it, tell nobody". Those two must not collapse into each
 * other, so `undefined` is checked before the array is read.
 */
function parseRequestedChannels(raw: unknown): readonly NotificationDeliveryChannel[] {
  if (raw === undefined || raw === null) return NOTIFICATION_DELIVERY_CHANNELS;
  if (!Array.isArray(raw)) return NOTIFICATION_DELIVERY_CHANNELS;
  return raw.filter(isNotificationDeliveryChannel);
}
