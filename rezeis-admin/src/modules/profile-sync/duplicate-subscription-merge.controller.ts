import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
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
  DuplicateSubscriptionMergeService,
  type DuplicateMergePairInput,
  type DuplicateMergeReport,
} from './duplicate-subscription-merge.service';

/**
 * AdminDuplicateSubscriptionMergeController
 * ─────────────────────────────────────────
 * The ACTION half of the duplicate-pair story, deliberately on its own route
 * rather than as a flag on `POST /admin/profile-sync/panel-link-reconciliation`.
 *
 * WHY A SEPARATE ROUTE. The reconciliation endpoint is the one an operator runs
 * to LOOK — repeatedly, at the whole population, to read the report. A merge
 * flag on that endpoint would put "preview everything" and "move a customer's
 * payments between rows" one mistyped field apart, on the request an operator
 * has already learned to fire without much thought. The two surfaces answer to
 * the same authority and the same permission, but a merge has to be asked for
 * by name.
 *
 * SAME PERMISSION SURFACE as the sweep and as the single-row link repair
 * (`subscriptions:edit`). No new permission is invented: an operator who may
 * rewrite one subscription's panel link is the operator who may resolve the
 * pair that link repair refuses to touch.
 */
@Controller('admin/profile-sync')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
@RequirePermission('subscriptions', 'edit')
export class AdminDuplicateSubscriptionMergeController {
  private readonly logger = new Logger(AdminDuplicateSubscriptionMergeController.name);

  public constructor(
    private readonly mergeService: DuplicateSubscriptionMergeService,
    private readonly prismaService: PrismaService,
  ) {}

  /**
   * Merges the duplicate pairs the 2.x → 3.x identity split produced: the
   * survivor (the OLDER row) takes the live panel identity, everything that
   * referenced the duplicate is reattached to it, and the duplicate is retired
   * with its identity already cleared.
   *
   * DRY BY DEFAULT. The body must carry `dryRun: false` — the boolean, not a
   * string — for anything to be written. An omitted, misspelled or mistyped
   * flag previews, so the worst outcome of a malformed request is a wasted read.
   *
   * BATCH BY DEFAULT TOO. With no `pairs` the service discovers every pair it
   * can see and reports what each one would move; `pairs` narrows it to a named
   * list. Either way every pair is re-verified against the database and the
   * panel immediately before it is written — the ids in the request decide only
   * WHICH pairs are looked at, never what is true about them.
   */
  @Post('duplicate-subscription-merge')
  @HttpCode(HttpStatus.OK)
  public async mergeDuplicateSubscriptions(
    @Body()
    body: {
      dryRun?: unknown;
      pairs?: unknown;
      limit?: unknown;
      chunkSize?: unknown;
      startAfterId?: unknown;
    },
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ): Promise<DuplicateMergeReport> {
    const report = await this.mergeService.merge({
      dryRun: body.dryRun !== false,
      pairs: readPairs(body.pairs),
      limit: typeof body.limit === 'number' ? body.limit : undefined,
      chunkSize: typeof body.chunkSize === 'number' ? body.chunkSize : undefined,
      startAfterId: typeof body.startAfterId === 'string' ? body.startAfterId : null,
    });

    // AUDITED WHENEVER IT WROTE, with no threshold on top.
    //
    // The sweep next door audits only when `linked > 0`, which is right for a
    // repair that may legitimately find nothing to do. It is wrong here. A merge
    // run is an operator moving a paying customer's history between rows, and
    // the run that merged nothing but REFUSED four pairs is the run somebody
    // will need to read later. So the only gate is "this was not a dry run".
    if (!report.dryRun) {
      const rm = extractRequestMetadata(req);
      // `?? null`, not `=== null`. The field is required on the service's own
      // report, but this is the boundary where the value becomes stored JSON,
      // and an absent field must record as "the batch did not stop" rather than
      // throw here — losing the audit row would be a far worse answer to a
      // missing flag than recording `null` for it.
      const stop = report.stoppedEarly ?? null;
      // BUILT HERE, AWAITED BELOW INSIDE A CATCH. A Prisma `create` is lazy —
      // nothing is sent until it is awaited — so this is still one statement,
      // with the failure of the one write that matters most made visible rather
      // than turned into a bare 500 that takes the report with it.
      const auditRow = this.prismaService.adminAuditLog.create({
        data: {
          action: 'subscriptions.duplicate_pair_merged',
          ipAddress: rm.remoteAddress,
          userAgent: rm.userAgent,
          metadata: {
            requestId: rm.requestId,
            pairsExamined: report.pairsExamined,
            merged: report.merged,
            refused: report.refused,
            panelEra: report.panelEra,
            hasMore: report.hasMore,
            nextCursor: report.nextCursor,
            // WHETHER THE BATCH RAN OUT OR BROKE OFF — and if it broke off, on
            // which pair and with what error.
            //
            // A batch is not atomic: every pair is its own transaction, so a run
            // that stopped on pair 3 has COMMITTED pairs 1 and 2. The service
            // converts that failure into a reported stop precisely so this audit
            // row still gets written for them, and recording only the counts
            // would leave it saying "2 merged" with nothing to distinguish it
            // from a run that found two pairs and finished. An operator
            // reconciling by hand has to know that more pairs existed and were
            // never looked at.
            stoppedEarly:
              stop === null
                ? null
                : {
                    survivorSubscriptionId: stop.survivorSubscriptionId,
                    duplicateSubscriptionId: stop.duplicateSubscriptionId,
                    pairsCompleted: stop.pairsCompleted,
                    errorName: stop.errorName,
                    errorCode: stop.errorCode,
                    message: stop.message,
                  },
            // ENOUGH TO UNDO BY HAND, which is the whole reason the row detail
            // is recorded and not just the counts. To reverse one merge an
            // operator needs: both subscription ids, whose they were, the
            // identity that moved and — critically — what each row held BEFORE
            // it moved, because the duplicate's identity columns are now NULL
            // and the audit is the only surviving record of them. The
            // per-relation counts are what tells them how many payments,
            // promocode activations and referral spends to send back.
            pairs: report.rows.map((row) => ({
              survivorSubscriptionId: row.survivorSubscriptionId,
              duplicateSubscriptionId: row.duplicateSubscriptionId,
              userId: row.userId,
              outcome: row.outcome,
              refusal: row.refusal,
              reason: row.reason,
              remnawaveId: row.remnawaveId,
              remnawavePanelId: row.remnawavePanelId,
              survivorPreviousRemnawaveId: row.survivorPreviousRemnawaveId,
              survivorPreviousPanelId: row.survivorPreviousPanelId,
              duplicatePreviousRemnawaveId: row.duplicatePreviousRemnawaveId,
              duplicatePreviousPanelId: row.duplicatePreviousPanelId,
              // WHICH HALF WAS BOUND BEFORE THE WRITE. The four `previous`
              // columns above say what each row STORED; these two say which of
              // those stored values the panel actually answered to. Undoing a
              // merge by hand needs both — restoring the columns is only half
              // the repair if the identity is put back on the row that was
              // never bound to it.
              survivorHoldsLiveIdentity: row.survivorHoldsLiveIdentity,
              duplicateHoldsLiveIdentity: row.duplicateHoldsLiveIdentity,
              supersededSyncJobs: row.supersededSyncJobs,
              reattached: row.reattached.map((moved) => ({
                relation: moved.relation,
                model: moved.model,
                column: moved.column,
                moved: moved.moved,
              })),
            })),
          } as Prisma.InputJsonObject,
          adminUser: { connect: { id: admin.id } },
        },
      });
      try {
        await auditRow;
      } catch (err: unknown) {
        // THE ROW ABOVE IS THE ONLY SURVIVING RECORD, so its failure may not be
        // silent AND may not be lossy.
        //
        // By the time this runs the merges are COMMITTED and every retired
        // duplicate's identity columns are already NULL — the four `previous`
        // fields in the report are the last copy of what they held. If the audit
        // write itself fails there is nowhere left for them to live, so the
        // whole report is put in the application log first, and only then is the
        // error re-thrown. The 500 is the correct answer to "the audit did not
        // happen"; losing the undo data on the way to it is not.
        this.logger.error(
          `Duplicate merge audit row could not be written for admin ${admin.id} (request ` +
            `${rm.requestId ?? 'unknown'}): ${(err as Error).message}. The merges in this run are ` +
            'already committed and the retired rows no longer carry the identities they held, so ' +
            'the report below is the last remaining copy of what moved and where it came from: ' +
            JSON.stringify(report),
        );
        throw err;
      }
    }

    return report;
  }
}

/**
 * Reads the optional explicit pair list.
 *
 * Anything that is not a well-formed pair is DROPPED rather than coerced. A
 * malformed entry that fell through as `{ survivor: undefined }` would be
 * re-verified and refused by the service anyway, but it would also occupy a slot
 * in the operator's batch and appear in the report as a pair that does not
 * exist. Dropping it keeps the report a description of real rows.
 */
function readPairs(raw: unknown): DuplicateMergePairInput[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const pairs: DuplicateMergePairInput[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const survivor = record['survivorSubscriptionId'];
    const duplicate = record['duplicateSubscriptionId'];
    if (typeof survivor !== 'string' || survivor.length === 0) continue;
    if (typeof duplicate !== 'string' || duplicate.length === 0) continue;
    pairs.push({ survivorSubscriptionId: survivor, duplicateSubscriptionId: duplicate });
  }
  return pairs;
}
