import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  AddOnEntitlementActorType,
  EntitlementIncidentState,
  Prisma,
  SyncAction,
  SyncJobStatus,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { ProfileSyncQueueService } from '../../profile-sync/profile-sync-queue.service';
import { GIB_BYTES } from '../domain/cutover-baseline';
import { AddOnEntitlementService } from './add-on-entitlement.service';
import {
  DeviceReductionExecutionService,
  OPERATOR_OVERRIDE_STARTABLE_STATES,
  type DeviceReductionExecutionOutcome,
} from './device-reduction-execution.service';
import { EffectiveProjectionService } from './effective-projection.service';

export interface RemediationActor {
  readonly actorId: string;
  readonly commandKey: string;
  readonly reason: string;
}

/**
 * Where a command key is recorded on the row the command targets.
 *
 * `RemediationCommandDto.commandKey` is documented as an idempotency key —
 * "a replayed request resolves to the same effect". Only `reverse` ever kept
 * that promise, through `AddOnEntitlementEvent`'s
 * `@@unique([entitlementId, commandKey])`. The rest accepted the key and
 * dropped it into the audit log, which no code reads back, so a double-click
 * was a second command.
 *
 * Two of them do have somewhere durable to put it: `EntitlementIncident`
 * and `DeviceReductionPlan` each carry a `jsonb` column on the exact row the
 * command names, so the key can be written by the SAME conditional claim that
 * performs the effect. That is what this constant names.
 *
 * `retryProfileSync` and `forceReconcile` target a SUBSCRIPTION, not a row of
 * their own, and have no such column — their key stays advisory. See the
 * class doc for exactly what a migration would have to add.
 */
const OPERATOR_COMMAND_KEY = 'operatorCommand';

/** Marker written for an acknowledge that actually flipped OPEN → ACKNOWLEDGED. */
const ACKNOWLEDGE_APPLIED = 'ACKNOWLEDGED';

interface RecordedCommand {
  readonly key: string;
  /** Absent while the command is still running — see `approveDevicePlan`. */
  readonly outcome: string | undefined;
}

function asJsonObject(value: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return { ...(value as Record<string, unknown>) };
}

/** The command recorded on a target row, or `null` when none is. */
function readRecordedCommand(metadata: Prisma.JsonValue | null | undefined): RecordedCommand | null {
  const recorded = asJsonObject(metadata)[OPERATOR_COMMAND_KEY];
  if (recorded === null || typeof recorded !== 'object' || Array.isArray(recorded)) return null;
  const fields = recorded as Record<string, unknown>;
  const key = fields['key'];
  if (typeof key !== 'string' || key.length === 0) return null;
  const outcome = fields['outcome'];
  return { key, outcome: typeof outcome === 'string' ? outcome : undefined };
}

/**
 * Flatten an execution outcome for the HTTP layer, keeping the `reason` the
 * refusing variants carry. Without it a decline reaches the controller as a
 * bare status and the operator is told "SKIPPED" with no way to learn why.
 */
function describeExecution(outcome: DeviceReductionExecutionOutcome): {
  readonly status: string;
  readonly reason?: string;
} {
  return 'reason' in outcome
    ? { status: outcome.status, reason: outcome.reason }
    : { status: outcome.status };
}

/** The row's metadata with this command stamped on it — every other key kept. */
function withRecordedCommand(
  metadata: Prisma.JsonValue | null | undefined,
  command: RecordedCommand,
): Prisma.InputJsonObject {
  return {
    ...asJsonObject(metadata),
    [OPERATOR_COMMAND_KEY]: {
      key: command.key,
      ...(command.outcome === undefined ? {} : { outcome: command.outcome }),
    },
  } as Prisma.InputJsonObject;
}

/**
 * AddOnEntitlementRemediationService (T-013)
 * ──────────────────────────────────────────
 * The mutating operator remediation commands over the durable add-on state.
 * Each is idempotent (conditional claims / command keys / already-terminal
 * short-circuits) so a replayed command key is safe. The controller layer
 * gates each command with a distinct least-privilege permission and writes an
 * immutable `AdminAuditLog` (reason + command key + actor). There is NO direct
 * ledger editing — reversal goes through the entitlement state machine.
 *
 * `commandKey` — what it means on each command
 * ────────────────────────────────────────────
 * HONOURED (a replay of the same key produces one effect and the same answer):
 *   • `reverseEntitlement`  — `AddOnEntitlementEvent @@unique([entitlementId, commandKey])`
 *   • `acknowledgeIncident` — recorded on `EntitlementIncident.metadata` by the
 *     same conditional `updateMany` that flips the state
 *   • `approveDevicePlan`   — recorded on `DeviceReductionPlan.postconditionMetadata`,
 *     claimed before execution so a second click cannot start a second
 *     panel-mutating run
 *
 * ADVISORY (audited, NOT deduplicated):
 *   • `retryProfileSync`, `forceReconcile`
 *     Both address a subscription, and no row they touch has a column that
 *     could carry the key: `ProfileSyncJob` has none, `AdminAuditLog` has no
 *     unique constraint to claim against, and `AddOnEntitlementEvent`'s unique
 *     key needs an `entitlementId` these commands do not have. Honouring them
 *     needs a migration this change is not allowed to make: either
 *     `ProfileSyncJob.operatorCommandKey String?` with
 *     `@@unique([subscriptionId, operatorCommandKey])`, or a dedicated
 *     `AddOnRemediationCommand` ledger keyed
 *     `@@unique([subscriptionId, action, commandKey])` holding the recorded
 *     result. Neither command re-applies work on a sequential replay —
 *     `retryProfileSync` only claims jobs still `FAILED` and `forceReconcile`
 *     recomputes under `SELECT … FOR UPDATE` and reports `changed: false` —
 *     but the ANSWER differs between the first call and the replay, so the
 *     key must not be described as honoured.
 */
@Injectable()
export class AddOnEntitlementRemediationService {
  private readonly logger = new Logger(AddOnEntitlementRemediationService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly addOnEntitlementService: AddOnEntitlementService,
    private readonly effectiveProjectionService: EffectiveProjectionService,
    private readonly profileSyncQueueService: ProfileSyncQueueService,
    private readonly deviceReductionExecutionService: DeviceReductionExecutionService,
  ) {}

  /** `run` — reset a subscription's FAILED (non-superseded) sync jobs and re-enqueue. */
  public async retryProfileSync(
    subscriptionId: string,
  ): Promise<{ readonly retried: number; readonly jobIds: readonly string[] }> {
    const failed = await this.prismaService.profileSyncJob.findMany({
      where: { subscriptionId, status: SyncJobStatus.FAILED, supersededAt: null },
      select: { id: true },
      take: 100,
    });
    const jobIds: string[] = [];
    for (const job of failed) {
      const reset = await this.prismaService.profileSyncJob.updateMany({
        where: { id: job.id, status: SyncJobStatus.FAILED, supersededAt: null },
        data: { status: SyncJobStatus.PENDING, attempts: 0, lastError: null },
      });
      if (reset.count === 1) {
        await this.profileSyncQueueService.enqueue(job.id, /* force */ true);
        jobIds.push(job.id);
      }
    }
    return { retried: jobIds.length, jobIds };
  }

  /**
   * `resolve` — recompute the projection and push the latest desired state.
   *
   * This still repairs a genuinely drifted value and is not weakened by the
   * operator-override rule in `../domain/entitlement-baseline.ts`. The add-on
   * share of the mirrored columns is re-derived from the live entitlement
   * ledger on every recompute and is never attributed to the operator, so a
   * column still carrying an expired or reversed entitlement's contribution is
   * pulled back down here exactly as before. What the rule protects is the
   * REMAINDER — the part that disagrees with the subscription's own stored
   * `planSnapshot`, which is what an operator setting a value by hand leaves
   * behind, and which no amount of drift produces on its own.
   */
  public async forceReconcile(
    subscriptionId: string,
  ): Promise<{ readonly changed: boolean; readonly desiredRevision: string | null; readonly syncJobId: string | null }> {
    const result = await this.prismaService.$transaction(async (tx) => {
      const projection = await this.effectiveProjectionService.recomputeInTransaction(tx, {
        subscriptionId,
        mode: 'ACTIVE',
      });
      if (!projection.changed) {
        return { changed: false, desiredRevision: projection.desiredRevision, syncJobId: null as string | null };
      }
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
          cause: 'OPERATOR_FORCE_RECONCILE',
          payload: { source: 'OPERATOR_FORCE_RECONCILE' } as Prisma.InputJsonObject,
        },
        select: { id: true },
      });
      return { changed: true, desiredRevision: projection.desiredRevision, syncJobId: syncJob.id };
    });
    if (result.syncJobId !== null) {
      await this.profileSyncQueueService.enqueue(result.syncJobId, /* force */ true);
    }
    return {
      changed: result.changed,
      desiredRevision: result.desiredRevision.toString(),
      syncJobId: result.syncJobId,
    };
  }

  /**
   * `resolve` — acknowledge an OPEN incident.
   *
   * The state flip was always single-effect (the claim is conditional on
   * `OPEN`), but the ANSWER was not: a replay of the same key reported
   * `changed: false`, which reads as "someone else got there first" and is the
   * opposite of what an idempotency key promises a retrying client. The key is
   * therefore written by the same conditional claim, and a replay is answered
   * from it.
   */
  public async acknowledgeIncident(
    incidentId: string,
    actor: RemediationActor,
  ): Promise<{ readonly changed: boolean }> {
    const incident = await this.prismaService.entitlementIncident.findUnique({
      where: { id: incidentId },
      select: { id: true, metadata: true },
    });
    if (incident === null) throw new NotFoundException('Incident not found');

    const replay = readRecordedCommand(incident.metadata);
    if (replay !== null && replay.key === actor.commandKey) {
      return { changed: replay.outcome === ACKNOWLEDGE_APPLIED };
    }

    const acknowledged = await this.prismaService.entitlementIncident.updateMany({
      where: { id: incidentId, state: EntitlementIncidentState.OPEN },
      data: {
        state: EntitlementIncidentState.ACKNOWLEDGED,
        acknowledgedBy: actor.actorId,
        acknowledgedAt: new Date(),
        metadata: withRecordedCommand(incident.metadata, {
          key: actor.commandKey,
          outcome: ACKNOWLEDGE_APPLIED,
        }),
      },
    });
    if (acknowledged.count === 1) return { changed: true };

    // The claim was lost. Either the incident had already left OPEN, or a
    // concurrent replay of THIS key won it on another connection — re-read so
    // both callers answer the same way instead of racing to opposite answers.
    const settled = await this.prismaService.entitlementIncident.findUnique({
      where: { id: incidentId },
      select: { metadata: true },
    });
    if (settled === null) throw new NotFoundException('Incident not found');
    const winner = readRecordedCommand(settled.metadata);
    if (winner !== null && winner.key === actor.commandKey) {
      return { changed: winner.outcome === ACKNOWLEDGE_APPLIED };
    }
    return { changed: false };
  }

  /** `enforce` — compensating reversal of an entitlement through the state machine. */
  public async reverseEntitlement(
    entitlementId: string,
    actor: RemediationActor,
  ): Promise<{ readonly state: string; readonly changed: boolean }> {
    const entitlement = await this.prismaService.addOnEntitlement.findUnique({
      where: { id: entitlementId },
      select: { subscriptionId: true },
    });
    if (entitlement === null) throw new NotFoundException('Entitlement not found');

    const outcome = await this.prismaService.$transaction(async (tx) => {
      const transition = await this.addOnEntitlementService.transitionInTransaction(tx, {
        entitlementId,
        command: 'REVERSE',
        commandKey: actor.commandKey,
        correlationId: `operator-reverse:${entitlementId}`,
        actorType: AddOnEntitlementActorType.ADMIN,
        actorId: actor.actorId,
        reason: actor.reason,
      });
      let syncJobId: string | null = null;
      if (transition.changed) {
        const projection = await this.effectiveProjectionService.recomputeInTransaction(tx, {
          subscriptionId: entitlement.subscriptionId,
          mode: 'ACTIVE',
        });
        const subscription = await tx.subscription.update({
          where: { id: entitlement.subscriptionId },
          data: {
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
            subscriptionId: entitlement.subscriptionId,
            action: subscription.remnawaveId === null ? SyncAction.CREATE : SyncAction.UPDATE,
            status: SyncJobStatus.PENDING,
            aggregateKey: entitlement.subscriptionId,
            desiredRevision: projection.desiredRevision,
            cause: 'OPERATOR_REVERSAL',
            payload: { source: 'OPERATOR_REVERSAL', entitlementId } as Prisma.InputJsonObject,
          },
          select: { id: true },
        });
        syncJobId = syncJob.id;
      }
      return { state: transition.state, changed: transition.changed, syncJobId };
    });
    if (outcome.syncJobId !== null) {
      await this.profileSyncQueueService.enqueue(outcome.syncJobId, /* force */ true);
    }
    return { state: outcome.state, changed: outcome.changed };
  }

  /**
   * `moderate` — approve + execute a device-reduction plan (operator override).
   *
   * This is the one remediation command whose replay costs something real:
   * `executePlan` accepts a plan that is already `IN_PROGRESS`, so a second
   * click while the first run is still talking to the panel started a SECOND
   * run deleting devices off the same profile. The key is therefore claimed on
   * the plan row before execution, and the outcome written back to it, so a
   * replay is answered from the record instead of re-executing.
   *
   * The claim covers EVERY state the override can start from — it is derived
   * from {@link OPERATOR_OVERRIDE_STARTABLE_STATES} rather than restated, so
   * widening what the executor accepts cannot leave the claim behind. That
   * matters: `BLOCKED` and `REMEDIATION_REQUIRED` are exactly the states an
   * operator reaches this command for, and a claim that only covered `PENDING`
   * would protect the one path nobody uses.
   *
   * `actor` is optional only so an internal caller that has no operator command
   * behind it keeps the previous behaviour; the HTTP route always supplies one.
   * That caller is not unprotected either — `executePlan` takes its own
   * exclusive claim on the override path.
   */
  public async approveDevicePlan(
    planId: string,
    actor?: RemediationActor,
  ): Promise<{ readonly status: string; readonly reason?: string }> {
    if (actor === undefined) {
      return describeExecution(
        await this.deviceReductionExecutionService.executePlan(planId, { force: true }),
      );
    }

    const plan = await this.prismaService.deviceReductionPlan.findUnique({
      where: { id: planId },
      select: { state: true, startedAt: true, postconditionMetadata: true },
    });
    if (plan !== null) {
      const replay = readRecordedCommand(plan.postconditionMetadata);
      if (replay !== null && replay.key === actor.commandKey) {
        return this.replayPlanCommand(replay);
      }
      if (OPERATOR_OVERRIDE_STARTABLE_STATES.includes(plan.state)) {
        // Compare-and-swap on the (state, startedAt) pair the row was READ
        // at. `state` alone cannot carry this: `IN_PROGRESS` is startable, so
        // two callers re-driving the same stalled plan would both match. The
        // claim does NOT move `state` — `executePlan` must still see the real
        // state, or the widened set would never be exercised and this method
        // would be quietly re-implementing the executor's state machine.
        const claimAt = new Date(Math.max(Date.now(), (plan.startedAt?.getTime() ?? 0) + 1));
        const claimed = await this.prismaService.deviceReductionPlan.updateMany({
          where: { id: planId, state: plan.state, startedAt: plan.startedAt ?? null },
          data: {
            startedAt: claimAt,
            postconditionMetadata: withRecordedCommand(plan.postconditionMetadata, {
              key: actor.commandKey,
              outcome: undefined,
            }),
          },
        });
        if (claimed.count === 0) {
          const settled = await this.prismaService.deviceReductionPlan.findUnique({
            where: { id: planId },
            select: { postconditionMetadata: true },
          });
          const winner = readRecordedCommand(settled?.postconditionMetadata);
          if (winner !== null && winner.key === actor.commandKey) {
            return this.replayPlanCommand(winner);
          }
          throw new ConflictException('Device reduction plan is already being remediated');
        }
      }
    }

    const outcome = await this.deviceReductionExecutionService.executePlan(planId, { force: true });
    // A REFUSED outcome changed nothing, so there is nothing to record: a
    // replay re-evaluates and refuses identically, and freezing the refusal
    // under the key would answer a later legitimate retry from a stale record.
    if (outcome.status !== 'REFUSED') {
      await this.recordPlanCommandOutcome(planId, actor.commandKey, outcome.status);
    }
    return describeExecution(outcome);
  }

  /**
   * Answer a replayed approve from the record. A claim with no recorded outcome
   * is a run that has not finished, and the only safe answer is to refuse
   * rather than start a second one.
   */
  private replayPlanCommand(
    recorded: RecordedCommand,
  ): { readonly status: string; readonly reason?: string } {
    if (recorded.outcome === undefined) {
      throw new ConflictException('Remediation command with this key is still in flight');
    }
    return { status: recorded.outcome };
  }

  /**
   * Stamp the finished command back onto the plan. Re-read first: the APPLIED
   * path inside `executePlan` REPLACES `postconditionMetadata` wholesale with
   * its post-condition proof, so merging onto the pre-execution copy would
   * erase it.
   */
  private async recordPlanCommandOutcome(
    planId: string,
    commandKey: string,
    outcome: string,
  ): Promise<void> {
    const plan = await this.prismaService.deviceReductionPlan.findUnique({
      where: { id: planId },
      select: { postconditionMetadata: true },
    });
    if (plan === null) return;
    await this.prismaService.deviceReductionPlan.update({
      where: { id: planId },
      data: {
        postconditionMetadata: withRecordedCommand(plan.postconditionMetadata, {
          key: commandKey,
          outcome,
        }),
      },
    });
  }
}
