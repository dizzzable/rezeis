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
  Req,
  UseGuards,
} from '@nestjs/common';
import { Currency, Prisma, SubscriptionStatus, UserRole } from '@prisma/client';
import { Request } from 'express';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { SystemEventsService, EVENT_TYPES } from '../../../common/services/system-events.service';
import { CurrentAdmin } from '../../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { extractRequestMetadata } from '../../auth/utils/request-metadata.util';
import { UserNotificationsService } from '../../notifications/services/user-notifications.service';
import { PartnerEarningsService } from '../../partners/services/partner-earnings.service';
import { ReferralInviteLimitsService } from '../../referrals/services/referral-invite-limits.service';
import { ReferralManualAttachService } from '../../referrals/services/referral-manual-attach.service';
import { RemnawaveApiService } from '../../remnawave/services/remnawave-api.service';
import { UpdatePartnerSettingsDto } from '../dto/update-partner-settings.dto';
import { UpdateUserInviteSettingsDto } from '../dto/update-user-invite-settings.dto';
import { resolveIdentityKind } from '../utils/identity-kind.util';

@Controller('admin/users')
@UseGuards(AdminJwtAuthGuard)
export class AdminUserManagementController {
  private readonly logger = new Logger(AdminUserManagementController.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly events: SystemEventsService,
    private readonly partnerEarningsService: PartnerEarningsService,
    private readonly referralManualAttachService: ReferralManualAttachService,
    private readonly referralInviteLimitsService: ReferralInviteLimitsService,
    private readonly remnawaveApiService: RemnawaveApiService,
    private readonly userNotifications: UserNotificationsService,
  ) {}

  // ── User Profile ────────────────────────────────────────────────────────────

  /** Create a new user manually (admin-initiated). */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  public async createUser(
    @Body() body: { telegramId?: string; username?: string; name?: string; email?: string },
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ) {
    if (body.telegramId) {
      const existing = await this.prismaService.user.findFirst({
        where: { telegramId: BigInt(body.telegramId) },
      });
      if (existing) throw new BadRequestException('User with this Telegram ID already exists');
    }
    const user = await this.prismaService.user.create({
      data: {
        telegramId: body.telegramId ? BigInt(body.telegramId) : null,
        username: body.username || null,
        name: body.name || '',
        email: body.email || null,
      },
    });
    await this.auditLog(admin, req, 'user.created', { userId: user.id, telegramId: body.telegramId ?? null });
    return { ...user, telegramId: user.telegramId?.toString() ?? null };
  }

  /** Get full user detail by telegramId (aggregated view for admin panel). */
  @Get(':telegramId')
  public async getUser(@Param('telegramId') telegramId: string) {
    const user = await this.findUserByTelegramId(telegramId);
    const [subscriptions, transactions, referral, referralsGiven, partner, webAccount] =
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
      ]);

    const partnerReferral = await this.prismaService.partnerReferral.findFirst({
      where: { referralUserId: user.id },
      select: { id: true },
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

    return {
      ...user,
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
    };
  }

  /** Update user profile fields (role, discounts, maxSubscriptions, etc.) */
  @Patch(':telegramId/profile')
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

  /** Add/subtract points */
  @Post(':telegramId/points')
  @HttpCode(HttpStatus.OK)
  public async adjustPoints(
    @Param('telegramId') telegramId: string,
    @Body() body: { delta: number },
  ) {
    const user = await this.findUserByTelegramId(telegramId);
    const newPoints = (user.points ?? 0) + body.delta;
    if (newPoints < 0) {
      throw new BadRequestException(
        `Resulting points would be ${newPoints}. Cannot go below zero.`,
      );
    }
    const updated = await this.prismaService.user.update({
      where: { id: user.id },
      data: { points: { increment: body.delta } },
      select: { points: true },
    });
    return updated;
  }

  // ── Block/Unblock ───────────────────────────────────────────────────────────

  @Post(':telegramId/block')
  @HttpCode(HttpStatus.OK)
  public async blockUser(@Param('telegramId') telegramId: string, @CurrentAdmin() admin: CurrentAdminInterface, @Req() req: Request) {
    const user = await this.findUserByTelegramId(telegramId);
    await this.prismaService.user.update({ where: { id: user.id }, data: { isBlocked: true } });
    await this.auditLog(admin, req, 'user.blocked', { userId: user.id });
    this.events.warn(EVENT_TYPES.USER_BLOCKED, 'USER', `User blocked: ${telegramId}`, { userId: user.id, telegramId, adminId: admin.id });
    return { blocked: true };
  }

  @Post(':telegramId/unblock')
  @HttpCode(HttpStatus.OK)
  public async unblockUser(@Param('telegramId') telegramId: string, @CurrentAdmin() admin: CurrentAdminInterface, @Req() req: Request) {
    const user = await this.findUserByTelegramId(telegramId);
    await this.prismaService.user.update({ where: { id: user.id }, data: { isBlocked: false } });
    await this.auditLog(admin, req, 'user.unblocked', { userId: user.id });
    this.events.info(EVENT_TYPES.USER_UNBLOCKED, 'USER', `User unblocked: ${telegramId}`, { userId: user.id, telegramId, adminId: admin.id });
    return { blocked: false };
  }

  // ── Delete User ─────────────────────────────────────────────────────────────

  @Delete(':telegramId')
  @HttpCode(HttpStatus.OK)
  public async deleteUser(@Param('telegramId') telegramId: string, @CurrentAdmin() admin: CurrentAdminInterface, @Req() req: Request) {
    const user = await this.findUserByTelegramId(telegramId);
    // Best-effort: remove this user's Remnawave panel profiles BEFORE the row
    // deletion. The async `ProfileSyncJob(DELETE)` path can't be used here —
    // the subscription rows it reads are about to be hard-deleted (Cascade) —
    // so we call the panel inline. Failures are logged and never block the
    // delete (the operator action must not hard-fail on a panel hiccup). See
    // `.kiro/specs/trial-aware-profile-cleanup`.
    const profileSubs = await this.prismaService.subscription.findMany({
      where: { userId: user.id, remnawaveId: { not: null } },
      select: { id: true, remnawaveId: true },
    });
    for (const sub of profileSubs) {
      if (sub.remnawaveId === null) continue;
      try {
        await this.remnawaveApiService.deletePanelUser(sub.remnawaveId);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        this.logger.warn(
          `deleteUser: failed to delete panel profile ${sub.remnawaveId} for subscription ${sub.id}: ${message}`,
        );
      }
    }
    // A user delete is a full removal, but three relations are `onDelete:
    // Restrict` (financial / credit history): Transaction, PromocodeActivation
    // and ReferralReward. Left in place they raise a FK violation (P2003) that
    // surfaces as a 400 "Ошибка удаления". Everything else (subscriptions,
    // web account, trial grant, referrals, partner, support tickets, …) is
    // `Cascade`, so removing these three first lets the user delete cleanly.
    await this.prismaService.$transaction(async (tx) => {
      await tx.referralReward.deleteMany({ where: { userId: user.id } });
      await tx.promocodeActivation.deleteMany({ where: { userId: user.id } });
      // Deleting the transactions cascades their TransactionItem rows, which
      // are `Restrict` against subscriptions — clearing them also unblocks the
      // cascade delete of this user's subscriptions.
      await tx.transaction.deleteMany({ where: { userId: user.id } });
      await tx.user.delete({ where: { id: user.id } });
    });
    await this.auditLog(admin, req, 'user.deleted', { userId: user.id, telegramId });
    this.events.warn(EVENT_TYPES.USER_DELETED, 'USER', `User deleted: ${telegramId}`, { userId: user.id, telegramId, adminId: admin.id });
    return { deleted: true };
  }

  // ── Partner Lifecycle ───────────────────────────────────────────────────────

  @Post(':telegramId/create-partner')
  @HttpCode(HttpStatus.OK)
  public async createPartner(@Param('telegramId') telegramId: string, @CurrentAdmin() admin: CurrentAdminInterface, @Req() req: Request) {
    const user = await this.findUserByTelegramId(telegramId);
    const existing = await this.prismaService.partner.findUnique({ where: { userId: user.id } });
    if (existing) throw new BadRequestException('Partner already exists for this user');
    const partner = await this.prismaService.partner.create({
      data: { userId: user.id, isActive: true },
    });
    await this.auditLog(admin, req, 'user.partner.created', { userId: user.id, partnerId: partner.id });
    this.events.info(EVENT_TYPES.PARTNER_CREATED, 'PARTNER', `Partner created for user ${telegramId}`, { userId: user.id, partnerId: partner.id, telegramId });
    return partner;
  }

  @Post(':telegramId/partner/toggle')
  @HttpCode(HttpStatus.OK)
  public async togglePartner(@Param('telegramId') telegramId: string) {
    const user = await this.findUserByTelegramId(telegramId);
    const partner = await this.prismaService.partner.findUnique({ where: { userId: user.id } });
    if (!partner) throw new NotFoundException('Partner not found');
    const updated = await this.prismaService.partner.update({
      where: { id: partner.id },
      data: { isActive: !partner.isActive },
    });
    return updated;
  }

  @Post(':telegramId/partner/adjust-balance')
  @HttpCode(HttpStatus.OK)
  public async adjustPartnerBalance(
    @Param('telegramId') telegramId: string,
    @Body() body: { amount: number; reason?: string },
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ) {
    const user = await this.findUserByTelegramId(telegramId);
    const partner = await this.prismaService.partner.findUnique({ where: { userId: user.id } });
    if (!partner) throw new NotFoundException('Partner not found');
    const newBalance = partner.balance + body.amount;
    if (newBalance < 0) throw new BadRequestException('Resulting balance would be negative');
    const updated = await this.prismaService.partner.update({
      where: { id: partner.id },
      data: { balance: newBalance },
    });
    await this.auditLog(admin, req, 'user.partner.balance.adjusted', {
      partnerId: partner.id, amount: body.amount, reason: body.reason ?? null,
    });
    return updated;
  }

  /** Update partner individual settings (percent per level, reward type, accrual strategy). */
  @Patch(':telegramId/partner/settings')
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

  @Post(':telegramId/referral/attach')
  @HttpCode(HttpStatus.OK)
  public async attachReferrer(
    @Param('telegramId') telegramId: string,
    @Body() body: { referrerTelegramId: string },
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ) {
    const user = await this.findUserByTelegramId(telegramId);
    const referrer = await this.findUserByTelegramId(body.referrerTelegramId);
    const result = await this.referralManualAttachService.attachReferrerManually({
      userId: user.id,
      referrerId: referrer.id,
    });
    await this.auditLog(admin, req, 'user.referral.attached', {
      userId: user.id, referrerId: referrer.id, ...result,
    });
    this.events.info(EVENT_TYPES.REFERRAL_MANUAL_ATTACHED, 'REFERRAL', `Referrer manually attached`, {
      userId: user.id, referrerId: referrer.id, telegramId,
      historicalPaymentsProcessed: result.historicalPaymentsProcessed,
      partnerChainAttached: result.partnerChainAttached,
    });
    return result;
  }

  /**
   * Attach a user as a referral to this user's partner account.
   *
   * The identifier can be: reiwa id (CUID), telegram id (numeric),
   * email, or web login. We resolve it the same way as `findUserByTelegramId`
   * but with extended lookup.
   */
  @Post(':telegramId/partner/attach-referral')
  @HttpCode(HttpStatus.OK)
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
    const result = await this.referralManualAttachService.attachReferrerManually({
      userId: referralUser.id,
      referrerId: partnerUser.id,
    });
    await this.auditLog(admin, req, 'user.partner.referral.attached', {
      partnerId: partnerUser.id,
      referralUserId: referralUser.id,
      identifier: body.referralIdentifier,
      ...result,
    });
    return result;
  }

  @Post(':telegramId/plan-access/:planId')
  @HttpCode(HttpStatus.OK)
  public async grantPlanAccess(
    @Param('telegramId') telegramId: string,
    @Param('planId') planId: string,
  ) {
    const user = await this.findUserByTelegramId(telegramId);
    const plan = await this.prismaService.plan.findUnique({ where: { id: planId } });
    if (!plan) throw new NotFoundException('Plan not found');
    if (plan.allowedUserIds.includes(user.id)) return { granted: true };
    await this.prismaService.plan.update({
      where: { id: planId },
      data: { allowedUserIds: { push: user.id } },
    });
    return { granted: true };
  }

  @Delete(':telegramId/plan-access/:planId')
  @HttpCode(HttpStatus.OK)
  public async revokePlanAccess(
    @Param('telegramId') telegramId: string,
    @Param('planId') planId: string,
  ) {
    const user = await this.findUserByTelegramId(telegramId);
    const plan = await this.prismaService.plan.findUnique({ where: { id: planId } });
    if (!plan) throw new NotFoundException('Plan not found');
    const filtered = plan.allowedUserIds.filter((id) => id !== user.id);
    await this.prismaService.plan.update({
      where: { id: planId },
      data: { allowedUserIds: filtered },
    });
    return { revoked: true };
  }

  // ── Send Notification ───────────────────────────────────────────────────────

  @Post(':telegramId/notify')
  @HttpCode(HttpStatus.OK)
  public async sendNotification(
    @Param('telegramId') telegramId: string,
    @Body() body: { message: string },
  ) {
    // Create a notification event for the user — UserNotificationsService
    // writes the cabinet-feed row and (best-effort) pushes the rendered
    // text to the bot for Telegram delivery in one call.
    const user = await this.findUserByTelegramId(telegramId);
    await this.userNotifications.create({
      userId: user.id,
      type: 'ADMIN_MESSAGE',
      payload: { text: body.message },
      preRenderedText: body.message,
    });
    return { sent: true };
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
   */
  private async enrichSubscriptionsWithRemnawave<T extends { readonly remnawaveId: string | null }>(
    subscriptions: readonly T[],
  ): Promise<Array<T & {
    readonly remnawaveProfileName: string | null;
    readonly remnawaveProfileDescription: string | null;
  }>> {
    const enriched = await Promise.allSettled(
      subscriptions.map(async (sub): Promise<T & { remnawaveProfileName: string | null; remnawaveProfileDescription: string | null }> => {
        if (!sub.remnawaveId) {
          return {
            ...sub,
            remnawaveProfileName: null,
            remnawaveProfileDescription: null,
          };
        }
        const panelUser = await this.remnawaveApiService.getPanelUser(sub.remnawaveId);
        return {
          ...sub,
          remnawaveProfileName: panelUser?.username ?? null,
          remnawaveProfileDescription: panelUser?.description ?? null,
        };
      }),
    );
    return enriched.map((result, index): T & { remnawaveProfileName: string | null; remnawaveProfileDescription: string | null } => {
      if (result.status === 'fulfilled') return result.value;
      const fallback = subscriptions[index];
      return {
        ...fallback,
        remnawaveProfileName: null,
        remnawaveProfileDescription: null,
      };
    });
  }

  private async findUserByTelegramId(telegramId: string) {
    // The param is named "telegramId" for historical reasons but the FE
    // may pass either a numeric Telegram ID or a CUID (internal user id).
    // Try numeric first; fall back to CUID lookup.
    const isNumeric = /^\d+$/.test(telegramId);
    const user = isNumeric
      ? await this.prismaService.user.findFirst({
          where: { telegramId: BigInt(telegramId) },
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

    // 1. Numeric → telegramId
    if (/^\d+$/.test(trimmed)) {
      const user = await this.prismaService.user.findFirst({
        where: { telegramId: BigInt(trimmed) },
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
