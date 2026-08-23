import { Injectable, Logger } from '@nestjs/common';
import {
  DeviceReductionPlanState,
  EntitlementIncidentKind,
  EntitlementIncidentSeverity,
  EntitlementIncidentState,
  Prisma,
  SubscriptionStatus,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { resolveAddOnRolloutFlags } from '../add-on-rollout.config';
import {
  storedIdentityOf,
  type StoredPanelIdentity,
} from '../../remnawave/services/panel-user-address';
import { RemnawaveApiService } from '../../remnawave/services/remnawave-api.service';
import {
  assessObservedPanelLink,
  observePanelEra,
} from '../../remnawave/services/stale-panel-link';
import {
  DORMANT_RETENTION_CONFLICT,
  findDormantRetentionConflict,
} from '../domain/device-reduction-selection';
import { EntitlementBoundaryService } from './entitlement-boundary.service';

export type DeviceReductionExecutionOutcome =
  | { readonly status: 'AUTO_DISABLED' }
  | { readonly status: 'SKIPPED'; readonly reason: string }
  /**
   * An operator override that will NOT be honoured: the plan does not exist,
   * it is in a state no override may run, or another run holds it. Distinct
   * from `SKIPPED` on purpose — the automatic sweep skipping a plan it has
   * nothing to do with is routine, whereas a human command that cannot be
   * carried out needs a straight answer. The HTTP layer maps this to a
   * non-2xx; see `AdminAddOnEntitlementsController.approveDevicePlan`.
   */
  | { readonly status: 'REFUSED'; readonly reason: string }
  | { readonly status: 'APPLIED'; readonly deleted: number }
  | { readonly status: 'DEFERRED'; readonly reason: string }
  | { readonly status: 'BLOCKED'; readonly reason: string }
  | { readonly status: 'SUPERSEDED' }
  | { readonly status: 'REMEDIATION_REQUIRED' };

/**
 * The plan states a run may START from.
 *
 * AUTOMATIC sweep — unchanged: `PENDING` (planned, never run) and
 * `IN_PROGRESS` (a run that did not reach a terminal state: a crash, or a
 * `DEFERRED` panel outage). The sweep deletes devices unattended, so its
 * entry conditions are deliberately narrow.
 *
 * OPERATOR OVERRIDE — adds the two FAILED states, because re-driving them is
 * the entire reason the override exists:
 *   • `BLOCKED` — the strict adapter refused (`STRICT_LIST_*`,
 *     `STRICT_DELETE_*`, `FINAL_*`) and a CRITICAL incident was raised. An
 *     operator fixes the panel-side cause and re-drives.
 *   • `REMEDIATION_REQUIRED` — the planned targets were exhausted and the
 *     profile was still over the limit. The targets are immutable, but the
 *     PANEL is not: once the customer or the operator has removed something,
 *     the same plan can reach its post-condition.
 *
 * Neither list contains `APPLIED` or `SUPERSEDED`, and no `force` flag adds
 * them. `APPLIED` carries a post-condition proved by a strict read-back;
 * re-running it would overwrite that proof and re-enter the completion fence
 * for work already done. `SUPERSEDED` means the plan was built against a
 * world that no longer exists — an advanced projection revision, a deleted
 * subscription, a detached or RELINKED panel profile — and running it is
 * exactly what the relink and revision guards exist to prevent. Those two are
 * refused for every caller.
 *
 * Note this is a list of states a run may BEGIN from, not a claim that the
 * run will proceed: `loadGuard` still re-checks the projection revision, the
 * subscription and the panel identity immediately afterwards and before every
 * single delete.
 */
const AUTO_STARTABLE_STATES: readonly DeviceReductionPlanState[] = [
  DeviceReductionPlanState.PENDING,
  DeviceReductionPlanState.IN_PROGRESS,
];

export const OPERATOR_OVERRIDE_STARTABLE_STATES: readonly DeviceReductionPlanState[] = [
  DeviceReductionPlanState.PENDING,
  DeviceReductionPlanState.IN_PROGRESS,
  DeviceReductionPlanState.BLOCKED,
  DeviceReductionPlanState.REMEDIATION_REQUIRED,
];

interface PlanTarget {
  readonly hwid: string;
  readonly createdAt: string;
}

/**
 * A SECOND non-deleted subscription points at the same panel profile.
 *
 * Not a race and not a relink: a defect in our own data that no read-back can
 * compensate for. `Subscription.remnawaveId` carries an `@@index` and not a
 * `@unique`, and this deployment has rows that share one profile. Each twin
 * gets its own projection, its own revision and - via
 * `@@unique([subscriptionId, projectionRevision])` - its own
 * `DeviceReductionPlan`, so two plans reduce ONE profile and it converges on
 * the lower of the two limits.
 *
 * The final read-back cannot save this. It proves "this profile now holds N
 * devices", which is exactly the post-condition each twin's plan asserts, while
 * being unable to answer the only question that matters here: WHOSE devices
 * these are. Deleting off a profile a second local subscription also owns
 * cannot be made correct by counting, so the saga stops instead.
 */
const PANEL_PROFILE_SHARED = 'PANEL_PROFILE_SHARED';

/**
 * The stored panel identity cannot be trusted to name the right customer.
 *
 * ── WHY THE SAGA NEEDS ITS OWN REFUSAL ───────────────────────────────────────
 *
 * Remnawave 3.x deleted the user `uuid` and re-keyed every user-scoped route on
 * the numeric `id`. `Subscription.remnawaveId` keeps whichever spelling was
 * current when the row was linked and is deliberately never rewritten, so after
 * a 2.x → 3.x upgrade a row linked in the old era holds an identity the panel
 * does not answer to — and that identity does NOT fail closed. `panelUserAddress`
 * falls back (numeric fast path → `remnawavePanelId` → the short uuid recovered
 * from `config_url` → `remnawavePanelUsername`), so a dead 2.x uuid still
 * resolves to whatever profile is LIVE at that address. On the duplicate pairs
 * the old importer produced, that is a paying customer.
 *
 * ── AND WHY IT IS NOT COVERED BY THE THREE THAT ALREADY EXIST ────────────────
 *
 * The three sibling refusals in `stale-panel-link.ts` all stand in front of an
 * operator's or a subscriber's CLICK. THIS PATH HAS NO CLICK. Its targets come
 * from a `DeviceReductionPlan` persisted at some earlier moment, and the comment
 * on the dormancy gate below already states the consequence in the general case:
 * a plan persisted before a rule existed is "one click away from running". So a
 * plan built while the link was healthy can execute later against a link that has
 * since gone stale, and nothing between the two asks again.
 *
 * ── WHY IT IS A `block`, NOT A `DEFERRED` ────────────────────────────────────
 *
 * This service already speaks in two failure vocabularies and the choice between
 * them IS the decision. `{ status: 'DEFERRED', reason: 'PANEL_UNAVAILABLE' }`
 * means "come back later" and raises nothing; `block(...)` means a terminal stop
 * with a named reason and a CRITICAL incident. A STALE LINK IS NOT TRANSIENT: it
 * does not heal by retrying, and only an operator running the panel-link
 * reconciliation clears it. Deferred, the plan would beat forever against a link
 * that cannot come right on its own, and beat SILENTLY, because a deferral raises
 * no incident. Blocked, it stops, an operator is told, and once the
 * reconciliation has rewritten `remnawaveId` the same plan can be re-driven
 * through the override — `BLOCKED` is in {@link OPERATOR_OVERRIDE_STARTABLE_STATES}
 * precisely so that a fixed cause can be re-driven.
 *
 * ── IT IS NOT AN HTTP PRODUCT CODE, AND MUST NOT BE ALLOWLISTED AS ONE ───────
 *
 * Its three siblings are 409 bodies listed in `admin-safe-exception.filter.ts`'s
 * `SAFE_PRODUCT_CODES`, because a client BRANCHES on them. This one is not on a
 * request path at all. `AdminAddOnEntitlementsController.approveDevicePlan`
 * returns `BLOCKED` as a 200 BODY (`{ status, reason }`) and throws only on
 * `REFUSED`, and `AdminSafeExceptionFilter` shapes EXCEPTIONS — a 200 never
 * passes through it. An entry in that allowlist would be dead configuration
 * wearing the appearance of a wire contract. Where this token actually reaches a
 * person is the `summaryCode` on the CRITICAL incident (rendered verbatim by
 * `add-on-entitlement-inspector.tsx`), the `reason` on the 200 body, the
 * `declineReason` on the `AdminAuditLog` row, and `lastErrorCode` on the plan.
 *
 * SPELLED TO ECHO THE THREE SIBLING CODES rather than to join the
 * `PANEL_PROFILE_*` family above it. Those three mean the profile MOVED, is
 * SHARED, or is GONE; this one means the stored id is from the wrong ERA, which
 * is a different fact needing a different remedy.
 */
export const STALE_PANEL_LINK = 'STALE_PANEL_LINK';

/**
 * Supersede reasons that mean something is WRONG rather than that the world
 * moved on.
 *
 * The ordinary reasons - a relink, an advanced revision, a deleted subscription
 * - are routine outcomes of a plan built a moment too early, and raising an
 * incident for each would bury the operator in noise. These are not: they mean
 * the saga found a state that should not exist and needs a person.
 */
const INCIDENT_WORTHY_SUPERSEDE: ReadonlySet<string> = new Set([PANEL_PROFILE_SHARED]);

type Guard =
  | { readonly kind: 'ok'; readonly identity: StoredPanelIdentity; readonly desiredLimit: number }
  | { readonly kind: 'superseded'; readonly reason: string };

/**
 * DeviceReductionExecutionService (T-011, execution half)
 * ───────────────────────────────────────────────────────
 * Executes a persisted, immutable {@link DeviceReductionPlan} with the strict
 * adapter — the ONLY component that deletes HWID devices. It is dormant unless
 * the `deviceCleanupAuto` rollout flag is on (operator-reviewed plans first).
 *
 * Safety (design D-7):
 *  - fail-closed guards BEFORE and BEFORE-EACH delete: subscription not
 *    deleted, projection revision not superseded, desired limit still finite;
 *  - strict-list read-back each pass so we never delete more than the current
 *    overage, and a concurrent user change converges instead of over-deleting;
 *  - a planned target already absent is a no-op (idempotent), never a re-delete
 *    of a different victim;
 *  - transient panel failure → DEFERRED (retry); malformed/unsupported →
 *    BLOCKED + incident; still-over after targets exhausted →
 *    REMEDIATION_REQUIRED + incident.
 */
@Injectable()
export class DeviceReductionExecutionService {
  private readonly logger = new Logger(DeviceReductionExecutionService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly remnawaveApiService: RemnawaveApiService,
    private readonly entitlementBoundaryService: EntitlementBoundaryService,
  ) {}

  /**
   * `options.force` is the OPERATOR OVERRIDE channel, not merely a flag
   * bypass. It has always skipped the `deviceCleanupAuto` rollout gate; it now
   * also widens the startable states (see
   * {@link OPERATOR_OVERRIDE_STARTABLE_STATES}) and takes the start as an
   * exclusive claim, because an override is driven by a human clicking a
   * button and two clicks must not become two concurrent runs deleting the
   * same customer's devices.
   */
  public async executePlan(
    planId: string,
    options: { readonly force?: boolean } = {},
  ): Promise<DeviceReductionExecutionOutcome> {
    const override = options.force === true;
    if (!override && !resolveAddOnRolloutFlags().deviceCleanupAuto) {
      return { status: 'AUTO_DISABLED' };
    }

    const plan = await this.prismaService.deviceReductionPlan.findUnique({ where: { id: planId } });
    if (plan === null) {
      return decline(override, 'PLAN_NOT_FOUND');
    }
    const startable = override ? OPERATOR_OVERRIDE_STARTABLE_STATES : AUTO_STARTABLE_STATES;
    if (!startable.includes(plan.state)) {
      return decline(override, `PLAN_STATE_${plan.state}`);
    }

    const guard = await this.loadGuard(plan.subscriptionId, plan.projectionRevision);
    if (guard.kind === 'superseded') {
      return this.supersede(plan.subscriptionId, planId, guard.reason);
    }

    if (override) {
      // Compare-and-swap on the pair this row was READ at. `state` alone is
      // not enough: `IN_PROGRESS` is startable, so two callers re-driving the
      // same stalled plan would both match a state-only guard and both start
      // deleting. `startedAt` is forced to advance strictly, so the second
      // caller's `where` cannot match the row the first one just moved —
      // whatever state it was in.
      const startedAt = new Date(Math.max(Date.now(), (plan.startedAt?.getTime() ?? 0) + 1));
      const claimed = await this.prismaService.deviceReductionPlan.updateMany({
        where: { id: planId, state: plan.state, startedAt: plan.startedAt ?? null },
        data: {
          state: DeviceReductionPlanState.IN_PROGRESS,
          startedAt,
          attempts: { increment: 1 },
        },
      });
      if (claimed.count !== 1) {
        return { status: 'REFUSED', reason: 'PLAN_ALREADY_RUNNING' };
      }
    } else {
      await this.prismaService.deviceReductionPlan.update({
        where: { id: planId },
        data: {
          state: DeviceReductionPlanState.IN_PROGRESS,
          startedAt: new Date(),
          attempts: { increment: 1 },
        },
      });
    }

    const targets = readTargets(plan.selectedDevices);
    const { identity } = guard;

    // ── THE STALE-LINK REFUSAL, IN FRONT OF THE ENTIRE EXECUTION ───────────
    //
    // ONE OBSERVATION FOR THE WHOLE PLAN, and deliberately not one per target.
    // The identity every panel call in this run is addressed from is the
    // SUBSCRIPTION'S — `identity` above, fixed for the run and re-checked for a
    // relink on every pass — so the era question has exactly one answer here.
    // Asking it per target would buy nothing and cost the one thing that
    // matters: `getPanelShape()` caches a FAILURE for fifteen seconds, so two
    // readings taken microseconds apart can legitimately disagree, and the
    // disagreement that hurts runs "the guard saw 'unknown', so proceed" into
    // "the builder saw 'id', so fall back through panelId to whatever is live
    // at that address". `assessObservedPanelLink` is synchronous and pure
    // precisely so it CANNOT reach for the era itself.
    //
    // IT COVERS THE READS AS WELL AS THE DELETES, which is why it stands here
    // rather than immediately above `strictDeleteUserDevice`. A read against
    // the wrong profile destroys nothing, but every decision in the loop below
    // is made FROM that read: whether the target is still present, whether the
    // overage is already gone, and whether the dormancy gate fires — all of
    // them would be answered about somebody else's device list. The final
    // read-back is worse still: it is the PROOF the plan writes into
    // `postconditionMetadata` before marking itself APPLIED, so a read off the
    // wrong profile would let a plan certify a limit it never applied. One
    // guard in front of all of it makes "which profile was this run about?" a
    // question with a single answer.
    //
    // AFTER THE CLAIM, NOT BEFORE IT. Every other terminal outcome in this
    // method is reached by a run that owns the plan, and `block(...)` writes a
    // terminal state; writing one to a plan this run did not claim would hand
    // two concurrent overrides the same licence the compare-and-swap above
    // exists to withhold. It still precedes every panel call, which is the
    // property that matters.
    //
    // THE FAIL-OPEN IS PRESERVED EXACTLY, and it matters more here than on the
    // three sibling guards. An unreadable era is TRUSTED: version detection
    // fails for the same reasons requests fail — an unreachable panel, an
    // expired token, a panel mid-restart — so a refusal keyed on it would fire
    // exactly when the panel is already answering with terminal errors. On the
    // HTTP verbs that would cost one button; here it is a TERMINAL block with a
    // CRITICAL incident, so a single auth blip would convert every in-flight
    // reduction plan into an operator ticket. `observePanelEra` turns a throw
    // into `'unknown'`, and `'unknown'` proceeds — as does a proven 2.x panel,
    // where a uuid-shaped identity is CORRECT and this population is empty.
    const era = await observePanelEra(() => this.remnawaveApiService.getPanelShape());
    if (!assessObservedPanelLink(era, identity.remnawaveId).trusted) {
      this.logger.error(
        `Device reduction plan ${planId} refused for subscription ${plan.subscriptionId}: its ` +
          'stored 2.x identifier does not name the account it was written for on a 3.x panel, so ' +
          'reducing would have unbound a device belonging to somebody else. Nothing was read and ' +
          'nothing was deleted. Run the panel link reconciliation, then re-drive this plan.',
      );
      return this.block(plan.subscriptionId, planId, STALE_PANEL_LINK);
    }

    let deleted = 0;

    for (const target of targets) {
      // Re-guard cheaply before every delete: a concurrent renewal/upgrade or
      // deletion must abort the saga rather than delete against a stale plan.
      const reguard = await this.loadGuard(plan.subscriptionId, plan.projectionRevision);
      if (reguard.kind === 'superseded') {
        return this.supersede(plan.subscriptionId, planId, reguard.reason);
      }
      // The re-guard catches a deleted subscription, an advanced revision, a
      // relaxed limit and a DETACHED profile — but not a profile RELINKED to a
      // different one, which `loadGuard` reports as a perfectly healthy `ok`
      // carrying a new identity. Without this check the loop would keep
      // deleting devices off the profile the plan was built against while the
      // subscription points somewhere else: the wrong profile loses devices,
      // and the read-back then blesses a limit that was never applied to the
      // live one. Comparing the stored id is enough — that is the field a
      // relink writes; the two supplementary columns only describe it.
      if (reguard.identity.remnawaveId !== identity.remnawaveId) {
        return this.supersede(plan.subscriptionId, planId, 'PANEL_PROFILE_RELINKED');
      }
      const desiredLimit = reguard.desiredLimit;

      // The SAME observation the guard above decided on, handed to the adapter
      // rather than left for it to take again. Two independent readings can
      // legitimately disagree across the fifteen-second failure cache, and this
      // is the read every decision in this loop is made FROM.
      const listing = await this.remnawaveApiService.strictListUserDevices(identity, era);
      if (listing.kind === 'unavailable') {
        return { status: 'DEFERRED', reason: 'PANEL_UNAVAILABLE' };
      }
      if (listing.kind === 'notFound') {
        return this.supersede(plan.subscriptionId, planId, 'PANEL_PROFILE_ABSENT');
      }
      if (listing.kind !== 'ok') {
        return this.block(plan.subscriptionId, planId, `STRICT_LIST_${listing.kind.toUpperCase()}`);
      }

      // Never delete beyond the current overage — converge if a concurrent
      // change already brought the device count within the limit.
      if (listing.value.total - desiredLimit <= 0) {
        break;
      }
      const present = listing.value.devices.some((d) => d.hwid === target.hwid);
      if (!present) {
        // Already gone (read-back proved absence) — idempotent, no re-delete.
        continue;
      }

      // THE LAST GATE BEFORE DESTRUCTION. The plan's targets are immutable and
      // were chosen when it was built - possibly by a build that predates the
      // dormancy rule, and certainly against a device list that is now older
      // than the one just read. Re-deciding the victim here would break the
      // immutability the whole saga rests on, but REFUSING does not, so the
      // same invariant the planner enforces is re-checked against the live list
      // and stops the delete rather than re-choosing it.
      //
      // This is the gate that covers the operator override: `force: true`
      // bypasses the `deviceCleanupAuto` flag entirely, so a plan persisted
      // before this rule existed is one click away from running. It is checked
      // AFTER the presence test so a target that is already gone cannot raise a
      // conflict about a delete that will not happen; targets still present are
      // covered on this pass or the next.
      const conflict = findDormantRetentionConflict(
        listing.value.devices,
        new Set(targets.map((t) => t.hwid)),
        Date.now(),
      );
      if (conflict !== null) {
        return this.block(plan.subscriptionId, planId, DORMANT_RETENTION_CONFLICT);
      }

      // THE OBSERVATION TRAVELS INTO THE DELETE, and the parameter is REQUIRED
      // on that method so it cannot be otherwise. Until it was, this service
      // held one reading and the adapter took a second one microseconds later:
      // the guard could see `unknown` (fail-open, proceed) while the adapter saw
      // `'id'`, took the `'id'` branch, and resolved the dead uuid through
      // `remnawavePanelId` to whatever profile is LIVE at that address. That
      // window is now closed by the type system rather than by convention.
      const del = await this.remnawaveApiService.strictDeleteUserDevice(
        identity,
        target.hwid,
        era,
      );
      if (del.kind === 'unavailable') {
        return { status: 'DEFERRED', reason: 'PANEL_UNAVAILABLE' };
      }
      if (del.kind === 'notFound') {
        // Raced to absent between list and delete — a later read-back confirms.
        continue;
      }
      if (del.kind !== 'ok') {
        return this.block(plan.subscriptionId, planId, `STRICT_DELETE_${del.kind.toUpperCase()}`);
      }
      deleted += 1;
    }

    // Final strict read-back proves the post-condition — from the same era
    // observation as everything above it, because this read is the PROOF written
    // into `postconditionMetadata`. Taken against a different reading it could
    // certify a limit that was never applied to the profile this run was about.
    const final = await this.remnawaveApiService.strictListUserDevices(identity, era);
    if (final.kind === 'unavailable') {
      return { status: 'DEFERRED', reason: 'PANEL_UNAVAILABLE' };
    }
    if (final.kind !== 'ok') {
      return this.block(plan.subscriptionId, planId, `FINAL_${final.kind.toUpperCase()}`);
    }

    if (final.value.total <= guard.desiredLimit) {
      const applied = await this.prismaService.$transaction(async (tx) => {
        const completion = await this.entitlementBoundaryService.completeVerifiedDeviceExpiryInTransaction(
          tx,
          plan.subscriptionId,
          plan.projectionRevision,
        );
        if (completion.status === 'SUPERSEDED') return false;

        await tx.deviceReductionPlan.update({
          where: { id: planId },
          data: {
            state: DeviceReductionPlanState.APPLIED,
            completedAt: new Date(),
            postconditionMetadata: {
              finalCount: final.value.total,
              deleted,
              desiredLimit: guard.desiredLimit,
            } as Prisma.InputJsonValue,
          },
        });
        return true;
      });
      if (!applied) {
        return this.supersede(plan.subscriptionId, planId, 'REVISION_ADVANCED');
      }
      return { status: 'APPLIED', deleted };
    }

    // Targets exhausted but still over the limit → operator remediation.
    await this.markState(planId, DeviceReductionPlanState.REMEDIATION_REQUIRED, 'STILL_OVER_LIMIT');
    await this.raiseIncident(
      plan.subscriptionId,
      planId,
      'STILL_OVER_LIMIT',
      EntitlementIncidentSeverity.WARNING,
    );
    return { status: 'REMEDIATION_REQUIRED' };
  }

  private async loadGuard(subscriptionId: string, planRevision: bigint): Promise<Guard> {
    const projection = await this.prismaService.subscriptionEffectiveProjection.findUnique({
      where: { subscriptionId },
      select: { desiredRevision: true, desiredDeviceLimit: true },
    });
    if (projection === null) return { kind: 'superseded', reason: 'NO_PROJECTION' };
    if (projection.desiredRevision !== planRevision) {
      return { kind: 'superseded', reason: 'REVISION_ADVANCED' };
    }
    if (projection.desiredDeviceLimit === null) {
      return { kind: 'superseded', reason: 'LIMIT_RELAXED_UNLIMITED' };
    }
    const subscription = await this.prismaService.subscription.findUnique({
      where: { id: subscriptionId },
      // Re-read per guard pass, supplementary columns included: every delete in
      // the loop below is addressed from this row, and a profile created on 2.x
      // on a panel since upgraded to 3.x can only be named by the recorded
      // numeric id or panel username. Without them the strict calls answer
      // `unavailable`, which defers the saga forever instead of reclaiming the
      // slots the customer stopped paying for.
      select: {
        remnawaveId: true,
        remnawavePanelId: true,
        remnawavePanelUsername: true,
        configUrl: true,
        status: true,
      },
    });
    const identity = storedIdentityOf(subscription);
    if (subscription === null || identity === null) {
      return { kind: 'superseded', reason: 'NO_PANEL_PROFILE' };
    }
    if (subscription.status === SubscriptionStatus.DELETED) {
      return { kind: 'superseded', reason: 'SUBSCRIPTION_DELETED' };
    }
    // A SIBLING subscription on the same panel profile, treated exactly as a
    // relink is: superseded, nothing deleted. The relink check above asks "is
    // this still OUR profile?" and answers yes here - the row did not move. The
    // question it cannot ask is whether the profile is ALSO somebody else's,
    // and `remnawaveId` carries only an `@@index`, so it can be.
    //
    // Read per guard pass rather than once, for the same reason the identity is
    // re-read per pass: a twin can be created by a sync or an import while the
    // loop is running, and every pass is a fresh licence to delete.
    //
    // `status` and not `state`: DELETED subscriptions are excluded because a
    // dead row's claim on a profile is not a claim. Everything else counts,
    // including EXPIRED - an expired twin still owns its devices, and a limit
    // reduction driven by our subscription must not reach them.
    const sibling = await this.prismaService.subscription.findFirst({
      where: {
        id: { not: subscriptionId },
        remnawaveId: identity.remnawaveId,
        status: { not: SubscriptionStatus.DELETED },
      },
      select: { id: true },
    });
    if (sibling !== null) {
      this.logger.warn(
        `Device reduction superseded for ${subscriptionId}: panel profile ` +
          `${identity.remnawaveId} is also owned by subscription ${sibling.id}`,
      );
      return { kind: 'superseded', reason: PANEL_PROFILE_SHARED };
    }
    return { kind: 'ok', identity, desiredLimit: projection.desiredDeviceLimit };
  }

  /**
   * Marks a plan SUPERSEDED, and raises an incident when the reason is one an
   * operator has to see.
   *
   * Every supersede in this service goes through here so the two kinds cannot
   * be confused: a relink or a revision bump is a plan that lost a race and
   * stays silent, while {@link PANEL_PROFILE_SHARED} is a data defect that
   * silently existed until a destructive saga tripped over it.
   *
   * CRITICAL, unlike the planner's refusal: that one stops before anything
   * exists, this one means a plan was built, approved or swept, and started
   * running against a profile whose devices may belong to another customer.
   */
  private async supersede(
    subscriptionId: string,
    planId: string,
    reason: string,
  ): Promise<DeviceReductionExecutionOutcome> {
    await this.markState(planId, DeviceReductionPlanState.SUPERSEDED, reason);
    if (INCIDENT_WORTHY_SUPERSEDE.has(reason)) {
      await this.raiseIncident(subscriptionId, planId, reason, EntitlementIncidentSeverity.CRITICAL);
    }
    return { status: 'SUPERSEDED' };
  }

  private async markState(
    planId: string,
    state: DeviceReductionPlanState,
    lastErrorCode?: string,
  ): Promise<void> {
    await this.prismaService.deviceReductionPlan.update({
      where: { id: planId },
      data: { state, ...(lastErrorCode !== undefined ? { lastErrorCode } : {}) },
    });
  }

  private async block(
    subscriptionId: string,
    planId: string,
    reason: string,
  ): Promise<DeviceReductionExecutionOutcome> {
    this.logger.warn(`Device reduction plan ${planId} blocked: ${reason}`);
    await this.markState(planId, DeviceReductionPlanState.BLOCKED, reason);
    await this.raiseIncident(subscriptionId, planId, reason, EntitlementIncidentSeverity.CRITICAL);
    return { status: 'BLOCKED', reason };
  }

  /**
   * The operator-visible record of why this plan stopped.
   *
   * ── THE KEY NAMES THE CAUSE, NOT ONLY THE PLAN ────────────────────────────
   *
   * It used to be `device-reduction:${planId}` with an empty `update`, and that
   * pair is a defect whenever the key is COARSER than the fact being recorded.
   * Re-driving a BLOCKED plan is the intended workflow — `BLOCKED` is in
   * {@link OPERATOR_OVERRIDE_STARTABLE_STATES} exactly so an operator can fix
   * the cause and click approve again — so a plan blocked first for a malformed
   * device list and then, once the panel was answering, for a stale panel link
   * kept the FIRST `summaryCode` forever. `summaryCode` is what
   * `AddOnEntitlementInspectionService` surfaces and what the SPA renders
   * verbatim, so the operator was told to go and fix the thing they had
   * already fixed.
   *
   * ── WHY A SECOND ROW RATHER THAN A REWRITTEN ONE ──────────────────────────
   *
   * An `EntitlementIncident` is a UNIT OF OPERATOR WORK, not a log line: it
   * carries `state`, `acknowledgedBy/At`, `resolvedBy/At` and `resolutionCode`.
   * Rewriting `summaryCode` in place would leave a person’s acknowledgement
   * attached to a cause they never saw — and because the SPA offers its
   * acknowledge control only while `state === OPEN`, a new cause landing on an
   * already-acknowledged row would arrive looking handled. The one other
   * incident writer in this module states the same view from the other side:
   * `AddOnEntitlementService` treats a support ref already bound to a different
   * `summaryCode` as a CONFLICT rather than as something to overwrite.
   *
   * Nothing reads this string — it is a uniqueness key, never parsed, and the
   * inspection payload does not even select it — so refining it costs no reader
   * and changes no contract. What an operator sees afterwards is the newest
   * cause FIRST, because the inspection query already orders `createdAt desc`,
   * with the earlier cause still below it in whatever state they left it.
   *
   * ── AND THE SAME CAUSE, TWICE ─────────────────────────────────────────────
   *
   * Still ONE row: that idempotence is what the empty `update` was protecting
   * and it is kept, because the automatic sweep re-runs `PENDING`/`IN_PROGRESS`
   * plans and must not mint an incident per tick. But the empty update had a
   * second edge — it left a RESOLVED row RESOLVED, so a fresh occurrence raised
   * nothing an operator could see at all. A repeat here is never an unattended
   * retry of a blocked plan (`BLOCKED` is not in `AUTO_STARTABLE_STATES`); it is
   * a person having tried the remedy and watched it fail. That is news, so the
   * row REOPENS and its stale resolution is cleared. `acknowledgedBy/At` are
   * left alone: who looked at it is history, not a claim about the present.
   */
  private async raiseIncident(
    subscriptionId: string,
    planId: string,
    summaryCode: string,
    severity: EntitlementIncidentSeverity,
  ): Promise<void> {
    const supportRef = `device-reduction:${planId}:${summaryCode}`;
    await this.prismaService.entitlementIncident.upsert({
      where: { supportRef },
      update: {
        state: EntitlementIncidentState.OPEN,
        resolvedBy: null,
        resolvedAt: null,
        resolutionCode: null,
      },
      create: {
        subscriptionId,
        kind: EntitlementIncidentKind.DEVICE_REDUCTION_BLOCKED,
        severity,
        supportRef,
        summaryCode,
        metadata: { planId } as Prisma.InputJsonValue,
      },
    });
  }
}

/**
 * How a decline is reported. The automatic sweep's `SKIPPED` is unchanged —
 * it runs over plans it may have nothing to do with and a skip is routine.
 * An override was asked for by a person, so it gets `REFUSED` and the caller
 * can turn that into a non-2xx instead of a 200 that quietly did nothing.
 */
function decline(override: boolean, reason: string): DeviceReductionExecutionOutcome {
  return override ? { status: 'REFUSED', reason } : { status: 'SKIPPED', reason };
}

function readTargets(selectedDevices: unknown): PlanTarget[] {
  if (!Array.isArray(selectedDevices)) return [];
  const out: PlanTarget[] = [];
  for (const raw of selectedDevices) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const hwid = typeof r['hwid'] === 'string' ? r['hwid'] : '';
    const createdAt = typeof r['createdAt'] === 'string' ? r['createdAt'] : '';
    if (hwid.length > 0) out.push({ hwid, createdAt });
  }
  return out;
}
