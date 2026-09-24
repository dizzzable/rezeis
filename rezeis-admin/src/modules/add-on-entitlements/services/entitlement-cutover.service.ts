import { Injectable, Logger } from '@nestjs/common';
import {
  EntitlementIncidentKind,
  EntitlementIncidentSeverity,
  EntitlementIncidentState,
  Prisma,
  SubscriptionStatus,
  SubscriptionTermStatus,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { readJsonObject } from '../../../common/utils/read-json-object.util';
import { isRetryableTransactionConflict } from '../../referrals/services/referral-qualification.service';
import {
  CutoverClassification,
  deriveCutoverBaseline,
  GIB_BYTES,
} from '../domain/cutover-baseline';
import { provisionalResetAnchor } from '../domain/reset-cycle-policy';
import { EffectiveProjectionService } from './effective-projection.service';
import { SubscriptionTermService } from './subscription-term.service';

/** Subscriptions read per page of a cutover run. */
const CUTOVER_BATCH = 200;

/** Samples kept per kind in a run report — enough to look at, bounded for a log line. */
const REPORT_SAMPLES = 20;

/** Attempts one subscription gets when PostgreSQL aborts its transaction to break a conflict. */
const CUTOVER_ROW_ATTEMPTS = 3;

/**
 * `summaryCode` of the incident a subscription the cutover could not bring into
 * the term model gets. Such a row is left out of every later run while the
 * incident is OPEN (see {@link EntitlementCutoverService.runCutover}).
 */
export const CUTOVER_FAILED = 'CUTOVER_FAILED';

/**
 * Incident states that still hold a subscription out of the cutover: OPEN only.
 *
 * Not "anything short of RESOLVED": nothing in the product ever resolves an
 * entitlement incident — the one operator action is «Принять» (acknowledge) in
 * the subscription inspector — so a hold that waited for RESOLVED would hold
 * the row for good. Acknowledging is the operator saying "looked at it, fixed
 * what was wrong"; the next pass tries the row again, and a row that fails
 * again raises a new incident.
 */
const HOLDING_INCIDENT_STATES: readonly EntitlementIncidentState[] = [EntitlementIncidentState.OPEN];

export interface CutoverSubscriptionResult {
  readonly subscriptionId: string;
  readonly outcome: 'CREATED' | 'SKIPPED_DELETED' | 'SKIPPED_EXISTING';
  readonly classification: CutoverClassification | null;
  readonly ambiguousReasons: readonly string[];
  readonly termId?: string;
  readonly baseTrafficLimitBytes?: bigint | null;
  readonly baseDeviceLimit?: number | null;
}

/**
 * What {@link EntitlementCutoverService.ensureTermInTransaction} left behind.
 *
 * `activeTermId` is THE answer a caller acts on: the subscription's ACTIVE
 * term after the call — the one just created, or the one that was already
 * there. It is `null` when the row is missing or DELETED, and also in the one
 * anomalous shape where the subscription already has terms but none is ACTIVE;
 * `ensure` never adds a term next to existing ones, so such a caller stays on
 * whatever path it takes without a term.
 */
export interface EnsureTermResult {
  readonly subscriptionId: string;
  readonly outcome: 'CREATED' | 'EXISTING' | 'SKIPPED_DELETED';
  readonly activeTermId: string | null;
  readonly classification: CutoverClassification | null;
  readonly ambiguousReasons: readonly string[];
  readonly baseTrafficLimitBytes?: bigint | null;
  readonly baseDeviceLimit?: number | null;
  /**
   * `CREATED` only: whether the SHADOW projection's `desired` equals the
   * legacy columns (canonical unlimited = `null`) — the stage-1 go/no-go, per
   * row. The baseline is minted FROM those columns, so `false` means a defect.
   */
  readonly shadowMatchesColumns?: boolean;
}

export interface CutoverRunOptions {
  /** When true (default), only classifies candidates — no writes. */
  readonly dryRun?: boolean;
  /** Subscriptions read per page. */
  readonly batchSize?: number;
  /** Stop after this many subscriptions (the background job's per-tick budget). Unbounded when omitted. */
  readonly maxRows?: number;
  /** Stop starting new rows at this instant (epoch ms). */
  readonly deadline?: number;
  /** Pause between pages, so a large install is not hammered in one burst. */
  readonly pauseMs?: number;
  /** Asked before each row; `true` ends the run there (the process is shutting down). */
  readonly shouldStop?: () => boolean;
  /**
   * Restrict the run to these subscriptions — re-running named rows by hand
   * (the script's `--only`), e.g. after accepting their `CUTOVER_FAILED`
   * incidents. Omitted, the run covers every candidate.
   */
  readonly onlySubscriptionIds?: readonly string[];
}

export interface CutoverRunReport {
  readonly dryRun: boolean;
  /** Subscriptions examined by this run. */
  readonly candidates: number;
  readonly created: number;
  readonly matched: number;
  readonly ambiguous: number;
  readonly skippedDeleted: number;
  readonly skippedExisting: number;
  /** Rows that threw for a reason a retry cannot fix; each has a `CUTOVER_FAILED` incident. */
  readonly failed: number;
  /** Rows that kept losing a lock conflict; no incident, the next run tries again. */
  readonly deferred: number;
  /** Created rows whose shadow did not equal the columns. Zero is the go/no-go. */
  readonly shadowMismatches: number;
  /** `true` when the run stopped at its budget with candidates possibly left. */
  readonly truncated: boolean;
  readonly ambiguousSamples: ReadonlyArray<{
    readonly subscriptionId: string;
    readonly reasons: readonly string[];
  }>;
  readonly mismatchSamples: readonly string[];
  readonly failedSamples: ReadonlyArray<{ readonly subscriptionId: string; readonly error: string }>;
}

/** Where the cutover stands on this install — read for the operator, never written. */
export interface CutoverProgress {
  /** Subscriptions that are not DELETED. */
  readonly eligible: number;
  /** Of those, how many are in the term model. */
  readonly inModel: number;
  /** Of those, how many are not yet. */
  readonly remaining: number;
  /** Subscriptions held out by an OPEN `CUTOVER_FAILED` incident. */
  readonly needAttention: number;
}

const CANDIDATE_SELECT = {
  id: true,
  status: true,
  trafficLimit: true,
  deviceLimit: true,
  planSnapshot: true,
  createdAt: true,
  expiresAt: true,
} as const satisfies Prisma.SubscriptionSelect;

type CutoverSubscriptionRow = Prisma.SubscriptionGetPayload<{ select: typeof CANDIDATE_SELECT }>;

function describeError(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Grandfather cutover: exactly one ACTIVE `SubscriptionTerm` and a SHADOW
 * `SubscriptionEffectiveProjection` per existing non-deleted subscription,
 * derived from its current local limits. Additive and observation-only — no
 * upstream (Remnawave) write happens. Idempotent per subscription: a
 * subscription that already has any term is left alone.
 *
 * Historical top-ups and rewards are NOT converted into entitlements and are
 * NOT subtracted (owner, 24.09.2026: legacy add-ons are grandfathered); the
 * baseline is exactly the current effective local limit, so the shadow
 * projection equals the legacy limits by construction.
 */
@Injectable()
export class EntitlementCutoverService {
  private readonly logger = new Logger(EntitlementCutoverService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly subscriptionTermService: SubscriptionTermService,
    private readonly effectiveProjectionService: EffectiveProjectionService,
  ) {}

  /**
   * THE ONE WAY A SUBSCRIPTION ENTERS THE TERM MODEL, inside the caller's
   * transaction: its first term (generation 1, activated at once) and its
   * SHADOW projection, minted from the row's own columns — or nothing, when it
   * already has a term.
   *
   * - IDEMPOTENT. A subscription with ANY term is `EXISTING`, and nothing is
   *   written; the ACTIVE term it already has is returned.
   * - UNDER THE SUBSCRIPTION ROW LOCK, taken before the existence check and
   *   before every read of the columns. Every durable writer — a payment's
   *   renewal term, an upgrade term, an add-on's ledger row, the boundary
   *   sweep's recompute — takes the same `FOR UPDATE` first, so a concurrent
   *   payment either commits before this reads (and the term is minted from
   *   what it wrote, or it already created the term and this is `EXISTING`) or
   *   waits for this to commit (and finds the term).
   * - NO ROLLOUT FLAG IS READ. Whether a subscription should ENTER the model is
   *   the caller's decision (the background job reads stage 1; the purchase,
   *   renewal and upgrade paths will call this lazily). What this does once
   *   asked is the same whatever the flags say.
   * - DELETED (or missing) is `SKIPPED_DELETED`; nothing is written.
   *
   * The window is `[createdAt, expiresAt]`, pulled back to one second before
   * `expiresAt` for a row that had already lapsed, and open-ended only for a
   * lifetime subscription — see `deriveCutoverBaseline`.
   */
  public async ensureTermInTransaction(
    tx: Prisma.TransactionClient,
    subscriptionId: string,
  ): Promise<EnsureTermResult> {
    // The row lock first; every column read comes after it, because a
    // candidate read outside this transaction may be arbitrarily stale.
    const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "subscriptions"
      WHERE "id" = ${subscriptionId}
      FOR UPDATE
    `);
    const current =
      locked.length === 1
        ? await tx.subscription.findUnique({ where: { id: subscriptionId }, select: CANDIDATE_SELECT })
        : null;
    if (current === null || current.status === SubscriptionStatus.DELETED) {
      return {
        subscriptionId,
        outcome: 'SKIPPED_DELETED',
        activeTermId: null,
        classification: null,
        ambiguousReasons: [],
      };
    }

    const existingTerm = await tx.subscriptionTerm.findFirst({
      where: { subscriptionId },
      select: { id: true },
    });
    if (existingTerm !== null) {
      const active = await tx.subscriptionTerm.findFirst({
        where: { subscriptionId, status: SubscriptionTermStatus.ACTIVE },
        orderBy: { generation: 'desc' },
        select: { id: true },
      });
      return {
        subscriptionId,
        outcome: 'EXISTING',
        activeTermId: active?.id ?? null,
        classification: null,
        ambiguousReasons: [],
      };
    }

    const snapshot = readJsonObject(current.planSnapshot);
    const baseline = deriveCutoverBaseline({
      trafficLimit: current.trafficLimit,
      deviceLimit: current.deviceLimit,
      trafficLimitStrategy: readStrategy(snapshot),
      createdAt: current.createdAt,
      expiresAt: current.expiresAt,
    });
    const planId = typeof snapshot['id'] === 'string' ? (snapshot['id'] as string) : undefined;

    const scheduled = await this.subscriptionTermService.createScheduledInTransaction(tx, {
      subscriptionId,
      planId,
      planSnapshot: snapshot as Prisma.InputJsonValue,
      startsAt: baseline.startsAt,
      endsAt: baseline.endsAt,
      baseTrafficLimitBytes: baseline.baseTrafficLimitBytes,
      baseDeviceLimit: baseline.baseDeviceLimit,
      trafficResetStrategy: baseline.trafficResetStrategy,
      resetAnchorAt: provisionalResetAnchor(baseline.trafficResetStrategy, baseline.startsAt),
    });
    await this.subscriptionTermService.activateInTransaction(tx, scheduled.id, baseline.startsAt);
    const projection = await this.effectiveProjectionService.recomputeInTransaction(tx, {
      subscriptionId,
      mode: 'SHADOW',
    });

    const expectedTraffic =
      current.trafficLimit === null ? null : BigInt(current.trafficLimit) * GIB_BYTES;
    const expectedDevices = current.deviceLimit <= 0 ? null : current.deviceLimit;
    return {
      subscriptionId,
      outcome: 'CREATED',
      activeTermId: scheduled.id,
      classification: baseline.classification,
      ambiguousReasons: baseline.ambiguousReasons,
      baseTrafficLimitBytes: baseline.baseTrafficLimitBytes,
      baseDeviceLimit: baseline.baseDeviceLimit,
      shadowMatchesColumns:
        projection.desiredTrafficLimitBytes === expectedTraffic &&
        projection.desiredDeviceLimit === expectedDevices,
    };
  }

  /**
   * Grandfather a single subscription inside the caller's transaction. Kept for
   * its callers; only `subscription.id` is read — everything else is re-read
   * under the lock by {@link ensureTermInTransaction}.
   */
  public async cutoverSubscriptionInTransaction(
    tx: Prisma.TransactionClient,
    subscription: CutoverSubscriptionRow,
  ): Promise<CutoverSubscriptionResult> {
    const result = await this.ensureTermInTransaction(tx, subscription.id);
    if (result.outcome !== 'CREATED') {
      return {
        subscriptionId: subscription.id,
        outcome: result.outcome === 'EXISTING' ? 'SKIPPED_EXISTING' : 'SKIPPED_DELETED',
        classification: null,
        ambiguousReasons: [],
      };
    }
    return {
      subscriptionId: subscription.id,
      outcome: 'CREATED',
      classification: result.classification,
      ambiguousReasons: result.ambiguousReasons,
      termId: result.activeTermId ?? undefined,
      baseTrafficLimitBytes: result.baseTrafficLimitBytes,
      baseDeviceLimit: result.baseDeviceLimit,
    };
  }

  /**
   * Brings every subscription without a term into the model — or, dry-run
   * (the default), only classifies them.
   *
   * PAGED, AND ONE TRANSACTION PER SUBSCRIPTION. Candidates are read in pages
   * of `batchSize` on a keyset cursor `(createdAt, id)`; each is then handed to
   * {@link ensureTermInTransaction} in a transaction of its own, so a large
   * install is never one long transaction and a payment waits on at most one
   * row's worth of work. The cursor is local to the run: a finished row leaves
   * the candidate set (it has a term now), so a run that stops — at its
   * budget, a deploy, a crash — is resumed by the next run from the start with
   * nothing to remember.
   *
   * A ROW THAT FAILS NEVER ABORTS THE RUN. A lock conflict PostgreSQL resolved
   * by aborting this row (deadlock, serialization) is retried in place a few
   * times, then counted `deferred` and left for the next run — it is a race, not
   * a fault. Anything else raises ONE `CUTOVER_FAILED` incident for the
   * subscription and the run moves on. While that incident is OPEN the row is
   * not a candidate: a row that fails the same way every time must not be
   * retried, logged and re-reported every five minutes, and a bad row at the
   * head of the order must not stall the cursor behind it. Acknowledging the
   * incident («Принять») puts the row back.
   *
   * The budget (`maxRows`, `deadline`) makes a run bounded; `truncated` says it
   * stopped with candidates possibly left.
   */
  public async runCutover(options: CutoverRunOptions = {}): Promise<CutoverRunReport> {
    const dryRun = options.dryRun ?? true;
    const batchSize = Math.max(1, options.batchSize ?? CUTOVER_BATCH);
    const report = {
      dryRun,
      candidates: 0,
      created: 0,
      matched: 0,
      ambiguous: 0,
      skippedDeleted: 0,
      skippedExisting: 0,
      failed: 0,
      deferred: 0,
      shadowMismatches: 0,
      truncated: false,
      ambiguousSamples: [] as Array<{ subscriptionId: string; reasons: readonly string[] }>,
      mismatchSamples: [] as string[],
      failedSamples: [] as Array<{ subscriptionId: string; error: string }>,
    };
    const noteAmbiguous = (subscriptionId: string, reasons: readonly string[]): void => {
      report.ambiguous += 1;
      if (report.ambiguousSamples.length < REPORT_SAMPLES) {
        report.ambiguousSamples.push({ subscriptionId, reasons });
      }
    };

    let cursor: { readonly createdAt: Date; readonly id: string } | null = null;
    for (;;) {
      const room = options.maxRows === undefined ? batchSize : Math.min(batchSize, options.maxRows - report.candidates);
      if (room <= 0 || (options.deadline !== undefined && Date.now() >= options.deadline)) {
        report.truncated = true;
        break;
      }
      const page: CutoverSubscriptionRow[] = await this.prismaService.subscription.findMany({
        where: {
          ...(options.onlySubscriptionIds === undefined ? {} : { id: { in: [...options.onlySubscriptionIds] } }),
          status: { not: SubscriptionStatus.DELETED },
          terms: { none: {} },
          entitlementIncidents: {
            none: { summaryCode: CUTOVER_FAILED, state: { in: [...HOLDING_INCIDENT_STATES] } },
          },
          ...(cursor === null
            ? {}
            : {
                OR: [
                  { createdAt: { gt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, id: { gt: cursor.id } },
                ],
              }),
        },
        select: CANDIDATE_SELECT,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: room,
      });
      if (page.length === 0) break;

      let stopped = false;
      for (const subscription of page) {
        if (options.shouldStop?.() === true) {
          stopped = true;
          break;
        }
        report.candidates += 1;
        if (dryRun) {
          const baseline = deriveCutoverBaseline({
            trafficLimit: subscription.trafficLimit,
            deviceLimit: subscription.deviceLimit,
            trafficLimitStrategy: readStrategy(readJsonObject(subscription.planSnapshot)),
            createdAt: subscription.createdAt,
            expiresAt: subscription.expiresAt,
          });
          if (baseline.classification === 'AMBIGUOUS') {
            noteAmbiguous(subscription.id, baseline.ambiguousReasons);
          } else {
            report.matched += 1;
          }
          continue;
        }

        const attempt = await this.cutoverOneRow(subscription.id);
        switch (attempt.kind) {
          case 'done': {
            const result = attempt.result;
            if (result.outcome === 'CREATED') {
              report.created += 1;
              if (result.classification === 'AMBIGUOUS') {
                noteAmbiguous(result.subscriptionId, result.ambiguousReasons);
              } else {
                report.matched += 1;
              }
              if (result.shadowMatchesColumns === false) {
                report.shadowMismatches += 1;
                if (report.mismatchSamples.length < REPORT_SAMPLES) {
                  report.mismatchSamples.push(result.subscriptionId);
                }
              }
            } else if (result.outcome === 'EXISTING') {
              report.skippedExisting += 1;
            } else {
              report.skippedDeleted += 1;
            }
            break;
          }
          case 'deferred':
            report.deferred += 1;
            break;
          case 'failed':
            report.failed += 1;
            if (report.failedSamples.length < REPORT_SAMPLES) {
              report.failedSamples.push({ subscriptionId: subscription.id, error: attempt.error });
            }
            break;
        }
      }

      if (stopped) {
        report.truncated = true;
        break;
      }
      const last = page[page.length - 1]!;
      cursor = { createdAt: last.createdAt, id: last.id };
      if (page.length < room) break;
      if (options.pauseMs !== undefined && options.pauseMs > 0) await sleep(options.pauseMs);
    }

    if (dryRun) {
      this.logger.log(
        `Cutover dry-run: ${report.candidates} candidate(s), ${report.matched} matched, ${report.ambiguous} ambiguous`,
      );
    } else if (report.candidates > 0) {
      this.logger.log(
        `Cutover applied: created ${report.created} (${report.matched} matched, ${report.ambiguous} ambiguous, ` +
          `${report.shadowMismatches} shadow mismatch(es)), skipped ${report.skippedExisting} existing / ` +
          `${report.skippedDeleted} deleted, ${report.failed} failed, ${report.deferred} deferred` +
          `${report.truncated ? ' — budget reached, the next run continues' : ''}`,
      );
    }
    return report;
  }

  /** Where the cutover stands: one count per question, all read-only. */
  public async progress(): Promise<CutoverProgress> {
    return readCutoverProgress(this.prismaService);
  }

  /**
   * One subscription, in its own transaction, with the failure policy of
   * {@link runCutover}. Never throws.
   */
  private async cutoverOneRow(
    subscriptionId: string,
  ): Promise<
    | { readonly kind: 'done'; readonly result: EnsureTermResult }
    | { readonly kind: 'deferred' }
    | { readonly kind: 'failed'; readonly error: string }
  > {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const result = await this.prismaService.$transaction((tx) =>
          this.ensureTermInTransaction(tx, subscriptionId),
        );
        return { kind: 'done', result };
      } catch (error: unknown) {
        if (isRetryableTransactionConflict(error)) {
          if (attempt < CUTOVER_ROW_ATTEMPTS) continue;
          this.logger.warn(
            `Cutover of ${subscriptionId} kept losing a lock conflict (${describeError(error)}); ` +
              'the next run retries it',
          );
          return { kind: 'deferred' };
        }
        const described = describeError(error);
        this.logger.error(`Cutover of ${subscriptionId} failed and is held for an operator: ${described}`);
        await this.raiseCutoverIncident(subscriptionId, described);
        return { kind: 'failed', error: described };
      }
    }
  }

  /**
   * ONE incident per failure episode. The support ref carries a sequence number
   * — the count of earlier `CUTOVER_FAILED` incidents on the row — because a
   * row only fails again after its previous incident was acknowledged (an OPEN
   * one holds it out of the runs), and that is a new episode an operator must
   * see, not a silent no-op against the acknowledged one.
   */
  private async raiseCutoverIncident(subscriptionId: string, error: string): Promise<void> {
    try {
      const previous = await this.prismaService.entitlementIncident.count({
        where: { subscriptionId, summaryCode: CUTOVER_FAILED },
      });
      const supportRef = `cutover-failed:${subscriptionId}:${previous + 1}`;
      await this.prismaService.entitlementIncident.upsert({
        where: { supportRef },
        update: {},
        create: {
          subscriptionId,
          kind: EntitlementIncidentKind.RECONCILIATION_REQUIRED,
          severity: EntitlementIncidentSeverity.WARNING,
          supportRef,
          summaryCode: CUTOVER_FAILED,
          metadata: { error },
        },
      });
    } catch (incidentError: unknown) {
      // The row stays a candidate and the next run tries it again; the log is
      // the trace until then.
      this.logger.error(
        `Cutover incident for ${subscriptionId} could not be recorded: ${describeError(incidentError)}`,
      );
    }
  }
}

/**
 * The cutover's progress, as the operator reads it (the metrics endpoint the
 * «Дополнительные опции» entitlements tab loads). Three counts, all read-only.
 */
export async function readCutoverProgress(
  client: Pick<PrismaService, 'subscription' | 'entitlementIncident'>,
): Promise<CutoverProgress> {
  const [eligible, inModel, needAttention] = await Promise.all([
    client.subscription.count({ where: { status: { not: SubscriptionStatus.DELETED } } }),
    client.subscription.count({
      where: { status: { not: SubscriptionStatus.DELETED }, terms: { some: {} } },
    }),
    client.entitlementIncident.count({
      where: { summaryCode: CUTOVER_FAILED, state: { in: [...HOLDING_INCIDENT_STATES] } },
    }),
  ]);
  return { eligible, inModel, remaining: Math.max(0, eligible - inModel), needAttention };
}

function readStrategy(snapshot: Record<string, unknown>): string | null {
  return typeof snapshot['trafficLimitStrategy'] === 'string'
    ? (snapshot['trafficLimitStrategy'] as string)
    : null;
}
