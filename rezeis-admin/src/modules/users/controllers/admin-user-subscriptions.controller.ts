/**
 * AdminUserSubscriptionsController
 * ────────────────────────────────
 * Subscription-related operations carved out of
 * `admin-user-management.controller.ts` so each controller stays focused
 * on a single domain. All routes share the `/admin/users` prefix and
 * `AdminJwtAuthGuard`, so the admin SPA continues to call the same paths
 * without any client-side changes.
 *
 * Covers:
 *   - Per-subscription mutations (status, limits, expiry, squads, delete)
 *   - Traffic reset / panel sync
 *   - Device list / revoke
 *   - "Give subscription" / "Grant trial" flows attached to a user by
 *     Telegram id
 */

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { Prisma, SubscriptionStatus, SyncAction, SyncJobStatus } from '@prisma/client';
import { Request } from 'express';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { CurrentAdmin } from '../../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../../rbac/guards/rbac.guard';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { extractRequestMetadata } from '../../auth/utils/request-metadata.util';
import { ProfileSyncQueueService } from '../../profile-sync/profile-sync-queue.service';
import {
  isNumericPanelIdentity,
  storedIdentityOf,
} from '../../remnawave/services/panel-user-address';
import { RemnawaveApiService } from '../../remnawave/services/remnawave-api.service';
import { requirePanelDeviceList } from '../../remnawave/utils/panel-device-read.util';
import { SubscriptionDeletionService } from '../../subscriptions/services/subscription-deletion.service';
import { SubscriptionMutationsService } from '../../subscriptions/services/subscription-mutations.service';
import { SystemEventsService, EVENT_TYPES } from '../../../common/services/system-events.service';
import { buildPlanSnapshot } from '../utils/plan-snapshot.util';

/** A v1–v8 UUID: the identity a Remnawave 2.7.x/2.8.x panel issues. */
const REMNAWAVE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Longest identity we accept, in characters — the 36 of a UUID. A numeric 3.x
 * id needs 20 at the very most (an unsigned 64-bit id), so one ceiling covers
 * both forms. It is not decoration: `^\d+$` is happy to match a megabyte of
 * digits, and that value goes on to be interpolated into a panel URL.
 */
const MAX_REMNAWAVE_ID_LENGTH = 36;

/**
 * Whether a string can name a panel profile on ANY supported panel version.
 *
 * Two accepted forms, because there are two panel eras. 2.7.x/2.8.x key a user
 * by UUID; 3.x deleted that column outright and re-keyed every user-scoped
 * route on the numeric `id`. `Subscription.remnawaveId` stores whichever form
 * the panel handed us, so a gate that knows only about UUIDs rejects every
 * legitimate identifier an operator can read off a 3.x panel — and this
 * endpoint is the only operator-facing way to repair a broken link, so it used
 * to fail exactly where it was needed most.
 *
 * "Accept anything" is the wrong widening, though. The value is interpolated
 * into a panel URL path segment (`GET /api/users/{segment}`) and used as a
 * Prisma `where` value. Both accepted shapes are fully anchored over
 * `[0-9a-f-]` / `[0-9]`, so `/`, `?`, `#`, `.`, `%` and whitespace — everything
 * that could re-target the panel request — are refused by construction rather
 * than by a blacklist somebody has to keep complete.
 */
function isLinkableRemnawaveId(value: string): boolean {
  if (value.length === 0 || value.length > MAX_REMNAWAVE_ID_LENGTH) return false;
  // `isNumericPanelIdentity` is imported, not re-spelled: it is the same
  // predicate the panel adapter uses to decide whether a stored identity is a
  // 3.x id, and two copies could drift into disagreeing about what counts as
  // numeric — this one accepting a value the adapter then cannot address.
  return REMNAWAVE_UUID_PATTERN.test(value) || isNumericPanelIdentity(value);
}

/**
 * Names both accepted forms on purpose. The operator reading this is holding a
 * panel screen; "a valid UUID is required" told them nothing when the panel in
 * front of them had no UUID to give.
 */
const REMNAWAVE_ID_REQUIRED_MESSAGE =
  'A valid Remnawave profile identifier is required: a UUID (panel 2.x) or a numeric profile id (panel 3.x)';

/**
 * The panel profile's numeric id — the ONE identity both panel eras agree on —
 * as established by a verification read, or `null` when this read cannot
 * establish it.
 *
 * The panel row is the first source: 2.x carries the numeric `id` beside the
 * uuid and 3.x keys everything by it, so a decoded row normally has it. The
 * identifier the operator pasted is the second source, and only when it is
 * already numeric: the panel answered `ok` for a path segment built from that
 * decimal, which only an id-addressed panel does, so the number names the
 * profile even if the body we got back happened to omit the field.
 *
 * `Number.isSafeInteger`, not a null check, on both. `isLinkableRemnawaveId`
 * admits up to 36 digits, and a decimal past 2^53 parses to a ROUNDED number —
 * which would then compare equal to some other row's `remnawavePanelId` and
 * refuse a repair over a collision that exists only in the float.
 */
function panelProfileNumericId(panelId: number | null, pastedIdentity: string): number | null {
  if (Number.isSafeInteger(panelId)) return panelId;
  if (!isNumericPanelIdentity(pastedIdentity)) return null;
  const parsed = Number(pastedIdentity);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

@Controller('admin/users')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
@RequirePermission('subscriptions', 'view')
export class AdminUserSubscriptionsController {
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly remnawaveApiService: RemnawaveApiService,
    private readonly profileSyncQueueService: ProfileSyncQueueService,
    private readonly systemEvents: SystemEventsService,
    private readonly subscriptionDeletionService: SubscriptionDeletionService,
    private readonly subscriptionMutationsService: SubscriptionMutationsService,
  ) {}

  // ── Subscription Mutations ─────────────────────────────────────────────

  @Patch('subscriptions/:subscriptionId')
  @RequirePermission('subscriptions', 'edit')
  public async updateSubscription(
    @Param('subscriptionId') subscriptionId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const sub = await this.prismaService.subscription.findUnique({ where: { id: subscriptionId } });
    if (!sub) throw new NotFoundException('Subscription not found');

    const data: Prisma.SubscriptionUpdateInput = {};
    let assignedPlanId: string | null = null;

    if (body.status !== undefined) {
      if (body.status !== SubscriptionStatus.ACTIVE && body.status !== SubscriptionStatus.DISABLED) {
        throw new BadRequestException('Only ACTIVE or DISABLED can be set by the subscription editor');
      }
      data.status = body.status;
    }

    if (body.planId !== undefined && body.planId !== null) {
      const planId = String(body.planId);
      const plan = await this.prismaService.plan.findUnique({ where: { id: planId } });
      if (!plan) throw new NotFoundException('Plan not found');
      data.planSnapshot = buildPlanSnapshot(plan);
      // Plans dictate the limits/squads at the moment of assignment.
      data.trafficLimit = plan.trafficLimit;
      data.deviceLimit = plan.deviceLimit;
      data.internalSquads = Array.isArray(plan.internalSquads) ? [...plan.internalSquads] : [];
      data.externalSquad = plan.externalSquad ?? null;
      assignedPlanId = plan.id;
    }
    if (body.trafficLimit !== undefined && assignedPlanId === null) {
      data.trafficLimit = Number(body.trafficLimit);
    }
    if (body.deviceLimit !== undefined && assignedPlanId === null) {
      data.deviceLimit = Number(body.deviceLimit);
    }
    if (body.expireDays !== undefined) {
      const days = Number(body.expireDays);
      const base = sub.expiresAt === null
        ? new Date()
        : new Date(Math.max(sub.expiresAt.getTime(), Date.now()));
      const newExpiry = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
      if (newExpiry.getTime() < Date.now()) {
        throw new BadRequestException(
          'Resulting expiry date would be in the past. Use a larger positive value or a smaller negative value.',
        );
      }
      data.expiresAt = newExpiry;
    }
    if (body.expiresAt !== undefined && body.expiresAt !== null) {
      data.expiresAt = new Date(String(body.expiresAt));
    }

    // Anything that changes the underlying profile shape must be propagated
    // to Remnawave. The local mutation and durable job live in one transaction;
    // a queue outage only delays the push because the sweep can recover PENDING.
    const requiresPanelPush =
      assignedPlanId !== null
      || body.trafficLimit !== undefined
      || body.deviceLimit !== undefined
      || body.expireDays !== undefined
      || body.expiresAt !== undefined
      || body.status !== undefined;
    const outcome = await this.prismaService.$transaction(async (tx) => {
      const updated = await tx.subscription.update({
        where: { id: subscriptionId },
        data,
      });
      // A generic editor update must never provision a second panel profile
      // for an imported/legacy row whose link is missing. Creation remains an
      // explicit "give subscription" flow; operators can repair a link before
      // pushing local edits upstream.
      if (!requiresPanelPush || updated.remnawaveId === null) {
        return {
          updated,
          syncJobId: null as string | null,
          remnawaveLinkRequired: requiresPanelPush && updated.remnawaveId === null,
        };
      }

      const syncJob = await tx.profileSyncJob.create({
        data: {
          subscriptionId: updated.id,
          action: SyncAction.UPDATE,
          status: SyncJobStatus.PENDING,
          payload: {
            source: 'ADMIN_MUTATION',
            // Remnawave only receives status when the operator explicitly
            // changed it. Derived EXPIRED/LIMITED states must never be pushed.
            propagateStatus: body.status !== undefined,
          } as Prisma.InputJsonObject,
        },
        select: { id: true },
      });
      return { updated, syncJobId: syncJob.id, remnawaveLinkRequired: false };
    });

    if (outcome.syncJobId !== null) {
      try {
        await this.profileSyncQueueService.enqueue(outcome.syncJobId);
      } catch (error: unknown) {
        // The state and job are already durable. The periodic queue recovery
        // picks this up, so do not turn a successful edit into a false failure.
        this.systemEvents.warn(
          EVENT_TYPES.SYSTEM_REMNAWAVE_SYNC,
          'SYSTEM',
          'Admin subscription update queued for deferred Remnawave sync',
          { subscriptionId, syncJobId: outcome.syncJobId, error: error instanceof Error ? error.message : String(error) },
        );
      }
    }

    return {
      ...outcome.updated,
      syncPending: outcome.syncJobId !== null,
      remnawaveLinkRequired: outcome.remnawaveLinkRequired,
    };
  }

  @Patch('subscriptions/:subscriptionId/squads')
  @RequirePermission('subscriptions', 'edit')
  public async updateSquads(
    @Param('subscriptionId') subscriptionId: string,
    @Body() body: { internalSquads?: string[]; externalSquad?: string | null },
  ) {
    const sub = await this.prismaService.subscription.findUnique({ where: { id: subscriptionId } });
    if (!sub) throw new NotFoundException('Subscription not found');
    const data: Prisma.SubscriptionUpdateInput = {};
    if (body.internalSquads !== undefined) data.internalSquads = body.internalSquads;
    if (body.externalSquad !== undefined) data.externalSquad = body.externalSquad;
    const updated = await this.prismaService.subscription.update({
      where: { id: subscriptionId },
      data,
    });
    await this.enqueueSubscriptionSync(updated.id, updated.remnawaveId);
    return updated;
  }

  /**
   * Explicitly repairs a legacy local-to-panel link. Generic edits never
   * create a profile for an unlinked row: that could duplicate an existing
   * imported user. The identifier — a 2.x UUID or a 3.x numeric id, see
   * {@link isLinkableRemnawaveId} — is verified against the panel before
   * persisting, and the profile that read identifies is then checked against
   * every other subscription, not just the string the operator typed.
   */
  @Patch('subscriptions/:subscriptionId/remnawave-link')
  @RequirePermission('subscriptions', 'edit')
  public async linkRemnawaveProfile(
    @Param('subscriptionId') subscriptionId: string,
    @Body() body: { remnawaveId?: unknown },
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ) {
    const remnawaveId = typeof body.remnawaveId === 'string' ? body.remnawaveId.trim() : '';
    if (!isLinkableRemnawaveId(remnawaveId)) {
      throw new BadRequestException(REMNAWAVE_ID_REQUIRED_MESSAGE);
    }

    const subscription = await this.prismaService.subscription.findUnique({
      where: { id: subscriptionId },
      select: {
        id: true,
        userId: true,
        remnawaveId: true,
        configUrl: true,
        user: { select: { id: true, telegramId: true, email: true } },
      },
    });
    if (subscription === null) throw new NotFoundException('Subscription not found');
    if (subscription.remnawaveId !== null) {
      throw new BadRequestException('Subscription already has a Remnawave profile linked');
    }

    // A bare string on purpose: the operator has just READ this identifier off
    // the panel in front of them, so it already names the profile in that
    // panel's own era. There is no stored row to widen it from — that is the
    // very thing this endpoint is repairing.
    //
    // `getPanelUserOutcome`, not `getPanelUser`: the latter answers `null` for
    // an outage, an expired token, a 5xx and a timeout as well as for a profile
    // that genuinely is not there, and this endpoint reported all of them to
    // the operator as "profile was not found" — i.e. "your identifier is
    // wrong". A panel blip is exactly when someone is repairing a link, so the
    // one moment the endpoint is used was the one moment it lied.
    const panelOutcome = await this.remnawaveApiService.getPanelUserOutcome(remnawaveId);
    if (panelOutcome.kind === 'unavailable') {
      throw new ServiceUnavailableException(
        'The Remnawave panel could not be reached, so this profile identifier could not be verified. ' +
          'Nothing was changed — try again once the panel is answering.',
      );
    }
    if (panelOutcome.kind === 'missing') {
      throw new NotFoundException('Remnawave profile was not found');
    }
    const panelUser = panelOutcome.user;

    // ── Duplicate guard: compare the PROFILE, not the string ────────────────
    //
    // Two subscriptions addressing one panel profile is the failure this check
    // exists to prevent: a later delete on either destroys the other's live
    // profile, and every limit/device write races. `remnawaveId` carries no
    // `@unique` and no index, so this application check is the only thing
    // standing there — and it runs after the read above rather than before it
    // because the question it has to answer ("is this the same PROFILE?")
    // cannot be answered from the pasted string alone.
    //
    // A string comparison is not that check. One profile has two legitimate
    // names across the panel eras — the 2.x uuid a row linked back then still
    // stores, and the numeric id a 3.x panel shows the operator — and the two
    // forms can never compare equal. So subscription A holding profile P as
    // `330f2b38-…` and an operator repairing subscription B with the `5150` off
    // their 3.x screen both address P, and the old `findFirst` saw nothing. The
    // ownership check below does not catch it either: it verifies the USER, and
    // both rows can legitimately belong to the same one.
    //
    // Which comparisons are sound, and why only these three:
    //   • pasted string vs `remnawaveId` — the original check, and the whole
    //     answer whenever both rows were linked in the same panel era.
    //   • numeric id vs `remnawaveId` — a row linked on 3.x stores that number,
    //     in decimal, AS its identity string. The two stored forms cannot be
    //     confused: a uuid always carries `-`, so it never equals a decimal.
    //   • numeric id vs `remnawavePanelId` — the panel's immutable primary key,
    //     which BOTH eras put on every user row, so a row linked on 2.x has
    //     usually been carrying it since long before the upgrade. This is the
    //     comparison that closes the reported hole.
    //
    // NOT the username, though `remnawavePanelUsername` sits right beside those
    // and looks like it would close the last gap. A name is not an identity: an
    // operator can rename a profile in the panel (the same reason
    // `panelUserPatchKey` prefers the immutable key over the name), and a name
    // freed by a rename or a delete can be taken by a DIFFERENT profile later —
    // so a stored name can be stale, or can belong to somebody else entirely.
    // Matching on it would refuse a legitimate repair, and this endpoint is the
    // only way out of a broken link: a false refusal here leaves the operator
    // with no move at all.
    //
    // What stays open, knowingly: a row linked on 2.x that never recorded a
    // numeric id, on a panel since upgraded to 3.x. The panel has no uuid column
    // left to report, so nothing SOUND connects the two rows. That row is
    // equally unnameable to the panel adapter (`panelUserAddress` → `impossible`)
    // — already broken by the same missing fact, not by this guard.
    const profilePanelId = panelProfileNumericId(panelUser.panelId, remnawaveId);
    const namesSameProfile: Prisma.SubscriptionWhereInput[] = [{ remnawaveId }];
    if (profilePanelId !== null) {
      namesSameProfile.push(
        { remnawaveId: String(profilePanelId) },
        { remnawavePanelId: profilePanelId },
      );
    }
    const alreadyLinked = await this.prismaService.subscription.findFirst({
      where: { OR: namesSameProfile, NOT: { id: subscriptionId } },
      select: { id: true },
    });
    if (alreadyLinked !== null) {
      throw new BadRequestException('This Remnawave profile is already linked to another subscription');
    }

    const expectedMarker = `reiwa_id: ${subscription.user.id}`;
    const markerMatches = panelUser.description
      ?.split(/\r?\n/)
      .some((line) => line.trim() === expectedMarker) ?? false;
    const telegramMatches =
      subscription.user.telegramId !== null &&
      panelUser.telegramId !== null &&
      subscription.user.telegramId.toString() === String(panelUser.telegramId);
    const emailMatches =
      subscription.user.email !== null &&
      panelUser.email !== null &&
      subscription.user.email.trim().toLowerCase() === panelUser.email.trim().toLowerCase();
    if (!markerMatches && !telegramMatches && !emailMatches) {
      throw new BadRequestException('Remnawave profile does not belong to this subscription user');
    }

    const linked = await this.prismaService.subscription.update({
      where: { id: subscriptionId },
      data: {
        remnawaveId,
        // The verification read above already handed us the numeric id and the
        // panel's own username, so record them with the link. A repair done on
        // a 2.x panel that stored the uuid ALONE would leave exactly the row
        // that becomes unaddressable the day the operator upgrades to 3.x —
        // which is the situation this endpoint exists to get people out of.
        // `?? undefined` so a panel that omitted a field leaves the stored one
        // alone rather than clearing it.
        remnawavePanelId: panelUser.panelId ?? undefined,
        remnawavePanelUsername: panelUser.username || undefined,
        configUrl: panelUser.subscriptionUrl || subscription.configUrl,
      },
    });
    await this.auditLog(admin, req, 'user.subscription.remnawave_linked', {
      userId: subscription.userId,
      subscriptionId,
      previousRemnawaveId: subscription.remnawaveId,
      remnawaveId,
      ownershipVerifiedBy: markerMatches ? 'reiwa_id' : telegramMatches ? 'telegram_id' : 'email',
      configUrlChanged: (panelUser.subscriptionUrl || subscription.configUrl) !== subscription.configUrl,
    });
    return linked;
  }

  @Delete('subscriptions/:subscriptionId')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('subscriptions', 'delete')
  public async deleteSubscription(
    @Param('subscriptionId') subscriptionId: string,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ) {
    const result = await this.subscriptionDeletionService.deleteByOperator(subscriptionId);

    await this.auditLog(admin, req, 'user.subscription.deleted', {
      userId: result.userId,
      subscriptionId,
      hadRemnawaveProfile: result.hadRemnawaveProfile,
    });

    return { deleted: true };
  }

  // ── Remnawave panel actions ────────────────────────────────────────────

  @Post('subscriptions/:subscriptionId/reset-traffic')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('subscriptions', 'edit')
  public async resetTraffic(@Param('subscriptionId') subscriptionId: string) {
    const sub = await this.prismaService.subscription.findUnique({
      where: { id: subscriptionId },
      // The two supplementary identity columns come along wherever the row is
      // handed to the panel adapter. Without them a profile created on 2.x is
      // unnameable once the panel is upgraded to 3.x, which drops the uuid this
      // row still stores.
      select: { remnawaveId: true, remnawavePanelId: true, remnawavePanelUsername: true },
    });
    const identity = storedIdentityOf(sub);
    if (identity === null) return { reset: false, message: 'No Remnawave profile linked' };
    await this.remnawaveApiService.resetPanelUserTraffic(identity);
    return { reset: true };
  }

  @Post('subscriptions/:subscriptionId/sync')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('subscriptions', 'edit')
  public async syncSubscription(@Param('subscriptionId') subscriptionId: string) {
    const sub = await this.prismaService.subscription.findUnique({
      where: { id: subscriptionId },
      select: {
        remnawaveId: true,
        remnawavePanelId: true,
        remnawavePanelUsername: true,
        userId: true,
      },
    });
    const identity = storedIdentityOf(sub);
    if (identity === null) return { synced: false, message: 'No Remnawave profile linked' };
    // Same distinction the link-repair endpoint makes, and for the same reason:
    // this answer goes straight to an operator. `getPanelUser` reports an
    // outage, an expired token, a 5xx and a timeout with the identical `null`
    // it uses for a genuinely missing profile, so the old message told an
    // operator their profile was gone whenever the panel merely blinked — and
    // "gone" is what makes someone start repairing a link that was never broken.
    const outcome = await this.remnawaveApiService.getPanelUserOutcome(identity);
    if (outcome.kind === 'unavailable') {
      return { synced: false, message: 'Remnawave panel could not be reached — try again' };
    }
    if (outcome.kind === 'missing') {
      return { synced: false, message: 'Profile not found on panel' };
    }
    const panelUser = outcome.user;
    await this.prismaService.subscription.update({
      where: { id: subscriptionId },
      data: {
        expiresAt: new Date(panelUser.expireAt),
        configUrl: panelUser.subscriptionUrl,
      },
    });
    return { synced: true };
  }

  /**
   * Device list for the operator's user panel.
   *
   * `deviceCount: 0` here means "this subscription has no Remnawave profile",
   * a fact we hold locally. A PANEL read that did not answer is NOT allowed to
   * produce the same payload — it used to, and an operator triaging "the
   * customer says they can't add a device" read a confident 0 while the panel
   * was down. `requirePanelDeviceList` turns that into a 5xx, which
   * `DevicesSection` in the admin SPA already renders as its
   * `devicesList.loadError` line instead of `devicesList.empty`.
   */
  @Get('subscriptions/:subscriptionId/devices')
  public async getDevices(@Param('subscriptionId') subscriptionId: string) {
    const sub = await this.prismaService.subscription.findUnique({
      where: { id: subscriptionId },
      select: { remnawaveId: true, remnawavePanelId: true, remnawavePanelUsername: true },
    });
    const identity = storedIdentityOf(sub);
    if (identity === null) return { devices: [], deviceCount: 0 };
    const result = requirePanelDeviceList(
      await this.remnawaveApiService.strictGetPanelUserDevices(identity),
    );
    return { devices: result.devices, deviceCount: result.total };
  }

  @Delete('subscriptions/:subscriptionId/devices/:hwid')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('subscriptions', 'delete')
  public async revokeDevice(
    @Param('subscriptionId') subscriptionId: string,
    @Param('hwid') hwid: string,
    @CurrentAdmin() admin: CurrentAdminInterface,
  ) {
    const sub = await this.prismaService.subscription.findUnique({
      where: { id: subscriptionId },
      select: {
        remnawaveId: true,
        remnawavePanelId: true,
        remnawavePanelUsername: true,
        userId: true,
        user: { select: { telegramId: true, username: true, name: true } },
      },
    });
    const identity = storedIdentityOf(sub);
    if (identity === null) throw new NotFoundException('No Remnawave profile linked');
    const result = await this.remnawaveApiService.deletePanelUserDevice(identity, hwid);

    this.systemEvents.info(
      EVENT_TYPES.SUBSCRIPTION_DEVICE_REVOKED,
      'DEVICE',
      `Device revoked by admin: ${hwid}`,
      {
        userId: sub.userId,
        telegramId: sub.user?.telegramId ? String(sub.user.telegramId) : null,
        userName: sub.user?.name ?? sub.user?.username ?? sub.userId,
        username: sub.user?.username ?? null,
        subscriptionId,
        remnawaveId: sub.remnawaveId,
        hwid,
        remainingDevices: result.total,
        source: 'ADMIN_PANEL',
        adminId: admin.id,
      },
    );

    return { revoked: true, remainingDevices: result.total };
  }

  // ── Give Subscription / Grant Trial ────────────────────────────────────

  @Post(':telegramId/give-subscription')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('subscriptions', 'create')
  public async giveSubscription(
    @Param('telegramId') telegramId: string,
    @Body() body: { planId: string; durationDays: number; isTrial?: boolean },
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ) {
    const user = await this.findUserByTelegramId(telegramId);
    const plan = await this.prismaService.plan.findUnique({ where: { id: body.planId } });
    if (!plan) throw new NotFoundException('Plan not found');

    if (body.isTrial === true) {
      const granted = await this.subscriptionMutationsService.grantTrial({
        userId: user.id,
        planId: plan.id,
        durationDays: body.durationDays,
      });
      const subscription = await this.prismaService.subscription.findUniqueOrThrow({
        where: { id: granted.subscriptionId },
      });
      await this.auditLog(admin, req, 'user.subscription.given', {
        userId: user.id,
        subscriptionId: subscription.id,
        planId: plan.id,
        durationDays: body.durationDays,
        isTrial: true,
      });
      return subscription;
    }

    const startedAt = new Date();
    const expiresAt = new Date(startedAt.getTime() + body.durationDays * 24 * 60 * 60 * 1000);

    const subscription = await this.prismaService.subscription.create({
      data: {
        userId: user.id,
        status: SubscriptionStatus.ACTIVE,
        isTrial: false,
        planSnapshot: buildPlanSnapshot(plan),
        trafficLimit: plan.trafficLimit,
        deviceLimit: plan.deviceLimit,
        internalSquads: plan.internalSquads,
        externalSquad: plan.externalSquad,
        startedAt,
        expiresAt,
      },
    });

    await this.auditLog(admin, req, 'user.subscription.given', {
      userId: user.id,
      subscriptionId: subscription.id,
      planId: plan.id,
      durationDays: body.durationDays,
    });

    // Enqueue sync-job so the worker creates the Remnawave profile.
    await this.enqueueSubscriptionSync(subscription.id, subscription.remnawaveId);

    return subscription;
  }

  @Post(':telegramId/grant-trial')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('subscriptions', 'create')
  public async grantTrial(
    @Param('telegramId') telegramId: string,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ) {
    const user = await this.findUserByTelegramId(telegramId);
    const trialPlan = await this.prismaService.plan.findFirst({
      where: { availability: 'TRIAL', isActive: true, isArchived: false },
      include: { durations: true },
    });
    if (!trialPlan) throw new BadRequestException('No active trial plan configured');
    const duration = trialPlan.durations[0];
    if (!duration) throw new BadRequestException('Trial plan has no duration configured');

    const granted = await this.subscriptionMutationsService.grantTrial({
      userId: user.id,
      planId: trialPlan.id,
      durationDays: duration.days,
    });
    const subscription = await this.prismaService.subscription.findUniqueOrThrow({
      where: { id: granted.subscriptionId },
    });

    await this.auditLog(admin, req, 'user.trial.granted', {
      userId: user.id,
      subscriptionId: subscription.id,
    });

    return subscription;
  }

  // ── Mass sync ──────────────────────────────────────────────────────────

  /**
   * Enqueues a profile-sync for every non-deleted subscription owned by
   * the user. Donor parity: `RemnawaveService.sync_profiles_by_telegram_id`
   * in altshop, except we key the lookup by `User.id` (CUID) — our reiwa
   * id is the stable cross-channel identifier, regardless of whether the
   * user has a `telegramId` at all.
   */
  @Post(':telegramId/sync')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('subscriptions', 'edit')
  public async syncAllUserSubscriptions(
    @Param('telegramId') telegramId: string,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ) {
    const user = await this.findUserByTelegramId(telegramId);
    const subscriptions = await this.prismaService.subscription.findMany({
      where: {
        userId: user.id,
        NOT: { status: SubscriptionStatus.DELETED },
      },
      select: { id: true, remnawaveId: true },
    });
    for (const subscription of subscriptions) {
      await this.enqueueSubscriptionSync(subscription.id, subscription.remnawaveId);
    }
    await this.auditLog(admin, req, 'user.sync.requested', {
      userId: user.id,
      enqueuedCount: subscriptions.length,
    });
    return { enqueued: subscriptions.length };
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  /**
   * Enqueues a profile-sync job for a single subscription.
   *
   * - If the subscription has no `remnawaveId` yet → CREATE.
   * - Otherwise → UPDATE.
   *
   * The actual call into Remnawave happens in the BullMQ worker
   * (`ProfileSyncProcessor`), keeping HTTP latency low and giving us
   * automatic retry/backoff on transient panel errors.
   */
  private async enqueueSubscriptionSync(
    subscriptionId: string,
    remnawaveId: string | null,
  ): Promise<void> {
    const job = await this.prismaService.profileSyncJob.create({
      data: {
        subscriptionId,
        action: remnawaveId === null ? SyncAction.CREATE : SyncAction.UPDATE,
        status: SyncJobStatus.PENDING,
        payload: { source: 'ADMIN_MUTATION' } as Prisma.InputJsonObject,
      },
    });
    await this.profileSyncQueueService.enqueue(job.id);
  }

  private async findUserByTelegramId(telegramId: string) {
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
