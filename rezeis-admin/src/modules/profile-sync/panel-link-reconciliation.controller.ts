import { Body, Controller, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Request } from 'express';

import { PrismaService } from '../../common/prisma/prisma.service';
import { CurrentAdmin } from '../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../auth/interfaces/current-admin.interface';
import { extractRequestMetadata } from '../auth/utils/request-metadata.util';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../rbac/guards/rbac.guard';
import {
  PanelLinkReconciliationService,
  type PanelLinkReconciliationReport,
} from './panel-link-reconciliation.service';

/**
 * AdminPanelLinkReconciliationController
 * ──────────────────────────────────────
 * The bulk counterpart of `PATCH /admin/users/subscriptions/:id/remnawave-link`.
 *
 * WHY AN ENDPOINT RATHER THAN A SCRIPT OR A QUEUE JOB:
 *
 *  • It needs the running application. The panel host and token reach the
 *    transport through Nest's config, and the identity rules live in injected
 *    services. A standalone script would have to boot the same container to
 *    reach any of it, and would then be a second, untested way to perform the
 *    most dangerous write in the system.
 *
 *    This used to name the panel ERA as a third thing the running application
 *    supplies, discovered through `RemnawaveApiService.getPanelShape()`. There
 *    is one era now: the sweep no longer asks, and a panel too old to serve it
 *    is refused centrally by `LegacyPanelRefusal` rather than quietly changing
 *    what this endpoint does.
 *  • The operator already repairs ONE row this way, with this exact permission.
 *    The mass repair performs the same write for many rows, so it answers to
 *    the same authority and appears on the same surface.
 *  • A queue job would move the report into the logs. The report IS the
 *    deliverable here: a dry run whose unrepairable rows an operator reads and
 *    acts on. Handing it back in the response keeps the preview and the
 *    decision in one place.
 *
 * WHY IT IS NOT AUTOMATIC. Every row costs the panel a resolve and a profile
 * read, and the write it performs is the one that hands a customer a profile.
 * There is no cron and no lifecycle hook: it runs when a human asks it to,
 * ideally after reading its own dry run.
 */
@Controller('admin/profile-sync')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
@RequirePermission('subscriptions', 'edit')
export class AdminPanelLinkReconciliationController {
  public constructor(
    private readonly reconciliation: PanelLinkReconciliationService,
    private readonly prismaService: PrismaService,
  ) {}

  /**
   * Repairs subscriptions that cannot name the panel profile they own: the ones
   * whose `remnawave_id` is NULL, and — on a panel PROVEN to be 3.x — the ones
   * still holding a 2.x uuid the panel no longer answers to.
   *
   * DRY BY DEFAULT. The body must carry `dryRun: false` — the boolean, not a
   * string — for anything to be written. An omitted, misspelled or mistyped
   * flag previews instead of writing, so the worst outcome of a malformed
   * request is a wasted read.
   */
  @Post('panel-link-reconciliation')
  @HttpCode(HttpStatus.OK)
  public async reconcilePanelLinks(
    @Body()
    body: {
      dryRun?: unknown;
      limit?: unknown;
      chunkSize?: unknown;
      startAfterId?: unknown;
    },
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ): Promise<PanelLinkReconciliationReport> {
    const report = await this.reconciliation.reconcile({
      dryRun: body.dryRun !== false,
      limit: typeof body.limit === 'number' ? body.limit : undefined,
      chunkSize: typeof body.chunkSize === 'number' ? body.chunkSize : undefined,
      startAfterId: typeof body.startAfterId === 'string' ? body.startAfterId : null,
    });

    // Audited only when it WROTE. A dry run changes nothing and would otherwise
    // fill the audit log with previews, burying the runs that did something.
    if (!report.dryRun && report.linked > 0) {
      const rm = extractRequestMetadata(req);
      await this.prismaService.adminAuditLog.create({
        data: {
          action: 'subscriptions.panel_link_reconciled',
          ipAddress: rm.remoteAddress,
          userAgent: rm.userAgent,
          metadata: {
            requestId: rm.requestId,
            scanned: report.scanned,
            linked: report.linked,
            unrepaired: report.unrepaired.length,
            // WHICH PANEL WAS THIS. The sweep only touches stale identities on
            // a panel it PROVED is 3.x, so a run that repaired none of them is
            // ambiguous without the era: no such rows, or the sweep never
            // looked. `null` means it could not tell and deliberately did not
            // guess.
            panelEra: report.panelEra,
            staleIdentityScanned: report.staleIdentityScanned,
            duplicatePairs: report.duplicatePairs,
            // How many of those pairs came from two live rows STORING one
            // identity rather than from resolving a broken one. Recorded
            // separately because the two carry different instructions: on this
            // kind BOTH halves are bound to the live profile, so an operator
            // reading the entry later must not go looking for the unbound one.
            sharedIdentityPairs: report.sharedIdentityPairs,
            // The rows themselves, not just a count: this write hands a
            // customer a panel profile, and an audit entry that cannot say
            // WHICH profile went to WHICH subscription cannot be used to undo
            // a mistake.
            //
            // `storedRemnawaveId` is half of that undo. For the stale
            // population the repair OVERWRITES an identity, so the audit is the
            // only surviving record of what the row used to hold; without it
            // the entry says where the row landed and not where it came from.
            links: report.repaired.map((row) => ({
              subscriptionId: row.subscriptionId,
              userId: row.userId,
              remnawaveId: row.remnawaveId,
              storedRemnawaveId: row.storedRemnawaveId,
              panelId: row.panelId,
              resolvedBy: row.resolvedBy,
              holdsLiveIdentity: row.holdsLiveIdentity,
            })),
            // DIAGNOSED, NOT WRITTEN — and recorded anyway, because it is the
            // most dangerous fact this run produced. Each pair is two rows of
            // one customer on one panel profile, and exactly one of them holds
            // the LIVE identity: the newer, wrong-looking duplicate. Deleting
            // that half enqueues a panel DELETE against a paying customer's
            // live profile, so which half is which has to outlive the response
            // body an operator read once.
            duplicatePairRows: report.unrepaired
              .filter((row) => row.outcome === 'duplicatePair')
              .map((row) => ({
                subscriptionId: row.subscriptionId,
                userId: row.userId,
                storedRemnawaveId: row.storedRemnawaveId,
                duplicateOfSubscriptionId: row.duplicateOfSubscriptionId,
                holdsLiveIdentity: row.holdsLiveIdentity,
              })),
          } as Prisma.InputJsonObject,
          adminUser: { connect: { id: admin.id } },
        },
      });
    }

    return report;
  }
}
