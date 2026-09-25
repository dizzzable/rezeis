import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  AddOnEntitlementActorType,
  AddOnEntitlementState,
  AddOnType,
  EntitlementIncidentKind,
  Prisma,
  SubscriptionStatus,
  SubscriptionTermStatus,
  SyncAction,
  SyncJobStatus,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { carryImportDomainKeys } from '../../imports/utils/import-domain-snapshot.util';
import { storedIdentityOf } from '../../remnawave/services/panel-user-address';
import { RemnawaveApiService } from '../../remnawave/services/remnawave-api.service';
import {
  readRemnawaveProfileFacts,
  stampRemnawaveProfileFacts,
} from '../../remnawave/utils/remnawave-profile-facts.util';
import { readAddOnRolloutFlags, resolveResetCapabilities } from '../add-on-rollout.config';
import { GIB_BYTES } from '../domain/cutover-baseline';
import { resolveOperatorConfiguredLimits } from '../domain/entitlement-baseline';
import { withoutTermLimitBonuses } from '../domain/term-limit-bonus';
import { AddOnSwitchesService } from '../switches/add-on-switches.service';
import { AddOnEntitlementService } from './add-on-entitlement.service';
import { DurableRetirementResult, retireDurableRowsInTransaction } from './durable-retirement.util';
import { EffectiveProjectionService } from './effective-projection.service';
import { isHeldForResetConfirmation } from './reset-boundary-confirmation.service';
import { SubscriptionTermService } from './subscription-term.service';
import { pruneEndedTermLimitBonusesInTransaction } from './term-limit-bonus.util';

export interface BoundaryActivationResult {
  readonly activated: boolean;
  readonly termId: string | null;
  readonly desiredRevision: bigint | null;
  readonly syncJobIds: readonly string[];
}

export interface BoundaryExpiryResult {
  readonly began: number;
  readonly expired: number;
  readonly changed: boolean;
  readonly desiredRevision: bigint | null;
  readonly syncJobIds: readonly string[];
  /** True when a due EXTRA_DEVICES entitlement began expiry — the caller should
   *  build a device-reduction plan (the desired device limit just dropped). */
  readonly deviceExpiryTriggered: boolean;
}

export type VerifiedDeviceExpiryCompletionResult =
  | { readonly status: 'COMPLETED'; readonly completed: number }
  | { readonly status: 'SUPERSEDED'; readonly completed: 0 };

interface DeferredPlanActivation {
  readonly planSnapshot: Prisma.InputJsonValue;
  readonly internalSquads?: readonly string[];
  readonly externalSquad?: string | null;
}

function decodeDeferredPlanActivation(
  snapshot: Prisma.JsonValue | undefined,
): DeferredPlanActivation | null {
  if (snapshot === null || snapshot === undefined || Array.isArray(snapshot) || typeof snapshot !== 'object') {
    return null;
  }
  const value = snapshot as Record<string, unknown>;
  if (typeof value.id !== 'string' || value.id.trim().length === 0) return null;
  // The term's free limit bonuses stay on the term, the one place they count
  // (`../domain/term-limit-bonus.ts`); the row's snapshot is what the plan gave.
  const decoded: {
    planSnapshot: Prisma.InputJsonValue;
    internalSquads?: readonly string[];
    externalSquad?: string | null;
  } = { planSnapshot: withoutTermLimitBonuses(value) as Prisma.InputJsonValue };
  if (Array.isArray(value.internalSquads) && value.internalSquads.every((entry) => typeof entry === 'string')) {
    decoded.internalSquads = value.internalSquads;
  }
  const externalSquad = value.externalSquad;
  if (externalSquad === null) {
    decoded.externalSquad = null;
  } else if (typeof externalSquad === 'string') {
    decoded.externalSquad = externalSquad;
  }
  return decoded;
}

/**
 * EntitlementBoundaryService (T-008)
 * ──────────────────────────────────
 * Expires ACTIVE add-on entitlements at their authoritative LOCAL boundary
 * (`expiresAt <= now`) — a term end (UNTIL_SUBSCRIPTION_END) or a reset epoch
 * (UNTIL_NEXT_RESET, sold only while stage 4 is on — «Докупка трафика до
 * сброса»; the date is on the row, so this service expires it without a flag
 * of its own). A manual panel reset can NEVER expire a commercial entitlement:
 * nothing but `expiresAt` makes one due. What a Remnawave observation CAN do is
 * DELAY one — an add-on that ends at a reset waits, past its `expiresAt`, until
 * Remnawave's reset is confirmed or its hold runs out
 * (`ResetBoundaryConfirmationService`), so the base limit never reaches
 * Remnawave before the counter is zeroed.
 *
 * Per due entitlement (idempotent via per-entitlement command keys):
 *  - `BEGIN_EXPIRY` (ACTIVE → EXPIRING): the desired projection drops
 *    immediately because the projection sums only ACTIVE entitlements;
 *  - EXTRA_TRAFFIC has no reconciliation saga, so it is completed in the same
 *    pass (`COMPLETE_EXPIRY` → EXPIRED);
 *  - EXTRA_DEVICES stays EXPIRING — the device-reduction saga (T-011) reduces
 *    the panel HWIDs and completes the expiry.
 *
 * All transitions + the single projection recompute commit in ONE transaction
 * (atomic boundary). Concurrent scheduler/webhook runs converge: the command
 * keys make transitions idempotent and the recompute is value-idempotent.
 */
@Injectable()
export class EntitlementBoundaryService {
  private readonly logger = new Logger(EntitlementBoundaryService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly addOnEntitlementService: AddOnEntitlementService,
    private readonly subscriptionTermService: SubscriptionTermService,
    private readonly effectiveProjectionService: EffectiveProjectionService,
    private readonly remnawaveApiService?: RemnawaveApiService,
    /** The stage switches; `@Optional()` only for the specs that build this by hand. */
    @Optional() private readonly addOnSwitches?: AddOnSwitchesService,
  ) {}

  /**
   * Activates a due SCHEDULED term at its start boundary (early-renewal flow,
   * design D-4). Finds the earliest SCHEDULED term whose `startsAt <= now`,
   * activates it (which atomically closes the prior ACTIVE term via
   * {@link SubscriptionTermService.activateInTransaction}), recomputes the
   * projection and enqueues a sync — all in ONE transaction. Idempotent:
   * re-running finds no due scheduled term.
   *
   * A MONTH_ROLLING term gets its reset anchor here, from the panel profile's
   * `createdAt` (read before the transaction), while stage 4 is on: it is what
   * later sales of «до следующего сброса» on this term count their cycle from.
   * The stage-4 flag is read ONCE, for both the fetch and the write, so a
   * switch flipped in between cannot clear an anchor it never fetched.
   *
   * Nothing else is activated here any more. The PENDING add-ons this used to
   * activate were sold with a renewal (stage 5), which was deleted with its
   * code on 24.09.2026 and never on by default; a row such a sale left behind
   * stays PENDING, counts toward nothing, and the entitlements inspector can
   * reverse it.
   */
  public async activateDueScheduledTerm(
    subscriptionId: string,
    now: Date = new Date(),
  ): Promise<BoundaryActivationResult> {
    const rollingAnchored =
      (resolveResetCapabilities(await readAddOnRolloutFlags(this.addOnSwitches)).MONTH_ROLLING ?? 'DISABLED') ===
      'ENABLED';
    const panelAnchor = rollingAnchored
      ? await this.resolveDueMonthRollingPanelAnchor(subscriptionId, now)
      : undefined;
    return this.prismaService.$transaction(async (tx) => {
      const due = await tx.subscriptionTerm.findFirst({
        where: {
          subscriptionId,
          status: SubscriptionTermStatus.SCHEDULED,
          startsAt: { lte: now },
        },
        orderBy: { generation: 'asc' },
        select: {
          id: true,
          trafficResetStrategy: true,
          planSnapshot: true,
          startsAt: true,
          resetAnchorAt: true,
        },
      });
      if (due === null) {
        return { activated: false, termId: null, desiredRevision: null, syncJobIds: [] };
      }

      // The profile's `createdAt` when one was read or stamped; otherwise the
      // anchor the term was MINTED with, kept (S4-core's leftover): minting
      // puts the profile's `createdAt` there, or the rolling anchor another term
      // carried (P2), and writing null over it — nothing stamped, the read
      // failed — only took a known cycle away and withheld its «до сброса»
      // sales. `startsAt` is still no stand-in: a stored anchor EQUAL to the
      // term's start is what v0.9.6.41's renewal minted for every strategy
      // before rolling got its own anchor, and it is cleared as it always was.
      // With neither, the anchor stays null and reset-scoped sales stay
      // fail-closed.
      if (due.trafficResetStrategy === 'MONTH_ROLLING' && rollingAnchored) {
        const read = panelAnchor?.termId === due.id ? panelAnchor.anchorAt : null;
        const minted =
          due.resetAnchorAt !== null && due.resetAnchorAt.getTime() !== due.startsAt.getTime() ? due.resetAnchorAt : null;
        await tx.subscriptionTerm.update({
          where: { id: due.id },
          data: { resetAnchorAt: read ?? minted },
        });
      }

      const activation = await this.subscriptionTermService.activateInTransaction(tx, due.id, now);

      const projection = await this.effectiveProjectionService.recomputeInTransaction(tx, {
        subscriptionId,
        mode: 'ACTIVE',
      });
      const syncJobIds: string[] = [];
      const deferredPlan = decodeDeferredPlanActivation(due.planSnapshot);
      // Resolved BEFORE the update below replaces `planSnapshot`, which is what
      // the override test reads the subscription against.
      const deferredSquads =
        deferredPlan === null
          ? {}
          : await this.resolveDeferredSquadWrite(tx, subscriptionId, deferredPlan);
      if (projection.changed || deferredPlan !== null) {
        // The term's plan replaces the snapshot, and the subscription's import
        // keys stay (`carryImportDomainKeys`): a row an import made keeps the
        // donor ids the next import of the same backup finds it by, or that
        // import creates a second subscription. Read under the row lock the
        // activation above took.
        const stored =
          deferredPlan === null
            ? null
            : await tx.subscription.findUnique({ where: { id: subscriptionId }, select: { planSnapshot: true } });
        const subscription = await tx.subscription.update({
          where: { id: subscriptionId },
          data: {
            ...(deferredPlan === null
              ? {}
              : {
                  planSnapshot: carryImportDomainKeys(stored?.planSnapshot, deferredPlan.planSnapshot),
                  ...deferredSquads,
                }),
            trafficLimit:
              projection.desiredTrafficLimitBytes === null
                ? null
                : Number(projection.desiredTrafficLimitBytes / GIB_BYTES),
            deviceLimit: projection.desiredDeviceLimit === null ? 0 : projection.desiredDeviceLimit,
          },
          select: { remnawaveId: true },
        });
        const syncJob = await tx.profileSyncJob.create({
          data: {
            subscriptionId,
            action: subscription.remnawaveId === null ? SyncAction.CREATE : SyncAction.UPDATE,
            status: SyncJobStatus.PENDING,
            aggregateKey: subscriptionId,
            desiredRevision: projection.desiredRevision,
            cause: 'TERM_ACTIVATION',
            payload: { source: 'TERM_ACTIVATION', termId: due.id } as Prisma.InputJsonObject,
          },
          select: { id: true },
        });
        syncJobIds.push(syncJob.id);
      }

      this.logger.log(`Activated scheduled term ${due.id} for ${subscriptionId}: term-changed ${activation.changed}`);
      return {
        activated: activation.changed,
        termId: due.id,
        desiredRevision: projection.desiredRevision,
        syncJobIds,
      };
    });
  }

  /**
   * Which of the deferred term plan's squads may be written at activation.
   *
   * ── The decision, and why it is not a merge ───────────────────────────────
   *
   * `trafficLimit` and `deviceLimit` are quantities, so an add-on layers on top
   * of whatever the subscription is entitled to and the projection can add the
   * two together (`../domain/entitlement-baseline.ts`). `internalSquads` and
   * `externalSquad` are MEMBERSHIP, and nothing in the catalogue grants a
   * squad: no add-on, no entitlement, no term contributes one. So there is no
   * second value to combine with, and "overridden squads plus a term" has only
   * two candidate answers — the term plan's list, or the operator's.
   *
   * There is no honest third. A union would hand the customer access to squads
   * nobody sold them and no operator chose; an intersection would silently
   * revoke access the operator granted; and taking the plan's list wholesale is
   * exactly the defect this change exists to remove, since an operator's squad
   * assignment is individual configuration in the same way a raised device
   * limit is. So the decision is: WHEN THE OPERATOR OWNS THE FIELD, THE
   * OVERRIDE SIMPLY WINS, WHOLE. That is a decision, not an omission — squads
   * cannot be meaningfully merged, and pretending otherwise would invent
   * entitlements.
   *
   * The ownership test is the same one the numeric baseline uses and is the
   * same call — `resolveOperatorConfiguredLimits`, over
   * `resolveInheritedPlanLimitUpdate`. Only the two membership keys are asked
   * about here, so this call and the projection's cannot answer differently
   * about a field they share: they share none.
   *
   * An unreadable stored snapshot leaves the field UNDECIDABLE, and the term
   * plan's list is written — the same direction the numeric baseline takes, and
   * today's behaviour, so a legacy row is not newly frozen by this change.
   */
  private async resolveDeferredSquadWrite(
    tx: Prisma.TransactionClient,
    subscriptionId: string,
    deferredPlan: DeferredPlanActivation,
  ): Promise<{ internalSquads?: string[]; externalSquad?: string | null }> {
    const write: { internalSquads?: string[]; externalSquad?: string | null } = {};
    if (deferredPlan.internalSquads === undefined && deferredPlan.externalSquad === undefined) {
      return write;
    }
    const current = await tx.subscription.findUnique({
      where: { id: subscriptionId },
      select: { internalSquads: true, externalSquad: true, planSnapshot: true },
    });
    const operatorOwns =
      current === null
        ? {}
        : resolveOperatorConfiguredLimits({
            configured: {
              internalSquads: current.internalSquads,
              externalSquad: current.externalSquad,
            },
            planSnapshot: current.planSnapshot,
          });
    if (deferredPlan.internalSquads !== undefined && !('internalSquads' in operatorOwns)) {
      write.internalSquads = [...deferredPlan.internalSquads];
    }
    if (deferredPlan.externalSquad !== undefined && !('externalSquad' in operatorOwns)) {
      write.externalSquad = deferredPlan.externalSquad;
    }
    return write;
  }

  /**
   * Resolves the only reset strategy whose boundary depends on panel profile
   * metadata. The panel call happens before the interactive DB transaction.
   * A missing/unavailable/invalid profile timestamp is represented as a null
   * anchor so activation remains available while reset-scoped commerce stays
   * fail-closed. Called only while the MONTH_ROLLING capability is on; the
   * caller has read it.
   *
   * The profile's `createdAt` stamped on the subscription
   * (`remnawave_profile_created_at`, from every answer of Remnawave's) is the
   * anchor, with no read at all; the panel is asked only when nothing stamped
   * it yet — and what that read says is stamped too. Before the column, a read
   * that failed at the moment of activation left the new term with no anchor,
   * and its rolling sales withheld until the next push.
   */
  private async resolveDueMonthRollingPanelAnchor(
    subscriptionId: string,
    now: Date,
  ): Promise<{ readonly termId: string; readonly anchorAt: Date | null } | undefined> {
    const due = await this.prismaService.subscriptionTerm.findFirst({
      where: {
        subscriptionId,
        status: SubscriptionTermStatus.SCHEDULED,
        startsAt: { lte: now },
        trafficResetStrategy: 'MONTH_ROLLING',
      },
      orderBy: { generation: 'asc' },
      select: {
        id: true,
        // The supplementary identity columns come along because this row is
        // read to ADDRESS the profile. A 2.x-created profile on an upgraded 3.x
        // panel has no live uuid left, and `getPanelUser` collapses "cannot be
        // addressed" into `null` — indistinguishable here from a panel that
        // answered without a `createdAt`, so the anchor would silently go null
        // and MONTH_ROLLING would mint its window from the wrong instant.
        subscription: {
          select: {
            remnawaveId: true,
            remnawavePanelId: true,
            remnawavePanelUsername: true,
            configUrl: true,
            remnawaveProfileCreatedAt: true,
          },
        },
      },
    });
    if (due === null) return undefined;
    const stamped = due.subscription.remnawaveProfileCreatedAt;
    if (stamped instanceof Date && !Number.isNaN(stamped.getTime())) {
      return { termId: due.id, anchorAt: stamped };
    }
    const identity = storedIdentityOf(due.subscription);
    if (identity === null || this.remnawaveApiService === undefined) {
      return { termId: due.id, anchorAt: null };
    }

    try {
      const panelUser = await this.remnawaveApiService.getPanelUser(identity);
      const facts = readRemnawaveProfileFacts(panelUser);
      try {
        await stampRemnawaveProfileFacts(this.prismaService, [subscriptionId], facts);
      } catch (error) {
        // The stamp is for the next reader; this activation has its anchor.
        this.logger.warn(
          `Remnawave profile facts not stamped for subscription ${subscriptionId}: ${(error as Error).message}`,
        );
      }
      return { termId: due.id, anchorAt: facts.createdAt };
    } catch (error) {
      this.logger.warn(
        `Cannot resolve MONTH_ROLLING panel anchor for term ${due.id}: ${(error as Error).message}`,
      );
      return { termId: due.id, anchorAt: null };
    }
  }

  public async completeVerifiedDeviceExpiryForSubscription(
    subscriptionId: string,
    projectionRevision: bigint,
    now: Date = new Date(),
  ): Promise<VerifiedDeviceExpiryCompletionResult> {
    return this.prismaService.$transaction((tx) =>
      this.completeVerifiedDeviceExpiryInTransaction(tx, subscriptionId, projectionRevision, now),
    );
  }

  public async completeVerifiedDeviceExpiryInTransaction(
    tx: Prisma.TransactionClient,
    subscriptionId: string,
    projectionRevision: bigint,
    now: Date = new Date(),
  ): Promise<VerifiedDeviceExpiryCompletionResult> {
    return this.completeDeviceExpiryInTransaction(tx, subscriptionId, projectionRevision, now, {
      reason: 'DEVICE_REDUCTION_VERIFIED',
      commandKeyPrefix: 'device-expiry-complete',
    });
  }

  /**
   * Completes the EXPIRING device add-ons of a subscription on which there is
   * NOTHING TO REDUCE at `projectionRevision` — the planner's `NOT_APPLICABLE`
   * that carries a revision: the desired device limit is unlimited, or there is
   * no panel profile to hold a device (none linked, or the panel says it is
   * gone). No plan can ever be built for such a row, so leaving the add-on
   * EXPIRING only brought it back to the sweep every five minutes for another
   * planning call and another panel read, forever.
   *
   * The same revision guard as a verified completion, under the same row lock:
   * a newer boundary (another device add-on beginning its expiry) moves the
   * revision, and this answers SUPERSEDED instead of completing an add-on the
   * planner never looked at. Its own command key, so it can never collide with
   * the verified completion's recorded payload.
   */
  public async completeUnreducibleDeviceExpiryForSubscription(
    subscriptionId: string,
    projectionRevision: bigint,
    plannerReason: string,
    now: Date = new Date(),
  ): Promise<VerifiedDeviceExpiryCompletionResult> {
    return this.prismaService.$transaction((tx) =>
      this.completeDeviceExpiryInTransaction(tx, subscriptionId, projectionRevision, now, {
        reason: 'DEVICE_REDUCTION_NOT_APPLICABLE',
        commandKeyPrefix: 'device-expiry-not-applicable',
        metadata: { plannerReason },
      }),
    );
  }

  private async completeDeviceExpiryInTransaction(
    tx: Prisma.TransactionClient,
    subscriptionId: string,
    projectionRevision: bigint,
    now: Date,
    completion: {
      readonly reason: string;
      readonly commandKeyPrefix: string;
      readonly metadata?: Prisma.InputJsonObject;
    },
  ): Promise<VerifiedDeviceExpiryCompletionResult> {
    // Projection recomputes serialize on this same row. Reading the revision only
    // after acquiring the lock prevents an older panel verification from
    // completing entitlements introduced by a newer expiry boundary.
    const locked = await tx.$queryRaw<Array<{ readonly id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "subscriptions"
      WHERE "id" = ${subscriptionId}
      FOR UPDATE
    `);
    if (locked.length !== 1) {
      return { status: 'SUPERSEDED', completed: 0 };
    }
    const projection = await tx.subscriptionEffectiveProjection.findUnique({
      where: { subscriptionId },
      select: { desiredRevision: true },
    });
    if (projection === null || projection.desiredRevision !== projectionRevision) {
      return { status: 'SUPERSEDED', completed: 0 };
    }

    const due = await tx.addOnEntitlement.findMany({
      where: {
        subscriptionId,
        type: AddOnType.EXTRA_DEVICES,
        state: AddOnEntitlementState.EXPIRING,
        expiresAt: { not: null, lte: now },
      },
      select: { id: true },
    });
    let completed = 0;
    for (const entitlement of due) {
      // A REFUNDED device add-on comes through this queue too
      // (`AddOnRefundService`: the refund begins its expiry, so its reduction
      // is retried like an expiry's). Its reduction done, it ends as the
      // refund it is — REVERSED, «Отменена» to the customer — not EXPIRED.
      const refund = await tx.entitlementIncident.findFirst({
        where: { entitlementId: entitlement.id, kind: EntitlementIncidentKind.REFUND_OR_CHARGEBACK },
        orderBy: { createdAt: 'asc' },
        select: { summaryCode: true },
      });
      const transition = await this.addOnEntitlementService.transitionInTransaction(tx, {
        entitlementId: entitlement.id,
        command: refund === null ? 'COMPLETE_EXPIRY' : 'REVERSE',
        commandKey: `${completion.commandKeyPrefix}:${entitlement.id}`,
        correlationId: `device-expiry:${subscriptionId}`,
        actorType: AddOnEntitlementActorType.SYSTEM,
        reason: refund?.summaryCode ?? completion.reason,
        ...(completion.metadata === undefined && refund === null
          ? {}
          : { metadata: { ...completion.metadata, ...(refund === null ? {} : { reductionReason: completion.reason }) } }),
      });
      if (transition.changed) completed += 1;
    }
    return { status: 'COMPLETED', completed };
  }

  /**
   * Retires the durable rows of a subscription that is already DELETED — see
   * `retireDurableRowsInTransaction`. Under the row lock; `retired: false`
   * when the row is gone or not DELETED (then nothing is written).
   *
   * The boundary sweep's answer to a DELETED row it finds due. Before it, such
   * a row threw in the projection recompute on every tick: the boundary
   * transaction rolled back, and the row came straight back five minutes later.
   */
  public async retireDeletedSubscription(
    subscriptionId: string,
  ): Promise<{ readonly retired: boolean } & Partial<DurableRetirementResult>> {
    return this.prismaService.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ readonly status: SubscriptionStatus }>>(Prisma.sql`
        SELECT "status"::text AS "status"
        FROM "subscriptions"
        WHERE "id" = ${subscriptionId}
        FOR UPDATE
      `);
      if (locked[0]?.status !== SubscriptionStatus.DELETED) return { retired: false };
      const result = await this.retireInTransaction(tx, subscriptionId);
      return { retired: true, ...result };
    });
  }

  public async expireDueForSubscription(
    subscriptionId: string,
    now: Date = new Date(),
  ): Promise<BoundaryExpiryResult> {
    return this.prismaService.$transaction(async (tx) => {
      // ALIGN BEFORE EXPIRING. `expiresAt` moves without the term (bonus days,
      // an operator edit, a pull from Remnawave); an UNTIL_SUBSCRIPTION_END
      // add-on must end with the SUBSCRIPTION, so the tail term and the add-ons
      // that end with it are moved first, under the row lock this also takes —
      // and only what is still due after that is expired. See
      // `SubscriptionTermService.alignTailToExpiryInTransaction`.
      const alignment = await this.subscriptionTermService.alignTailToExpiryInTransaction(
        tx,
        subscriptionId,
        { correlationId: `boundary-align:${subscriptionId}` },
      );
      if (alignment.outcome === 'SUBSCRIPTION_DELETED') {
        // Retired, not expired: the recompute below refuses a DELETED row, and
        // throwing here would bring the row back on every tick.
        await this.retireInTransaction(tx, subscriptionId);
        return { began: 0, expired: 0, changed: false, desiredRevision: null, syncJobIds: [], deviceExpiryTriggered: false };
      }

      // A free limit bonus a paid upgrade carried with an end of its own
      // (`until`) comes off the terms once that end has passed; the recompute
      // below then drops it, as it drops an expired add-on.
      const endedBonusTerms = await pruneEndedTermLimitBonusesInTransaction(tx, subscriptionId, now);

      // An add-on that ends AT a Remnawave reset waits for that reset to be
      // confirmed (`ResetBoundaryConfirmationService`), at most its hold: taken
      // off before the counter is zeroed, it cuts off a customer who used the
      // extra traffic. The same rule the sweep's selection applies in SQL, so a
      // subscription picked up for another boundary does not expire it early.
      const due = (
        await tx.addOnEntitlement.findMany({
          where: {
            subscriptionId,
            state: { in: [AddOnEntitlementState.ACTIVE, AddOnEntitlementState.EXPIRING] },
            expiresAt: { not: null, lte: now },
          },
          select: {
            id: true,
            type: true,
            state: true,
            lifetime: true,
            expiresAt: true,
            expiryEpoch: { select: { plannedEndsAt: true, closedAt: true } },
          },
        })
      ).filter((entitlement) => !isHeldForResetConfirmation(entitlement, now));
      if (due.length === 0 && endedBonusTerms === 0) {
        return { began: 0, expired: 0, changed: false, desiredRevision: null, syncJobIds: [], deviceExpiryTriggered: false };
      }

      const correlationId = `boundary:${subscriptionId}`;
      let began = 0;
      let expired = 0;
      let deviceExpiryTriggered = false;
      for (const entitlement of due) {
        if (entitlement.state === AddOnEntitlementState.ACTIVE) {
          const begin = await this.addOnEntitlementService.transitionInTransaction(tx, {
            entitlementId: entitlement.id,
            command: 'BEGIN_EXPIRY',
            commandKey: `boundary-begin:${entitlement.id}`,
            correlationId,
            actorType: AddOnEntitlementActorType.SYSTEM,
            reason: 'BOUNDARY_EXPIRY',
          });
          if (begin.changed) began += 1;
        }

        // Traffic entitlements have no HWID reconciliation — complete now.
        if (entitlement.type === AddOnType.EXTRA_TRAFFIC) {
          const complete = await this.addOnEntitlementService.transitionInTransaction(tx, {
            entitlementId: entitlement.id,
            command: 'COMPLETE_EXPIRY',
            commandKey: `boundary-complete:${entitlement.id}`,
            correlationId,
            actorType: AddOnEntitlementActorType.SYSTEM,
            reason: 'TRAFFIC_BOUNDARY_EXPIRY',
          });
          if (complete.changed) expired += 1;
        } else if (entitlement.type === AddOnType.EXTRA_DEVICES) {
          // Re-entry for an already EXPIRING row is intentional: transient
          // planning/execution failures remain durably retryable.
          deviceExpiryTriggered = true;
        }
      }

      // Recompute the desired projection only when a baseline term is active;
      // a lapsed subscription (no active term) has nothing to project against —
      // the entitlements are still expired above and any future renewal rebuilds
      // the projection.
      const activeTerm = await tx.subscriptionTerm.findFirst({
        where: { subscriptionId, status: SubscriptionTermStatus.ACTIVE },
        select: { id: true },
      });
      let desiredRevision: bigint | null = null;
      const syncJobIds: string[] = [];
      if (activeTerm !== null) {
        const projection = await this.effectiveProjectionService.recomputeInTransaction(tx, {
          subscriptionId,
          mode: 'ACTIVE',
        });
        desiredRevision = projection.desiredRevision;

        // Propagate the dropped desired limits: mirror them into the limit
        // columns and enqueue a profile-sync push, which sends those columns,
        // so the panel converges to the reduced limit.
        if (projection.changed) {
          const subscription = await tx.subscription.update({
            where: { id: subscriptionId },
            data: {
              trafficLimit:
                projection.desiredTrafficLimitBytes === null
                  ? null
                  : Number(projection.desiredTrafficLimitBytes / GIB_BYTES),
              deviceLimit: projection.desiredDeviceLimit === null ? 0 : projection.desiredDeviceLimit,
            },
            select: { id: true, remnawaveId: true },
          });
          const syncJob = await tx.profileSyncJob.create({
            data: {
              subscriptionId,
              action: subscription.remnawaveId === null ? SyncAction.CREATE : SyncAction.UPDATE,
              status: SyncJobStatus.PENDING,
              aggregateKey: subscriptionId,
              desiredRevision: projection.desiredRevision,
              cause: 'BOUNDARY_EXPIRY',
              payload: { source: 'BOUNDARY_EXPIRY' } as Prisma.InputJsonObject,
            },
            select: { id: true },
          });
          syncJobIds.push(syncJob.id);
        }
      }

      this.logger.log(
        `Boundary expiry for ${subscriptionId}: began ${began}, completed ${expired}`,
      );
      return { began, expired, changed: true, desiredRevision, syncJobIds, deviceExpiryTriggered };
    });
  }

  private retireInTransaction(
    tx: Prisma.TransactionClient,
    subscriptionId: string,
  ): Promise<DurableRetirementResult> {
    return retireDurableRowsInTransaction(
      tx,
      { entitlements: this.addOnEntitlementService, terms: this.subscriptionTermService },
      {
        subscriptionId,
        correlationId: `boundary-deleted:${subscriptionId}`,
        reason: 'SUBSCRIPTION_DELETED',
      },
    );
  }
}
