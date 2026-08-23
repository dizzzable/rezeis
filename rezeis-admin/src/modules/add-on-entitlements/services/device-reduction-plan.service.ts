import { Injectable, Logger } from '@nestjs/common';
import {
  DeviceReductionPlanState,
  EntitlementIncidentKind,
  EntitlementIncidentSeverity,
  Prisma,
  SubscriptionStatus,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { storedIdentityOf } from '../../remnawave/services/panel-user-address';
import { RemnawaveApiService } from '../../remnawave/services/remnawave-api.service';
import {
  assessObservedPanelLink,
  observePanelEra,
} from '../../remnawave/services/stale-panel-link';
import {
  DEVICE_DORMANCY_HORIZON_DAYS,
  DORMANT_RETENTION_CONFLICT,
  DeviceReductionSourceError,
  DeviceRetentionConflictError,
  selectDeviceReductionTargets,
} from '../domain/device-reduction-selection';
// ONE spelling of the refusal across both halves of the saga. The token is
// exported by the execution half because that is where it was first needed;
// importing it rather than re-declaring it is what keeps an operator from
// having to recognise two codes for one fault with one remedy. The import runs
// one way only — the execution service knows nothing about the planner — so it
// adds no cycle.
import { STALE_PANEL_LINK } from './device-reduction-execution.service';

export type DeviceReductionPlanOutcome =
  | { readonly status: 'NOT_APPLICABLE'; readonly reason: string }
  | { readonly status: 'VERIFIED'; readonly projectionRevision: bigint }
  | { readonly status: 'PLANNED'; readonly planId: string; readonly targetCount: number }
  | { readonly status: 'DEFERRED'; readonly reason: string }
  | { readonly status: 'BLOCKED'; readonly reason: string };

/**
 * DeviceReductionPlanService (T-011, planning half)
 * ─────────────────────────────────────────────────
 * When an EXTRA_DEVICES entitlement expires the effective projection's desired
 * device limit drops. If the panel currently binds more HWID devices than the
 * new finite limit, the overage must be reduced — but NEVER by guessing a
 * victim. This service builds a deterministic, immutable removal plan:
 *
 *  1. read the authoritative projection (desired finite limit + revision);
 *  2. observe the panel era ONCE and refuse outright if the stored identity
 *     cannot be trusted to name the right customer on it — a 2.x uuid on a
 *     proven 3.x panel resolves, through the address fallback, to whatever
 *     profile is LIVE at that address, so the device list would be somebody
 *     else's and their hwids would be persisted as this plan's targets;
 *  3. strict-read the panel device list with that same observation
 *     (fail-closed: unavailable → defer, malformed → block, absent profile →
 *     not-applicable);
 *  4. select exact targets deterministically (newest-first, tie hwid DESC) -
 *     which REFUSES rather than answering when the newest-first rule would
 *     delete a device seen recently and keep one dormant for a full billing
 *     period (`DeviceRetentionConflictError`); that refusal blocks here, so no
 *     plan is ever persisted for an operator to approve;
 *  5. persist an immutable {@link DeviceReductionPlan} keyed by
 *     `(subscriptionId, projectionRevision)` — re-planning at the same revision
 *     returns the identical plan (upsert with empty update).
 *
 * It NEVER deletes here. Execution is a separate, flag-gated
 * (`deviceCleanupAuto`) processor so operator-reviewed plans come first.
 *
 * WHY A PLAN DOWNGRADE DOES NOT COME THROUGH HERE.
 * ────────────────────────────────────────────────
 * A customer moving from a 5-device plan to a 2-device plan leaves the same
 * shape of overage this service was built for, so reusing it from the
 * profile-sync limit-change path is the obvious idea. It was considered and
 * rejected, for three reasons, in order of weight:
 *
 *  1. It would not run. Every entry point here reads
 *     `SubscriptionEffectiveProjection`, and that table is EMPTY on every
 *     deployment: `EffectiveProjectionService.recomputeInTransaction` throws
 *     unless the subscription has exactly one ACTIVE `SubscriptionTerm`, and
 *     terms are only created by the `directPurchase`-gated ledger path or by
 *     the manual `scripts/add-on-entitlement-cutover.ts`. Wiring a downgrade in
 *     would produce `NOT_APPLICABLE / NO_PROJECTION` for every subscription
 *     that exists — a branch with tests and no production reach.
 *  2. It would need a different key. The plan's identity is
 *     `(subscriptionId, projectionRevision)` and its guards re-read that
 *     revision before every delete. A downgrade has no revision, so it would
 *     need a second source of desired truth (`Subscription.deviceLimit`) and a
 *     surrogate revision — a redesign of the primary key and the guards, not a
 *     reuse.
 *  3. It should not delete anything anyway. An add-on entitlement EXPIRES —
 *     something the customer bought ran out, and reclaiming the slots is what
 *     they agreed to. A downgrade is the opposite: a deliberate choice, made
 *     now, by a customer who is still a customer, and the cabinet already lets
 *     them pick which devices to drop (`InternalUserDevicesController`) — a
 *     better choice than our newest-first rule, whose newest device after a
 *     downgrade is most likely the one they use every day. (That objection also
 *     applies to the EXPIRY path this service does serve, and is why the
 *     selection now refuses outright when it can see that the device it would
 *     delete is in use and one it would keep is not - see
 *     `DEVICE_DORMANCY_HORIZON_DAYS`.)
 *
 *     An earlier version of this note added that Remnawave refuses a
 *     registration at or over the limit (`USER_HWID_DEVICE_LIMIT_REACHED`), so
 *     the overage "buys them nothing and needs no enforcement from us". DELETED,
 *     because it is false: there are tools and services that bypass the panel's
 *     HWID limit, which is precisely why `SharingDetectors.detectHwidOverage`
 *     exists at all. The three reasons above stand without it; the enforcement
 *     argument never did.
 *
 * So a downgrade leaves the devices alone. What it changes is that
 * `SharingDetectors.detectHwidOverage` stops accusing the customer of sharing
 * for the devices they already held under the old limit — and only for those.
 * Anything beyond that number is still named, at a lower confidence, inside the
 * window as well as outside it; see `HWID_DOWNGRADE_GRACE_DAYS`. An operator who
 * wants slots reclaimed on expiry still turns on `ADDON_DEVICE_CLEANUP_AUTO`
 * and gets exactly the behaviour documented above, unchanged.
 */
@Injectable()
export class DeviceReductionPlanService {
  private readonly logger = new Logger(DeviceReductionPlanService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly remnawaveApiService: RemnawaveApiService,
  ) {}

  public async planForSubscription(subscriptionId: string): Promise<DeviceReductionPlanOutcome> {
    const projection = await this.prismaService.subscriptionEffectiveProjection.findUnique({
      where: { subscriptionId },
      select: { id: true, desiredRevision: true, desiredDeviceLimit: true },
    });
    if (projection === null) {
      return { status: 'NOT_APPLICABLE', reason: 'NO_PROJECTION' };
    }
    // Unlimited desired devices ⇒ nothing can be over the limit.
    if (projection.desiredDeviceLimit === null) {
      return { status: 'NOT_APPLICABLE', reason: 'UNLIMITED_DEVICES' };
    }

    const subscription = await this.prismaService.subscription.findUnique({
      where: { id: subscriptionId },
      // The two supplementary identity columns travel with `remnawaveId`
      // because the row is about to name a profile to the panel. Without them a
      // profile created on 2.x is unaddressable once the operator upgrades to
      // 3.x, and `strictListUserDevices` would answer `unavailable` for a
      // subscription whose devices are sitting right there.
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
      return { status: 'NOT_APPLICABLE', reason: 'NO_PANEL_PROFILE' };
    }
    if (subscription.status === SubscriptionStatus.DELETED) {
      return { status: 'NOT_APPLICABLE', reason: 'SUBSCRIPTION_DELETED' };
    }

    // ── THE STALE-LINK REFUSAL, IN FRONT OF THE BUILD ──────────────────────
    //
    // The execution half refuses to RUN a plan whose stored identity cannot be
    // trusted to name the right customer. That refusal arrives too late for the
    // question this method answers. The strict read below is addressed through
    // the same `panelUserAddress` fallback every other verb uses — numeric fast
    // path → `remnawavePanelId` → the short uuid recovered from `config_url` →
    // `remnawavePanelUsername` — so on a 3.x panel a dead 2.x uuid still
    // resolves to whatever profile is LIVE at that address. The list that comes
    // back is then A DIFFERENT CUSTOMER'S, and every hwid in it is persisted
    // into `selectedDevices` as this subscription's targets.
    //
    // Nothing is deleted — the execution guard sees to that — and the row is
    // still wrong: an operator inspecting it reads a coherent-looking plan about
    // device identifiers that were never this subscriber's, with an approve
    // button beside it offering to act on them.
    //
    // IT REFUSES BEFORE THE READ, NOT AFTER IT. A read destroys nothing, but
    // the hwids ARE the payload: once they are in this process the only thing
    // between them and the row is the decision not to write them, which is a
    // weaker guarantee than never having held them. Refusing here also makes the
    // plan's whole input either this customer's or nothing at all.
    //
    // ONE OBSERVATION, TAKEN ONCE PER PASS AND THEN HANDED ON. `getPanelShape()`
    // caches a FAILURE for fifteen seconds, so two readings taken microseconds
    // apart can legitimately disagree, and the disagreement that hurts runs "the
    // guard saw unknown, so proceed" into "the address builder saw id, so fall
    // back through panelId to whatever is live at that address". So the reading
    // is threaded into the read below rather than left to be taken a second time
    // inside the adapter. `assessObservedPanelLink` is synchronous and pure
    // precisely so it CANNOT reach for the era itself.
    //
    // AFTER THE LOCAL DISQUALIFICATIONS, NOT BEFORE THEM. Every branch above
    // this line is pure database work and most swept subscriptions end on one of
    // them; asking the panel first would add a round trip per swept subscription
    // to answer a question those rows never reach.
    //
    // AND IT PERSISTS NOTHING. There is no `block()` in this half and there
    // should not be: a plan is keyed `(subscriptionId, projectionRevision)` and
    // upserted with an EMPTY `update`, so whatever is written first at a revision
    // is what an operator sees forever. A placeholder written during the stale
    // window would outlive the repair, and the re-plan that should produce the
    // real targets would return IT instead. Persisting nothing leaves the
    // revision usable — the same shape every other refusal here already has.
    //
    // THE FAIL-OPEN IS PRESERVED EXACTLY. `observePanelEra` turns a throw into
    // `'unknown'`, and `'unknown'` is trusted — as is a proven 2.x panel, where a
    // uuid-shaped identity is CORRECT and this population is empty. Version
    // detection fails for the same reasons requests fail, so a refusal keyed on
    // it would fire exactly when the panel is already answering with terminal
    // errors, and planning would BLOCK for an outage that has always DEFERRED.
    const era = await observePanelEra(() => this.remnawaveApiService.getPanelShape());
    if (!assessObservedPanelLink(era, identity.remnawaveId).trusted) {
      this.logger.error(
        `Device reduction planning refused for ${subscriptionId}: its stored 2.x identifier ` +
          'does not name the account it was written for on a 3.x panel, so planning would ' +
          'have selected another customer’s devices as this subscription’s targets. ' +
          'Nothing was read and no plan was written. Run the panel link reconciliation, then ' +
          're-run the boundary.',
      );
      await this.raisePlanningIncident({
        subscriptionId,
        supportRef: `device-reduction-stale-link:${subscriptionId}:${projection.desiredRevision.toString()}`,
        summaryCode: STALE_PANEL_LINK,
        metadata: {
          projectionRevision: projection.desiredRevision.toString(),
          panelEra: era.addressing,
        },
      });
      return { status: 'BLOCKED', reason: STALE_PANEL_LINK };
    }

    const listing = await this.remnawaveApiService.strictListUserDevices(identity, era);
    switch (listing.kind) {
      case 'unavailable':
        return { status: 'DEFERRED', reason: 'PANEL_UNAVAILABLE' };
      case 'notFound':
        // No panel profile to reduce.
        return { status: 'NOT_APPLICABLE', reason: 'PANEL_PROFILE_ABSENT' };
      case 'unsupported':
      case 'invalidContract':
        this.logger.warn(
          `Device reduction blocked for ${subscriptionId}: strict list ${listing.kind}`,
        );
        return { status: 'BLOCKED', reason: `STRICT_LIST_${listing.kind.toUpperCase()}` };
      case 'ok':
        break;
    }

    let selection;
    try {
      selection = selectDeviceReductionTargets(listing.value.devices, projection.desiredDeviceLimit);
    } catch (err: unknown) {
      // Checked BEFORE the source-data refusal, and kept separate from it: this
      // one does not mean the panel sent us something we cannot read, it means
      // we read it fine and the answer was "destroy the phone in their hand".
      // It is one of the two refusals here that only a PERSON can clear — the
      // other being the stale-link guard above, which needs the panel link
      // reconciliation run — and that is why both raise an incident while the
      // panel-integration refusals below do not. See `raisePlanningIncident`.
      if (err instanceof DeviceRetentionConflictError) {
        this.logger.warn(
          `Device reduction refused for ${subscriptionId}: would delete ` +
            `${err.activeTargets.length} device(s) seen within ${DEVICE_DORMANCY_HORIZON_DAYS}d ` +
            `while retaining ${err.dormantRetained.length} dormant one(s)`,
        );
        await this.raisePlanningIncident({
          subscriptionId,
          supportRef: `device-reduction-conflict:${subscriptionId}:${projection.desiredRevision.toString()}`,
          summaryCode: DORMANT_RETENTION_CONFLICT,
          metadata: {
            projectionRevision: projection.desiredRevision.toString(),
            activeTargets: err.activeTargets.length,
            dormantRetained: err.dormantRetained.length,
            dormancyHorizonDays: DEVICE_DORMANCY_HORIZON_DAYS,
          },
        });
        return { status: 'BLOCKED', reason: DORMANT_RETENTION_CONFLICT };
      }
      if (err instanceof DeviceReductionSourceError) {
        this.logger.warn(`Device reduction blocked for ${subscriptionId}: ${err.message}`);
        return { status: 'BLOCKED', reason: 'INVALID_SOURCE_DATA' };
      }
      throw err;
    }

    if (selection.overage === 0) {
      return { status: 'VERIFIED', projectionRevision: projection.desiredRevision };
    }

    // Persist the immutable plan. The unique (subscriptionId, projectionRevision)
    // makes re-planning at the same revision idempotent — the empty `update`
    // preserves the original selected targets.
    const plan = await this.prismaService.deviceReductionPlan.upsert({
      where: {
        subscriptionId_projectionRevision: {
          subscriptionId,
          projectionRevision: projection.desiredRevision,
        },
      },
      update: {},
      create: {
        subscriptionId,
        projectionId: projection.id,
        projectionRevision: projection.desiredRevision,
        desiredLimit: projection.desiredDeviceLimit,
        selectedDevices: selection.targets.map((d) => ({
          hwid: d.hwid,
          createdAt: d.createdAt,
        })) as Prisma.InputJsonValue,
        state: DeviceReductionPlanState.PENDING,
      },
      select: { id: true },
    });

    return { status: 'PLANNED', planId: plan.id, targetCount: selection.targets.length };
  }

  /**
   * Raises the operator-visible incident for a refused PLANNING pass.
   *
   * TWO REFUSALS COME THROUGH HERE and they are the only two that must: a
   * dormancy conflict, where the newest-first rule would delete the phone in
   * the customer's hand, and a stale panel link, where the stored identity
   * cannot be trusted to name the right customer at all. Both are refusals only
   * a PERSON can clear — one by choosing which device goes, the other by
   * running the panel link reconciliation — and the boundary sweep re-enters
   * every five minutes until it reaches a terminal outcome. Without a row the
   * subscription stalls forever in silence. The other BLOCKED outcomes here
   * (`STRICT_LIST_*`, `INVALID_SOURCE_DATA`) describe a panel that is answering
   * badly, which is the integration half of the problem and is already visible
   * where integration health is read.
   *
   * Keyed by `(subscription, revision)` rather than by a plan id, because the
   * whole point is that NO plan was created - the refusal happens before the
   * upsert, so there is nothing for an operator to force. Re-planning at the
   * same revision therefore lands on the same row instead of one incident per
   * tick, and the empty `update` keeps the original timestamp.
   *
   * THE SUPPORT REF NAMES THE CAUSE, NOT JUST THE PAIR. `update: {}` is only
   * safe on a key at least as fine-grained as the fact being recorded: on a
   * coarser key the second cause silently keeps the first cause’s
   * `summaryCode`, which is the exact defect the execution half carried. Two
   * prefixes, two causes, two rows — and a repeat of either is still one row.
   *
   * WARNING, not CRITICAL. Nothing has been destroyed and nothing is broken:
   * the saga stopped exactly where it should and is waiting for a person to say
   * which device goes. That is the same shape as `STILL_OVER_LIMIT`, which is
   * also a WARNING; CRITICAL in this subsystem means the strict adapter refused
   * and the integration itself is unhealthy.
   *
   * Device hwids are NOT written into the metadata - only counts. The inspect
   * view deliberately returns a target COUNT and never raw HWIDs, and an
   * incident is read through that same surface.
   */
  private async raisePlanningIncident(input: {
    readonly subscriptionId: string;
    readonly supportRef: string;
    readonly summaryCode: string;
    readonly metadata: Record<string, unknown>;
  }): Promise<void> {
    await this.prismaService.entitlementIncident.upsert({
      where: { supportRef: input.supportRef },
      update: {},
      create: {
        subscriptionId: input.subscriptionId,
        kind: EntitlementIncidentKind.DEVICE_REDUCTION_BLOCKED,
        severity: EntitlementIncidentSeverity.WARNING,
        supportRef: input.supportRef,
        summaryCode: input.summaryCode,
        metadata: input.metadata as Prisma.InputJsonValue,
      },
    });
  }
}
