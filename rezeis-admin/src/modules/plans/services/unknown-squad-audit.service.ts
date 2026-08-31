import { Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import { Prisma, SubscriptionStatus } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { PanelInfraClient } from '../../remnawave/services/panel-infra.client';

/** One subscription still pointing at a squad the panel does not serve. */
export interface UnknownSquadRow {
  readonly subscriptionId: string;
  readonly userId: string;
  readonly status: SubscriptionStatus;
  readonly planName: string | null;
  /** The squad uuids on this subscription the panel does not know. */
  readonly unknownSquads: readonly string[];
  /** True when the miss is the external squad rather than an internal one. */
  readonly externalSquadMissing: boolean;
}

export interface UnknownSquadReport {
  readonly scanned: number;
  readonly affected: number;
  readonly truncated: boolean;
  readonly rows: readonly UnknownSquadRow[];
  /** Plans whose OWN squad list names something the panel does not know. */
  readonly affectedPlans: ReadonlyArray<{ readonly id: string; readonly name: string }>;
}

/** Never scan the whole table for a screen; an operator wants the first page. */
/** Hard ceiling on rows EXAMINED, so one call cannot walk an unbounded table. */
const SCAN_LIMIT = 20000;
/** How many are read per round trip. */
const SCAN_BATCH = 1000;
/** How many offending rows are returned; the count above it is still true. */
const ROW_LIMIT = 200;

/**
 * Answers "which subscriptions will fail their next renewal, and why".
 *
 * ── The failure this makes visible ────────────────────────────────────────
 *
 * A squad deleted or RECREATED in Remnawave keeps its old uuid on every
 * subscription sold against it. The panel validates squad uuids for SHAPE only,
 * so the dead one passes validation and then throws inside the panel's own
 * service — `HTTP 500 A039 Update user error`, which names neither the field
 * nor the value. Reproduced against a live 3.3.2 panel: a non-existent squad
 * gives exactly that, an existing one gives 200.
 *
 * Two things already help, and neither is enough on its own. The sync failure
 * now names the offending uuid — but only once it has already failed, for one
 * customer at a time. Saving a plan warns how many subscriptions the squad
 * propagation could not move — but that warning appears once, in a toast, and
 * an operator who was not watching never sees it again.
 *
 * This is the third thing: a list that can be opened at any moment and answers
 * for the whole install. It writes nothing.
 *
 * ── Why an unreachable panel is an ERROR here, not an empty list ──────────
 *
 * Everywhere else in this codebase a failed panel read degrades to "we could
 * not tell". A screen whose entire job is to say "these are broken" must not
 * degrade that way: an empty list reads as "nothing is wrong", which is the
 * single most misleading thing this endpoint could say. So the read either
 * answers with the panel's real squad set or refuses out loud.
 */
@Injectable()
export class UnknownSquadAuditService {
  private readonly logger = new Logger(UnknownSquadAuditService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    @Optional() private readonly panelInfra?: PanelInfraClient,
  ) {}

  public async audit(): Promise<UnknownSquadReport> {
    const known = await this.readKnownSquads();

    // ── EVERY candidate is examined; only the LIST is capped ────────────────
    //
    // This used to read the newest SCAN_LIMIT rows and stop. That is the wrong
    // end of the table: a squad deleted a while ago is carried by the OLD
    // subscriptions, so the cap systematically hid the very rows the screen
    // exists to find, and reported `affected: 0` — "all clear" — while doing it.
    // Paging through in batches keeps the memory bound that the cap was for and
    // makes `scanned` and `affected` true.
    const candidateWhere: Prisma.SubscriptionWhereInput = {
      status: { not: SubscriptionStatus.DELETED },
      // A subscription with no squads at all cannot be pointing at a dead
      // one, and on a big install those are most of the table.
      OR: [{ NOT: { internalSquads: { isEmpty: true } } }, { NOT: { externalSquad: null } }],
    };

    const rows: UnknownSquadRow[] = [];
    let scanned = 0;
    let cursor: string | undefined;
    for (;;) {
      const batch = await this.prismaService.subscription.findMany({
        where: candidateWhere,
        select: {
          id: true,
          userId: true,
          status: true,
          internalSquads: true,
          externalSquad: true,
          planSnapshot: true,
        },
        orderBy: { id: 'asc' },
        take: SCAN_BATCH,
        ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
      });
      if (batch.length === 0) break;
      scanned += batch.length;
      this.collectUnknownRows(batch, known, rows);
      cursor = batch[batch.length - 1]?.id;
      if (batch.length < SCAN_BATCH) break;
      if (scanned >= SCAN_LIMIT) break;
    }
    const scanTruncated = scanned >= SCAN_LIMIT;


    // The plans as well as the subscriptions: fixing a subscription one at a
    // time while the plan still holds the dead uuid means the next purchase
    // recreates the problem.
    const plans = await this.prismaService.plan.findMany({
      select: { id: true, name: true, internalSquads: true, externalSquad: true },
    });
    const affectedPlans = plans
      .filter(
        (plan) =>
          plan.internalSquads.some((uuid) => !known.has(uuid)) ||
          (plan.externalSquad !== null && !known.has(plan.externalSquad)),
      )
      .map((plan) => ({ id: plan.id, name: plan.name }));

    return {
      scanned,
      affected: rows.length,
      truncated: scanTruncated || rows.length > ROW_LIMIT,
      rows: rows.slice(0, ROW_LIMIT),
      affectedPlans,
    };
  }

  /** Appends every subscription in `batch` that names a squad the panel lacks. */
  private collectUnknownRows(
    batch: readonly {
      readonly id: string;
      readonly userId: string;
      readonly status: SubscriptionStatus;
      readonly internalSquads: readonly string[];
      readonly externalSquad: string | null;
      readonly planSnapshot: unknown;
    }[],
    known: ReadonlySet<string>,
    rows: UnknownSquadRow[],
  ): void {
    for (const subscription of batch) {
      const unknownInternal = subscription.internalSquads.filter((uuid) => !known.has(uuid));
      const externalMissing =
        subscription.externalSquad !== null && !known.has(subscription.externalSquad);
      if (unknownInternal.length === 0 && !externalMissing) continue;
      rows.push({
        subscriptionId: subscription.id,
        userId: subscription.userId,
        status: subscription.status,
        planName: readPlanName(subscription.planSnapshot),
        unknownSquads: externalMissing
          ? [...unknownInternal, subscription.externalSquad as string]
          : unknownInternal,
        externalSquadMissing: externalMissing,
      });
    }
  }

  /** Every squad uuid the panel serves, internal and external. */
  private async readKnownSquads(): Promise<ReadonlySet<string>> {
    if (this.panelInfra === undefined) {
      throw new ServiceUnavailableException({
        code: 'PANEL_UNAVAILABLE',
        message: 'The Remnawave integration is not configured, so squads cannot be checked.',
      });
    }
    const [internal, external] = await Promise.all([
      this.panelInfra.getInternalSquadOptions(),
      this.panelInfra.getExternalSquadOptions(),
    ]);
    if (internal.kind !== 'ok' || external.kind !== 'ok') {
      this.logger.warn('Unknown-squad audit refused: the panel did not answer');
      throw new ServiceUnavailableException({
        code: 'PANEL_UNAVAILABLE',
        message:
          'The panel did not answer, so this list cannot be trusted. ' +
          'An empty result here would read as "nothing is wrong".',
      });
    }
    return new Set([
      ...internal.data.map((squad) => squad.uuid),
      ...external.data.map((squad) => squad.uuid),
    ]);
  }
}

function readPlanName(snapshot: unknown): string | null {
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  const name = (snapshot as Record<string, unknown>).name;
  return typeof name === 'string' && name.length > 0 ? name : null;
}
