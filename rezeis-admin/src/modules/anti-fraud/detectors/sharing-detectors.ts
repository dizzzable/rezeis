import { Injectable, Logger } from '@nestjs/common';
import { FraudSignalSeverity } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { describeStrictOutcome } from '../../remnawave/interfaces/remnawave-strict-outcome.interface';
import { RemnawaveApiService } from '../../remnawave/services/remnawave-api.service';
import { panelIdentityLookup } from '../../remnawave/services/panel-user-address';
import {
  PanelDevicesClient,
  type PanelDevicesOutcome,
} from '../../remnawave/services/panel-devices.client';
import {
  PanelInfraClient,
  type PanelNode,
  type PanelReadOutcome,
} from '../../remnawave/services/panel-infra.client';
import { computeConfidence, ratioStrength } from '../confidence.util';
import { FraudSignalCandidate } from '../interfaces/fraud-signal.interface';
import { SharingDetectionConfig } from '../sharing-detection.config';
import { AntiFraudTunablesService } from '../services/anti-fraud-tunables.service';
import {
  countDistinctNetworks,
  isNetworkSharingOffender,
  parsePanelId,
  selectConcurrentSamples,
} from '../sharing-detection.util';
import type { NodeFlapEvidence } from './remnawave-detectors';

/**
 * Subscription-sharing detectors backed by the Remnawave panel.
 *
 * Three complementary signals:
 *   - HWID over-limit: a user has more *registered devices* than their plan's
 *     `hwidDeviceLimit` (cheap, uses the top-users endpoint).
 *   - Cross-account device: one hwid is bound to the profiles of two or more
 *     DIFFERENT customers (the whole-inventory endpoint). Asks about a
 *     RELATION between accounts; the two either side of it ask about one
 *     account measured against its own plan.
 *   - Concurrent-IP: a user is connected from more *distinct networks* than
 *     their device limit, at the same time (the `/api/connections/*` family
 *     behind the panel's own "Active sessions" view).
 *
 * Both resolve the Remnawave user to a rezeis user id (via
 * `Subscription.remnawaveId`) for deep-linking, and fail soft so a panel
 * outage never aborts the cron detector batch.
 *
 * ── THE PANEL IS 3.x, AND THAT DELETED THREE THINGS FROM THIS FILE ─────────
 *
 * 1. `/api/ip-control/*`. It was the 2.x spelling of the live-connection
 *    family and panel 3.3.x does not serve it, so nothing here chooses between
 *    families any more. A 2.x panel is turned away ONCE, centrally, by
 *    `LegacyPanelRefusal` in `panel-transport.ts`; a second opinion at this
 *    call site is how the old code ended up with nine sites that each guessed
 *    differently about an unknown version.
 * 2. The `RemnawaveVersionService` capability gate. `liveIpControl` /
 *    `connectionsApi` existed to tell 2.7 from 2.8 from 3.x, and this build
 *    serves only the last of those. Worse, the gate answered "stand down" for
 *    an UNKNOWN version, which is the state every healthy panel passes through
 *    during a blip — so the detector went quiet exactly when the panel was
 *    already struggling, and quiet here reads as a clean panel.
 * 3. The `immature_ip_control` blindness classification, which described a
 *    2.x build this build no longer talks to at all.
 *
 * What replaces all three is not another gate: blindness is now READ OFF THE
 * ANSWER. `PanelDevicesClient` and `PanelInfraClient` report "we could not
 * look" as a distinct outcome, so the detector no longer has to infer from a
 * version number whether the silence it is holding means anything.
 *
 * ── WHY `RemnawaveApiService` IS STILL HERE, FOR ONE CALL ──────────────────
 * `strictGetAllPanelUsers()`. Both detectors need every subscriber's
 * `hwidDeviceLimit`, and that is a WHOLE-PANEL walk — keyset-paged, refusing a
 * page it never received, believing an empty answer only when the panel
 * confirms `total: 0`. `PanelUsersClient` deliberately serves ONE page and
 * says so: whether a short read may be treated as the whole panel is a
 * judgement about what the caller does with a miss, not about HTTP. Copying
 * that walk into a detector would be a second implementation of the most
 * identity-sensitive read in the integration, free to drift from the first —
 * so the call stays until the users/imports migration lands one walk that both
 * sides can share.
 *
 * WHAT "AT THE SAME TIME" MEANS HERE, and why it is the whole design.
 * The panel gives one fact per connection: `{ ip, lastSeen }`. There are no
 * connect/disconnect times, so nothing can be intersected and simultaneity has
 * to be inferred. The detector originally inferred it from membership in a
 * 10-minute lookback, which is not simultaneity at all — one phone leaving the
 * house counted as two networks, and after a node bounce every user on the
 * panel counted as several. Three gates now separate "was seen recently" from
 * "was in use together":
 *
 *   1. staleness  — `ipWindowMinutes` evicts samples older than the lookback,
 *      as before;
 *   2. concurrency — `ipConcurrencyWindowSeconds` keeps only the samples close
 *      in time to that user's OWN most recent sighting, so sequential network
 *      switching collapses to one network while two people online right now
 *      still present two;
 *   3. stability  — a node connect/disconnect anywhere on the panel inside
 *      {@link NODE_STABILITY_WINDOW_MINUTES} suppresses the run entirely,
 *      because a reconnect storm IS a burst of new source IPs and it is ours,
 *      not the customer's.
 *
 * Then the surviving IPs are grouped into networks (per address family, so a
 * dual-stack device is one network rather than two) and compared against the
 * device limit plus a tolerance margin.
 */
@Injectable()
export class SharingDetectors {
  private readonly logger = new Logger(SharingDetectors.name);

  /** True while the concurrent-IP detector is suppressed by node instability. */
  private nodeFlapSuppressionActive = false;

  /**
   * True once the HWID top-users read has failed, and until it answers again —
   * the latch behind the transition-only WARN in {@link detectHwidOverage}.
   *
   * Same shape and same reason as `RemnawaveDetectors.perUserTrafficBlind`:
   * process-local, deliberately not persisted, and a restart re-announcing a
   * still-blind detector once is the useful direction to be wrong in.
   */
  private hwidTopUsersBlind = false;

  /**
   * The same latch for the whole-inventory read behind
   * {@link detectSharedHwidAcrossAccounts}. Separate from
   * {@link hwidTopUsersBlind} because they are different endpoints: the
   * top-users list can answer perfectly well while the inventory walk is
   * failing, and one latch would let the recovery of either announce the
   * recovery of both.
   */
  private sharedHwidBlind = false;

  /**
   * Which blindness the concurrent-IP detector last announced, or `null` while
   * it can actually see. Keyed by REASON rather than a bare boolean so a run
   * that goes blind for a NEW reason (the node list stopped answering after the
   * user list had already been failing) announces the new one instead of
   * staying quiet under a stale latch.
   */
  private concurrentIpBlindReason: LiveConnectionBlindness['reason'] | null = null;

  public constructor(
    private readonly prismaService: PrismaService,
    /** The whole-panel user walk, and nothing else — see the class header. */
    private readonly remnawaveApiService: RemnawaveApiService,
    private readonly devicesClient: PanelDevicesClient,
    private readonly infraClient: PanelInfraClient,
    private readonly tunablesService: AntiFraudTunablesService,
  ) {}

  /**
   * Effective sharing tunables for this run: the operator's panel value, else
   * the `ANTIFRAUD_SHARING_*` env var, else the built-in default.
   *
   * Resolved once per detector, OUTSIDE the try/catch below and deliberately so.
   * If the settings row is unreadable this rejects, `runDetectors` records the
   * detector as having observed nothing, and no signal is raised OR auto-resolved
   * on the strength of a guess. Falling back to env here would silently re-enable
   * a detector an operator had switched off.
   */
  private async resolveConfig(): Promise<SharingDetectionConfig> {
    return (await this.tunablesService.resolve()).sharing;
  }

  // ── Detector: HWID device over-limit ───────────────────────────────────

  /**
   * A user has more REGISTERED HWID records than their plan's device limit.
   *
   * `devicesCount` counts registered devices, not concurrent sessions, and the
   * panel keeps a registered device forever: `hwidDeviceLimit` is pushed to
   * Remnawave by `profile-sync.processor.ts` whenever the subscription's limit
   * changes, and nothing on that path deletes the now-surplus rows. (The only
   * component that deletes HWID devices is `DeviceReductionExecutionService`,
   * reached solely from `EntitlementBoundaryScheduler` on an add-on device-slot
   * *entitlement* expiry, and dormant unless `ADDON_DEVICE_CLEANUP_AUTO` is on
   * — which it is not in any deployment.)
   *
   * So `devices > limit` has two possible causes, and only one of them is the
   * customer's doing:
   *
   *   1. they registered more devices than they are entitled to — the thing
   *      this detector is for;
   *   2. **we lowered the limit under them.** A move from a 5-device plan to a
   *      2-device plan leaves five registered devices against a limit of two,
   *      and the original code named that customer at `devices >= limit * 2` →
   *      HIGH, confidence 80, for downgrading their own subscription.
   *
   * THE PANEL LIMIT IS NOT AN ENFORCEMENT BOUNDARY, and no reasoning here may
   * assume it is. There are tools and services that bypass Remnawave's HWID
   * device limit; that bypass is the whole reason this detector exists, because
   * if the limit could not be circumvented then `devices > limit` would be
   * unreachable and there would be nothing to detect. An earlier version of this
   * note argued the opposite — that a registration at or over the limit is
   * refused with `USER_HWID_DEVICE_LIMIT_REACHED`, so a customer cannot add
   * devices while over, so any overage after a downgrade MUST be the downgrade —
   * and excused the whole overage on the strength of it. That handed a genuine
   * sharer 14 days of immunity for the price of a plan downgrade that cost them
   * nothing, since the panel limit was never what constrained them.
   *
   * WHAT A REDUCTION ACTUALLY EXPLAINS, and it is bounded: the devices the
   * customer already held under the OLD limit. They cannot un-register those
   * instantly, nobody told them to, and a minute before we moved the line those
   * same devices were not an overage at all. Nothing beyond that number is
   * explained — those devices appeared after the change, or were never
   * legitimate in the first place.
   *
   * So the test is not "was there a reduction?" but "would this same panel state
   * have been an overage BEFORE it?", and `Subscription.deviceLimitReducedAt`
   * (is the reduction recent?) plus `Subscription.deviceLimitBeforeReduction`
   * (what did it reduce from?) answer exactly that, in the SELECT this detector
   * already issues:
   *
   *   5 devices, limit 5 → 2, one day ago    excused in full;
   *   9 devices, limit 5 → 2, one day ago    five explained, four not — named,
   *                                          judged against the old ceiling of
   *                                          5 rather than the new limit of 2,
   *                                          at a lower confidence;
   *   9 devices, limit 2, never reduced      named exactly as it always was;
   *   5 devices, limit 5 → 2, a month ago    named exactly as it always was —
   *                                          the window closed;
   *   5 devices, limit 0 → 2, one day ago    named exactly as it always was —
   *                                          `0` is the column's default, not a
   *                                          ceiling, so it explains nothing.
   *                                          See the `previousLimit <= 0`
   *                                          branch below.
   *
   * THE THRESHOLDS ARE UNTOUCHED. `devices >= baseline * 2 ⇒ HIGH` and
   * `score = 50 + (devices − baseline) * 10` are the same expressions they have
   * always been; a reduction moves what `baseline` IS (to the highest limit we
   * ourselves treated as legitimate in the recent past) and never how the
   * expressions read it. The un-reduced case therefore evaluates identically,
   * character for character, to before this file learned about downgrades.
   */
  public async detectHwidOverage(now: Date): Promise<readonly FraudSignalCandidate[]> {
    const config = await this.resolveConfig();
    if (!config.enableHwidOverage) return [];
    try {
      const [topUsers, panelLimits] = await Promise.all([
        this.devicesClient.listTopUsersByDeviceCount(),
        this.buildPanelUserFacts(),
      ]);
      // A partial device-limit map does not under-report — it MIS-reports. A
      // user whose row we lost reads back as limit 0 and is silently dropped,
      // while everyone else is still judged, so the run looks healthy. Skip.
      if (panelLimits === null) {
        this.logger.warn('HWID overage detection skipped: the panel user list is not trustworthy');
        return [];
      }
      const { byPanelId, coverage } = panelLimits;
      // "WE LOOKED AND FOUND NOBODY" AND "WE COULD NOT LOOK" NO LONGER ARRIVE
      // AS THE SAME VALUE, and this branch is the whole reason the migration
      // was worth doing. The old adapter wrapped the walk in
      // `try { … } catch { return [] }`, so a 404, a 401 and a panel that
      // genuinely has no registered devices were one empty array by the time
      // they reached here — a detector reporting a clean panel forever. The
      // detector had to guess from a CONTRADICTION (a populated user list
      // beside an empty device list) and could only ever guess.
      //
      // `PanelDevicesClient` reports the failure itself, so the guess is gone:
      // `ok` with no rows is now a fact about the panel, and anything else is a
      // read we could not make.
      if (topUsers.kind !== 'ok') {
        this.reportHwidBlind(topUsers);
        return [];
      }
      this.clearHwidBlind();
      if (!topUsers.data.complete) {
        // A prefix of the device-heavy population, not all of it. The list is
        // ordered by device count so the rows we hold are the worst offenders,
        // but a clean verdict covers only them — say so rather than let a
        // truncated walk read like an exhausted one.
        this.logger.warn(
          `HWID overage detection judged the top ${topUsers.data.users.length} of ` +
            `${topUsers.data.total} device-registering user(s): the walk stopped at its ceiling, ` +
            'so this run is INCOMPLETE for the tail, not clean',
        );
      }

      // JOINED ON THE NUMERIC PANEL ID, NOT ON A UUID. Panel 3.x deleted the
      // uuid column from the users table, so a top-users row is
      // `{ id, username, devicesCount }` and `id` is the only identity it
      // carries. The old join read `u.userUuid`, a field 3.3.x does not send.
      let unjoinableRows = 0;
      const offenders = topUsers.data.users
        .map((u) => {
          const meta = byPanelId.get(u.id) ?? null;
          if (meta === null) unjoinableRows += 1;
          return {
            uuid: meta?.identity ?? '',
            username: u.username,
            devices: u.devicesCount,
            limit: meta?.limit ?? 0,
          };
        })
        .filter((u) => u.uuid.length > 0 && u.limit > 0 && u.devices > u.limit);
      if (unjoinableRows > 0) {
        // Not silent, and not fatal: on a truncated user read these are simply
        // rows the prefix did not reach. Judging them would mean inventing a
        // device limit, and inventing one is how a customer gets named for a
        // number nobody set.
        this.logger.warn(
          `HWID overage detection could not judge ${unjoinableRows} device-registering user(s): ` +
            'the panel user list holds no row for their id, so their device limit is unknown. ' +
            'They were skipped, not cleared.',
        );
      }
      if (offenders.length === 0) return [];

      // One query, already needed for the user deep-link, now also carrying the
      // limit-reduction stamp and the limit it reduced FROM — the suppression
      // below costs no extra round-trip and, crucially, no panel call: the
      // ceiling travels in the same row as the timestamp that gates it, so
      // there is no read that can fail and no failure to decide the wrong way.
      const subscriptionByUuid = await this.resolveSubscriptions(offenders.map((o) => o.uuid));
      const graceCutoffMs = now.getTime() - HWID_DOWNGRADE_GRACE_DAYS * 24 * 60 * 60 * 1000;
      const judged: Array<(typeof offenders)[number] & { reduction: ExplainedByReduction | null }> =
        [];
      const excused: string[] = [];
      const anomalousStamps: string[] = [];
      /** Stamped `before = 0` — "previously unlimited", which is unsizeable. */
      const unsizeableStamps: string[] = [];
      for (const offender of offenders) {
        const facts = subscriptionByUuid.get(offender.uuid) ?? null;
        const reducedAt = facts?.deviceLimitReducedAt ?? null;
        // No stamp, or one older than the window: judged exactly as it always
        // was. This is the overwhelming majority of offenders and the branch the
        // detector exists for.
        if (reducedAt === null || reducedAt.getTime() < graceCutoffMs) {
          judged.push({ ...offender, reduction: null });
          continue;
        }
        const previousLimit = facts?.deviceLimitBeforeReduction ?? null;
        if (previousLimit === null) {
          // UNREACHABLE BY CONSTRUCTION, and deliberately not treated as an
          // excuse. The trigger writes the timestamp and the ceiling in one
          // assignment block, so a stamped row without a ceiling is a state the
          // schema cannot produce. If one appears, something wrote the timestamp
          // outside the trigger and we do not know what it means.
          //
          // Granting immunity on provenance we cannot explain is the exploitable
          // direction — it is exactly the blanket excuse a sharer would buy with
          // a downgrade. Judging is the recoverable one: an accusation is
          // reviewable and an operator can dismiss it, and dismissal now
          // genuinely suppresses. So judge, and say so loudly.
          anomalousStamps.push(offender.username);
          judged.push({ ...offender, reduction: null });
          continue;
        }
        if (previousLimit <= 0) {
          // "PREVIOUSLY UNLIMITED" IS NOT AN EXCUSE, because `0` is not a fact.
          //
          // `Subscription.deviceLimit` is `@default(0)`, so a stored `0` means
          // "unlimited" and "never synced" and "nobody has written this column
          // yet" — the same value for three different states, and the trigger
          // that stamps `device_limit_before_reduction` cannot tell them apart.
          // Worse, the writer that produces this transition at scale is not a
          // downgrade at all: `RemnawaveImporterService.syncSubscription`
          // assigns `deviceLimit: panelUser.hwidDeviceLimit` unconditionally on
          // EVERY import pass, so the first import after an operator switches
          // HWID limits on transitions every row `0 → N` and stamps the entire
          // customer base "previously unlimited" in one sweep. Verified against
          // PostgreSQL with the migration replayed: a plain `0 → 5` write sets
          // `device_limit_reduced_at` and records `before = 0`.
          //
          // The finite case above is safe because it is BOUNDED — it excuses
          // exactly `devices <= previousLimit`, the ceiling we ourselves
          // authorised. Unlimited has no number, so there is no bound to apply:
          // the only shapes available here are blanket immunity or none. Taking
          // the blanket one meant 14 days of silence for every over-limit user
          // starting at the exact moment a new limit was introduced — which is
          // when it is most likely to be breached, and precisely the window the
          // detector exists to watch.
          //
          // So judge, for the same reason the missing-ceiling branch above
          // judges: immunity granted on provenance we cannot explain is the
          // exploitable direction, and an accusation is the recoverable one —
          // an operator can dismiss it, and a dismissal now genuinely
          // suppresses. Judged means judged EXACTLY as before this file learned
          // about downgrades: `reduction: null` puts the offender on the
          // unchanged path, so severity, score and confidence are the
          // expressions they have always been. The cost is a genuine
          // unlimited → finite downgrade being named; the log below is what
          // hands the operator that mitigating fact.
          unsizeableStamps.push(offender.username);
          judged.push({ ...offender, reduction: null });
          continue;
        }
        // A raise since the reduction can leave the current limit at or above
        // the old one; then the reduction explains nothing this offender is not
        // already over, and pretending otherwise would weaken a signal for free.
        if (previousLimit <= offender.limit) {
          judged.push({ ...offender, reduction: null });
          continue;
        }
        if (offender.devices <= previousLimit) {
          // The whole overage is the line we moved: this exact panel state was
          // clean under the old limit, so it cannot become sharing because of a
          // change the customer made to their own plan.
          excused.push(offender.username);
          continue;
        }
        judged.push({ ...offender, reduction: { reducedAt, previousLimit } });
      }
      // Never silent. A suppressed accusation that logs nothing is
      // indistinguishable from a clean panel, and an operator chasing "why is
      // this obvious over-limit user not listed?" has to be able to find it.
      if (excused.length > 0) {
        this.logger.log(
          `HWID overage: not naming ${excused.length} user(s) whose registered devices are fully ` +
            `accounted for by a device-limit reduction in the last ${HWID_DOWNGRADE_GRACE_DAYS}d ` +
            `(${excused.join(', ')}). Every device they hold was within the limit they had before ` +
            'the change, so the overage is the change and not their behaviour.',
        );
      }
      // Not an error — this is a reachable, common state — but it must be
      // visible, because it is the operator's only notice that a recorded
      // mitigating fact was deliberately not honoured.
      if (unsizeableStamps.length > 0) {
        this.logger.log(
          `HWID overage: ${unsizeableStamps.length} user(s) carry a device-limit reduction FROM ` +
            `"unlimited" (${unsizeableStamps.join(', ')}). They were JUDGED, not excused: ` +
            'device_limit 0 is the column default and the "never synced" value as much as it is ' +
            '"unlimited" — every Remnawave import rewrites the column, so a 0 → N pass stamps ' +
            'rows that were never downgraded — and an unlimited ceiling cannot bound the excuse ' +
            'the way a finite one does. If one of these really was an unlimited plan moved to a ' +
            'finite limit, that is the mitigating fact for the signal.',
        );
      }
      if (anomalousStamps.length > 0) {
        this.logger.error(
          `HWID overage: ${anomalousStamps.length} subscription(s) carry a device-limit reduction ` +
            `timestamp with NO previous limit recorded (${anomalousStamps.join(', ')}). The ` +
            'trigger writes both columns in one assignment block, so this state should be ' +
            'unreachable — something wrote the timestamp outside it. These users were JUDGED, ' +
            'not excused: an unexplained stamp must not buy the immunity a downgrade would. ' +
            'Investigate the writer before trusting any suppression on these rows.',
        );
      }
      if (judged.length === 0) return [];

      const day = utcDay(now);
      return judged.map((o) => {
        const rezeisUserId = subscriptionByUuid.get(o.uuid)?.userId ?? null;
        // The baseline the UNCHANGED thresholds below are measured against: the
        // plan limit, unless a recent reduction proves we ourselves treated a
        // higher number as legitimate days ago, in which case the surplus is
        // measured from there. Identical to `o.limit` whenever no reduction
        // applies, which is why the un-reduced case is bit-for-bit as before.
        const baseline = o.reduction === null ? o.limit : o.reduction.previousLimit;
        // ── Confidence ────────────────────────────────────────────────────
        // Two independent readings of the same overage, plus how much of the
        // panel we actually read. See `confidence.util.ts` for the arithmetic
        // and the ceiling's meaning; NONE of this touches `severity` or
        // `score` above, which are the expressions they have always been.
        //
        //  • RATIO — `devices / baseline`. Barely clearing the line is the
        //    weakest possible overage; the reference the whole model comes
        //    from calls this the margin over the threshold. Conclusive at 3×,
        //    deliberately PAST the 2× the severity mapping already reacts to,
        //    so confidence keeps climbing after severity has saturated.
        //  • SURPLUS — `devices - baseline`, the same overage read in absolute
        //    devices. Independent of the ratio wherever the limit is large: a
        //    plan of 10 at 11 devices is ratio 1.1 / surplus 1, a plan of 2 at
        //    6 is ratio 3 / surplus 4. One extra registration is the shape a
        //    re-imaged laptop or a reinstalled OS takes (the panel keeps the
        //    old HWID forever — see the method header); four is not.
        //  • QUALITY — how much of the panel user list the strict read
        //    actually returned. The limit for THIS user came out of a row we
        //    hold, so it is not itself in doubt; what a truncated read means is
        //    that the map the file's own comment calls untrustworthy when short
        //    passed the `null` guard anyway, because truncation is reported as
        //    `ok`. That is a weaker evidence base for every name it produced,
        //    and the honest response is a lower confidence rather than either
        //    silence or the full 80.
        const ratio = baseline > 0 ? o.devices / baseline : Number.NaN;
        const surplus = o.devices - baseline;
        const { confidence, explanation } = computeConfidence({
          ceiling: o.reduction === null ? UNEXPLAINED_OVERAGE_CONFIDENCE : PARTLY_EXPLAINED_CONFIDENCE,
          dataQuality: coverage,
          factors: [
            { name: 'overageRatio', observed: ratio, strength: ratioStrength(ratio, 1, 3) },
            { name: 'overageSurplus', observed: surplus, strength: ratioStrength(surplus, 1, 5) },
          ],
        });
        return {
          code: 'SUBSCRIPTION_SHARING_HWID',
          fingerprint: `${day}|${o.uuid}`,
          severity:
            o.devices >= baseline * 2 ? FraudSignalSeverity.HIGH : FraudSignalSeverity.MEDIUM,
          title: 'Subscription sharing — device limit exceeded',
          description:
            o.reduction === null
              ? `User ${o.username} has ${o.devices} registered devices but the plan allows ${o.limit}.`
              : `User ${o.username} has ${o.devices} registered devices but the plan allows ${o.limit}. ` +
                `Their device limit was reduced ${describeAge(o.reduction.reducedAt, now)} from ` +
                `${o.reduction.previousLimit}, which accounts for ${o.reduction.previousLimit} of ` +
                `those devices; the remaining ${o.devices - o.reduction.previousLimit} are not ` +
                'explained by it.',
          score: clampScore(50 + (o.devices - baseline) * 10),
          confidence,
          affectedUserIds: rezeisUserId ? [rezeisUserId] : [],
          metadata: {
            kind: 'hwid_overage',
            deviceCount: o.devices,
            // Stays the PLAN limit even when a reduction moved the baseline —
            // `AntiFraudService.getTopOffenders` and the Telegram block render
            // this as "count / limit", and the plan limit is the true answer to
            // "what are they entitled to". The reduction context is additive,
            // below, so nothing that reads this metadata today changes meaning.
            deviceLimit: o.limit,
            remnawaveUuid: o.uuid,
            remnawaveUsername: o.username,
            // Additive and present only when a reduction partly explains the
            // overage, so an unexplained signal keeps exactly the metadata shape
            // it has always had.
            ...(o.reduction !== null
              ? {
                  partlyExplainedByLimitReduction: true,
                  deviceLimitBeforeReduction: o.reduction.previousLimit,
                  deviceLimitReducedAt: o.reduction.reducedAt.toISOString(),
                  unexplainedDeviceCount: o.devices - o.reduction.previousLimit,
                }
              : {}),
            // The baseline the confidence factors above were measured from —
            // `deviceLimit` is the plan limit and is NOT that number whenever a
            // reduction moved it, so an operator re-deriving `overageRatio` by
            // hand needs this one spelled out.
            confidenceBaseline: baseline,
            ...explanation,
          },
        } satisfies FraudSignalCandidate;
      });
    } catch (error) {
      this.logger.warn(`HWID overage detection failed: ${(error as Error).message}`);
      return [];
    }
  }

  // ── Detector: one device, several customers ─────────────────────────────

  /**
   * One hwid bound to the panel profiles of two or more DIFFERENT customers.
   *
   * ── THE QUESTION NOBODY WAS ASKING ────────────────────────────────────
   *
   * {@link detectHwidOverage} compares each user's device count against THAT
   * user's own limit. It is a per-account question and it cannot see across
   * accounts at all — two people on one machine, each holding one device
   * against a limit of three, are two clean rows to it and always were. The
   * seven other detectors in this module group by user, transaction or
   * referral, so none of them could see it either: before this detector, one
   * machine registered under three paying identities produced no signal
   * anywhere in the system.
   *
   * That is the shape multi-accounting actually takes here. A blocked customer
   * comes back on a second account from the same machine; one subscription is
   * resold to a second household; a trial is claimed repeatedly from one
   * device. In every one of those the per-account view is clean by
   * construction, and the duplicate hwid is the only thing that is not.
   *
   * ── WHAT THE HWID IS, AND THEREFORE WHAT THIS SIGNAL IS WORTH ─────────
   *
   * It is a header the client application chooses. It is NOT a serial number
   * read off the hardware, nothing verifies it, and a client that wants to
   * send a fresh one per install can. So:
   *
   *   - a MATCH is meaningful. Two independent installs do not arrive at the
   *     same identifier by accident, and a client with any real derivation
   *     produces a stable value for one machine — which is exactly why the
   *     same machine under two identities shows up here;
   *   - a NON-match proves nothing. Reinstalling, switching client, or
   *     picking a client that randomises it all defeat this detector
   *     completely. It finds the careless, not the determined, and its
   *     silence is never evidence that nobody is multi-accounting.
   *
   * The failure mode that matters is the other direction: a client BUILD that
   * sends one constant string for every install puts the entire customer base
   * into a single group. Filing that would accuse everybody at once — a page
   * of hundreds of identical signals gets dismissed wholesale and takes the
   * genuine pairs beside it down too. `sharedHwidMaxAccounts` bounds it: above
   * the ceiling the run logs the hwid and the count and files nothing, because
   * "this client build is broken" is the fact an operator can act on and
   * "these 400 customers share a laptop" is not.
   *
   * ── COUNTED IN CUSTOMERS, NOT IN PROFILES ─────────────────────────────
   *
   * The single largest false positive available here is a customer with two
   * subscriptions. That is two panel profiles, legitimately, and their own
   * laptop is legitimately on both — an entirely ordinary state this detector
   * must never name. So the group is collapsed to rezeis users through
   * `Subscription.userId` BEFORE it is counted, and a group that collapses to
   * one customer is not a finding at all.
   *
   * Two consequences follow, and both under-report rather than over-report:
   * a panel profile this deployment holds no subscription row for cannot be
   * attributed to anybody and is dropped (with a count), and a profile whose
   * panel id is missing from the user list is dropped the same way. Either can
   * shrink a pair to a single account and hide a real finding for a run. That
   * is the safe direction and it is logged, never silent.
   *
   * ── ONE SIGNAL PER DEVICE, NAMING EVERY OWNER ─────────────────────────
   *
   * The finding is a relation, so it is filed once per hwid with every
   * customer in `affectedUserIds`, rather than once per customer. Two things
   * follow from that and are intended:
   *
   *   - nobody is singled out as the offender, because the evidence does not
   *     say which of them it is — the operator sees the relation and decides;
   *   - `findCoveringExemption` matches on ANY affected user, so an exemption
   *     granted to one member suppresses the whole group. That is the right
   *     reading: an operator clearing one of two people who share a device has
   *     cleared the sharing, not half of it.
   */
  public async detectSharedHwidAcrossAccounts(
    now: Date,
  ): Promise<readonly FraudSignalCandidate[]> {
    const config = await this.resolveConfig();
    if (!config.enableSharedHwid) return [];
    try {
      const [inventory, panelFacts] = await Promise.all([
        this.devicesClient.listAllDevices(),
        this.buildPanelUserFacts(),
      ]);
      // Same refusal as the overage detector, for the same reason: a partial
      // user map does not under-report, it MIS-attributes. A profile whose row
      // we lost is silently dropped from its group, which can take a genuine
      // pair down to one account and clear it — while the run still looks
      // healthy.
      if (panelFacts === null) {
        this.logger.warn(
          'Cross-account device detection skipped: the panel user list is not trustworthy',
        );
        return [];
      }
      if (inventory.kind !== 'ok') {
        this.reportSharedHwidBlind(inventory);
        return [];
      }
      this.clearSharedHwidBlind();
      const { byPanelId, coverage: userCoverage } = panelFacts;
      if (!inventory.data.complete) {
        this.logger.warn(
          `Cross-account device detection read ${inventory.data.devices.length} of ` +
            `${inventory.data.total} bound device(s): the walk stopped at its ceiling, so ` +
            'this run is INCOMPLETE for the rest of the fleet, not clean. A duplicate ' +
            'whose second row sits past the ceiling is invisible to it.',
        );
      }

      // ── Group the inventory by device ─────────────────────────────────
      // Read defensively field by field. `unwrapEnvelope` guarantees that
      // `devices` is an ARRAY on the drift path and says nothing about what is
      // in it, so a panel minor that renamed either column would otherwise
      // arrive here as a group of `undefined`s keyed on `''`.
      const byHwid = new Map<string, DeviceBinding[]>();
      let unusableRows = 0;
      for (const row of inventory.data.devices) {
        const record = row as unknown as Record<string, unknown>;
        const rawHwid = record['hwid'];
        const rawOwner = record['userId'];
        const hwid = typeof rawHwid === 'string' ? rawHwid.trim() : '';
        // Bounded locally: the contract declares `hwid` as an unbounded
        // `z.string()`, the value is chosen by the client, and it ends up in a
        // fingerprint that carries a UNIQUE index. A value longer than any real
        // device identifier (a uuid is 36 characters, a sha-256 hex is 64) is a
        // payload rather than an identifier and is refused rather than
        // truncated — truncating would collide two different devices into one
        // signal.
        if (hwid.length === 0 || hwid.length > MAX_HWID_LENGTH) {
          unusableRows += 1;
          continue;
        }
        if (typeof rawOwner !== 'number' || !Number.isSafeInteger(rawOwner)) {
          unusableRows += 1;
          continue;
        }
        const binding: DeviceBinding = {
          panelUserId: rawOwner,
          descriptor: deviceDescriptor(record),
          platform: readOptionalString(record['platform']),
          deviceModel: readOptionalString(record['deviceModel']),
          boundAt: readInstant(record['createdAt']),
        };
        const bucket = byHwid.get(hwid);
        if (bucket === undefined) byHwid.set(hwid, [binding]);
        else bucket.push(binding);
      }
      if (unusableRows > 0) {
        this.logger.warn(
          `Cross-account device detection skipped ${unusableRows} device row(s) carrying no ` +
            'usable hwid/owner pair. They were not judged and not cleared — if this is every ' +
            'row, the panel has renamed a column and the detector is reading a shape it ' +
            'no longer understands.',
        );
      }

      // ── Keep only devices seen under more than one profile ────────────
      let unjoinableProfiles = 0;
      const shared: SharedDeviceGroup[] = [];
      for (const [hwid, bindings] of byHwid) {
        const panelIds = new Set(bindings.map((b) => b.panelUserId));
        // The overwhelming majority of devices leave here: one owner, nothing
        // to compare. Done before any lookup so the expensive half of this
        // detector only ever sees candidates.
        if (panelIds.size < 2) continue;
        const profiles: SharedDeviceProfile[] = [];
        for (const panelUserId of panelIds) {
          const facts = byPanelId.get(panelUserId) ?? null;
          if (facts === null || facts.identity.length === 0) {
            unjoinableProfiles += 1;
            continue;
          }
          profiles.push({ panelUserId, username: facts.username, identity: facts.identity });
        }
        if (profiles.length < 2) continue;
        shared.push({ hwid, bindings, profiles });
      }
      if (unjoinableProfiles > 0) {
        this.logger.warn(
          `Cross-account device detection could not attribute ${unjoinableProfiles} profile(s) ` +
            'holding a shared device: the panel user list holds no row for their id. They ' +
            'were dropped from their group, which can shrink a genuine pair to a single ' +
            'account and hide the finding for this run.',
        );
      }
      if (shared.length === 0) return [];

      // ONE query for every group, not one per group: the identities are
      // gathered first and resolved together, so a panel with a hundred shared
      // devices still costs a single round-trip to Postgres.
      const subscriptionByIdentity = await this.resolveSubscriptions([
        ...new Set(shared.flatMap((group) => group.profiles.map((p) => p.identity))),
      ]);

      const minAccounts = Math.max(2, Math.trunc(config.sharedHwidMinAccounts));
      const configuredMax = Math.trunc(config.sharedHwidMaxAccounts);
      // A ceiling below the floor is a detector that can never fire — the one
      // shape this module keeps rediscovering — so it is raised to the floor
      // and the operator is told, rather than silently obeyed into silence.
      const maxAccounts = Math.max(minAccounts, configuredMax);
      if (maxAccounts !== configuredMax) {
        this.logger.warn(
          `Cross-account device detection: the configured account ceiling (${configuredMax}) ` +
            `is below the floor (${minAccounts}), which would file nothing at all. Using ` +
            `${maxAccounts} as the ceiling for this run.`,
        );
      }

      const day = utcDay(now);
      const deviceCoverage = panelReadCoverage({
        held: inventory.data.devices.length,
        population: inventory.data.total,
        complete: inventory.data.complete,
      });
      const candidates: FraudSignalCandidate[] = [];
      let collapsedToOneCustomer = 0;
      let unlinkedProfiles = 0;
      const placeholders: string[] = [];

      for (const group of shared) {
        // COLLAPSED TO CUSTOMERS HERE, and this line is the false-positive
        // guard the whole detector rests on: two profiles owned by one person
        // is a second subscription, not a second person.
        const owners = new Map<string, SharedDeviceProfile[]>();
        for (const profile of group.profiles) {
          const userId = subscriptionByIdentity.get(profile.identity)?.userId ?? null;
          if (userId === null) {
            unlinkedProfiles += 1;
            continue;
          }
          const existing = owners.get(userId);
          if (existing === undefined) owners.set(userId, [profile]);
          else existing.push(profile);
        }
        const accountCount = owners.size;
        if (accountCount < minAccounts) {
          if (accountCount > 0) collapsedToOneCustomer += 1;
          continue;
        }
        if (accountCount > maxAccounts) {
          placeholders.push(`${shortHwid(group.hwid)} (${accountCount} accounts)`);
          continue;
        }

        // ── Confidence ──────────────────────────────────────────────────
        //  • ACCOUNTS — how many distinct paying customers hold this device.
        //    Two is the weakest reading the detector can file and four is
        //    conclusive; the floor is 1 rather than 2 so a pair still scores
        //    above zero, because a pair IS the finding and not a near-miss.
        //  • DESCRIPTOR AGREEMENT — do the rows for this one hwid describe one
        //    machine? The panel records `platform` and `deviceModel` alongside
        //    each binding, and they are supplied by the same client that chose
        //    the hwid. Agreement is consistent with one real machine under two
        //    identities; DISagreement says the identifier is not tracking a
        //    machine at all, which is the placeholder story arriving below the
        //    account ceiling where nothing else would catch it. Omitted
        //    entirely when fewer than two rows describe themselves — an
        //    unmeasured factor must not be scored as agreement.
        const agreement = descriptorAgreement(group.bindings);
        const { confidence, explanation } = computeConfidence({
          ceiling: SHARED_HWID_CONFIDENCE,
          // The weaker of the two reads this signal rests on. Both are needed:
          // the inventory supplies the binding and the user list supplies the
          // identity, and a prefix of either is a weaker evidence base for
          // every name the run produced.
          dataQuality: Math.min(deviceCoverage, userCoverage),
          factors: [
            {
              name: 'sharedAccountCount',
              observed: accountCount,
              strength: ratioStrength(accountCount, 1, 4),
            },
            ...(agreement === null
              ? []
              : [
                  {
                    name: 'deviceDescriptorAgreement',
                    observed: agreement,
                    strength: agreement,
                  },
                ]),
          ],
        });

        const usernames = group.profiles.map((p) => p.username).sort();
        candidates.push({
          code: 'SHARED_DEVICE_MULTI_ACCOUNT',
          fingerprint: `${day}|${group.hwid}`,
          severity:
            accountCount >= 3 ? FraudSignalSeverity.HIGH : FraudSignalSeverity.MEDIUM,
          title: 'Shared device — one HWID across several accounts',
          description:
            `Device ${shortHwid(group.hwid)} is registered on ${accountCount} different ` +
            `customers' profiles (${usernames.join(', ')}). The panel's hwid is chosen by ` +
            'the client application, so a match means those profiles reported the same ' +
            'installation — not that the hardware was verified.' +
            (agreement !== null && agreement < 1
              ? ' The rows for this hwid disagree about the platform or device model, ' +
                'which is what a client sending a fixed identifier looks like.'
              : ''),
          score: clampScore(50 + (accountCount - 2) * 15),
          confidence,
          affectedUserIds: [...owners.keys()].sort(),
          metadata: {
            kind: 'shared_hwid',
            hwid: group.hwid,
            accountCount,
            panelProfileCount: group.profiles.length,
            deviceRowCount: group.bindings.length,
            // Capped: a group at the account ceiling can still hold more
            // profiles than that, and signal metadata is rendered in a table
            // row, not paged.
            profiles: group.profiles.slice(0, SHARED_HWID_MAX_PROFILES_IN_METADATA).map((p) => ({
              panelUserId: p.panelUserId,
              username: p.username,
              remnawaveId: p.identity,
              userId: subscriptionByIdentity.get(p.identity)?.userId ?? null,
            })),
            ...(agreement === null ? {} : { descriptorAgreement: Math.round(agreement * 100) / 100 }),
            ...explanation,
          },
        } satisfies FraudSignalCandidate);
      }

      // Never silent. Each of these is a group the run SAW and declined to
      // file, and an operator asking "why is this obvious duplicate not
      // listed?" has to be able to find the answer.
      if (collapsedToOneCustomer > 0) {
        this.logger.log(
          `Cross-account device detection: ${collapsedToOneCustomer} shared device(s) belong ` +
            'to a single customer holding more than one subscription. That is an ordinary ' +
            'state, not sharing, and it is what this detector counts customers rather than ' +
            'panel profiles to avoid.',
        );
      }
      if (unlinkedProfiles > 0) {
        this.logger.log(
          `Cross-account device detection: ${unlinkedProfiles} panel profile(s) holding a ` +
            'shared device have no subscription row here, so they cannot be attributed to a ' +
            'customer and were dropped from their group. A pair that loses one of its two ' +
            'members this way is not reported at all.',
        );
      }
      if (placeholders.length > 0) {
        this.logger.error(
          `Cross-account device detection: ${placeholders.length} hwid(s) are bound to more ` +
            `than ${maxAccounts} customers each (${placeholders.join(', ')}). Nobody was ` +
            'named: a device identifier shared by that many paying accounts is a client ' +
            'build sending a constant value, not a machine somebody is lending out. Fix or ' +
            'block that client — filing this as fraud would accuse the whole customer base.',
        );
      }
      return candidates;
    } catch (error) {
      this.logger.warn(
        `Cross-account device detection failed: ${(error as Error).message}`,
      );
      return [];
    }
  }

  // ── Detector: concurrent-IP sharing ─────────────────────────────────────

  public async detectConcurrentIpSharing(now: Date): Promise<readonly FraudSignalCandidate[]> {
    const config = await this.resolveConfig();
    if (!config.enableIpSharing) return [];
    // THERE IS NO CAPABILITY GATE HERE ANY MORE, and its removal is the point.
    //
    // The old test was `classifyLiveConnectionBlindness(caps)` over
    // `liveIpControl` / `connectionsApi` — version facts that existed only to
    // tell 2.7 from 2.8 from 3.x. This build serves 3.x and refuses 2.x once,
    // centrally, in `LegacyPanelRefusal`, so the only answers the gate had left
    // were "3.x, proceed" and "we could not read the version". The second is
    // the state every healthy panel passes through during a token blip or a
    // restart, and the gate turned it into a silent empty run — a detector
    // standing down precisely when the panel is already struggling, reporting
    // the same value a clean panel reports.
    //
    // Blindness is now read off the ANSWERS instead: the panel user list, the
    // node list and each node's live connections each report "we could not
    // look" as a distinct outcome, and every one of them is announced below.
    //
    // Returning `[]` is still the only safe output when it IS blind — see
    // `AntiFraudService`'s `observational` evidence class: an empty run from a
    // panel-backed detector is no information at all and must never
    // auto-resolve anybody's open signal.
    try {
      // Degrade, never guess: this detector writes a fraud signal keyed by
      // `day|uuid`, and a uuid-less row would collide every such user onto one
      // fingerprint. An unvouched-for list is skipped with a warning rather
      // than quietly under-detecting for a run.
      const bulk = await this.remnawaveApiService.strictGetAllPanelUsers();
      if (bulk.kind !== 'ok') {
        this.reportConcurrentIpBlind({
          reason: 'panel_user_list_unreadable',
          message:
            `the panel user list is not trustworthy (${describeStrictOutcome(bulk)}), and without ` +
            'it an online panel id cannot be attributed to a subscriber or measured against a ' +
            'device limit.',
        });
        return [];
      }
      const panelUsers = bulk.value.users;
      if (panelUsers.length === 0) {
        // A vouched-for empty panel. Nobody to be online, so nobody to accuse —
        // and unlike every other empty above, this one really is a fact.
        this.clearConcurrentIpBlind();
        return [];
      }
      const coverage = panelReadCoverage({
        held: bulk.value.users.length,
        population: bulk.value.total,
        complete: bulk.value.complete,
      });

      // panelId → { identity, username, limit }. The connections rows key
      // online users by the panel's numeric id, on every 3.x build.
      const byPanelId = new Map<number, { identity: string; username: string; limit: number }>();
      for (const u of panelUsers) {
        if (u.panelId !== null) {
          byPanelId.set(u.panelId, {
            identity: u.uuid,
            username: u.username,
            limit: u.hwidDeviceLimit ?? 0,
          });
        }
      }

      // `?? []` IS GONE, and that was a real conflation: a node list we could
      // not read produced zero connected nodes, the run returned `[]` two lines
      // later, and a panel that never answered was indistinguishable from one
      // where nobody is sharing.
      const nodeList = await this.infraClient.getNodes();
      if (nodeList.kind !== 'ok') {
        this.reportConcurrentIpBlind({
          reason: 'node_list_unreadable',
          message:
            `the panel did not return its node list (${describeReadFailure(nodeList)}), so there ` +
            'is nothing to scan and no way to tell a quiet panel from an unreachable one.',
        });
        return [];
      }
      const nodes = nodeList.data;

      // Node-stability guard, same evidence and same window as
      // `RemnawaveDetectors.findRecentNodeFlap`. When a node drops, every user
      // it was carrying reconnects somewhere else — from a fresh source IP, on
      // a different node, within seconds of each other. That is a panel-wide
      // burst of "new networks" caused by our own infrastructure, and this
      // detector reads it as a panel-wide burst of sharing. Guarded on the WHOLE
      // node list, not the scanned slice: a node outside the slice going down
      // still pushes its users onto the nodes inside it.
      const flap = await this.findRecentNodeFlap(now, nodes);
      if (flap !== null) {
        this.logNodeFlapSuppression(flap);
        return [];
      }
      this.nodeFlapSuppressionActive = false;

      // Sort before slicing. `getNodes` returns the panel's order, which is
      // not stable, so an unsorted `.slice()` scans a different set of nodes
      // from one run to the next — and the distinct-IP count that this whole
      // accusation rests on is taken over exactly those nodes. Sorting by uuid
      // makes the same panel produce the same slice, so a user's verdict stops
      // depending on which nodes the panel happened to list first.
      const connected = nodes
        .filter((n) => n.isConnected && !n.isDisabled)
        .sort((a, b) => a.uuid.localeCompare(b.uuid))
        .slice(0, config.maxNodesPerRun);
      if (connected.length === 0) {
        // The node list was READ and holds nothing to scan — a panel with every
        // node disabled or down. Not blindness: we know why we saw nobody.
        this.clearConcurrentIpBlind();
        return [];
      }

      const nowMs = now.getTime();
      const staleBefore = nowMs - config.ipWindowMinutes * 60_000;
      // panel user id → ip → sample
      const byUser = new Map<number, Map<string, IpAggregate>>();
      let undatedSamples = 0;
      let unreadablePanelIds = 0;

      let unreadableNodes = 0;
      for (const node of connected) {
        const rows = await this.devicesClient.fetchNodeConnections(node.uuid);
        // `null` is "this node could not be read", not "this node was quiet".
        // Counting it is the whole point: a node whose collection job failed,
        // timed out, or completed carrying nothing usable contributes nobody,
        // and without this the run would report a clean panel having looked at
        // a fraction of it. `PanelDevicesClient.pollJob` is what makes the two
        // separable — the reader it replaces let a completed job with
        // `result: null` fall through to an extractor that answers `[]` for any
        // non-array, so a collection that ran and produced nothing came back as
        // "node read, nobody online".
        if (rows === null) {
          unreadableNodes += 1;
          continue;
        }
        for (const row of rows) {
          const panelId = parsePanelId(row.userId);
          if (panelId === null) {
            unreadablePanelIds += 1;
            continue;
          }
          for (const sample of row.ips) {
            const lastSeen = readInstant(sample.lastSeen);
            // An unparseable timestamp used to be KEPT — `Number.isFinite(seen)
            // && seen < windowStart` only excluded samples it could read, so a
            // malformed `lastSeen` counted as in-window and as concurrent with
            // everything else. Fail-open is the wrong direction for evidence:
            // a sighting we cannot place in time cannot show simultaneity.
            if (lastSeen === null) {
              undatedSamples += 1;
              continue;
            }
            if (lastSeen.ms < staleBefore) continue;
            let ipMap = byUser.get(panelId);
            if (!ipMap) {
              ipMap = new Map<string, IpAggregate>();
              byUser.set(panelId, ipMap);
            }
            const existing = ipMap.get(sample.ip);
            // The same IP can appear on several nodes. Keep the NEWEST sighting,
            // not the first node's: recency is now what decides concurrency, and
            // first-wins would date a live IP by whichever node we happened to
            // scan first and drop it out of its own user's cluster.
            if (existing !== undefined && existing.lastSeenMs >= lastSeen.ms) continue;
            ipMap.set(sample.ip, {
              ip: sample.ip,
              lastSeen: lastSeen.iso,
              lastSeenMs: lastSeen.ms,
              nodeName: node.name,
              countryCode: node.countryCode.length > 0 ? node.countryCode : null,
            });
          }
        }
      }
      if (undatedSamples > 0) {
        this.logger.warn(
          `Concurrent-IP detection dropped ${undatedSamples} IP sample(s) with an unreadable ` +
            'lastSeen — the panel is sending timestamps this detector cannot parse, so its ' +
            'view of who was online together is incomplete',
        );
      }

      const concurrencyWindowMs = config.ipConcurrencyWindowSeconds * 1000;
      const offenders: Array<{
        uuid: string;
        username: string;
        limit: number;
        ips: readonly IpAggregate[];
        observedIpCount: number;
        distinctNetworks: number;
      }> = [];
      for (const [panelId, ipMap] of byUser) {
        const meta = byPanelId.get(panelId);
        if (!meta || meta.limit <= 0) continue;
        const observed = [...ipMap.values()];
        // Recency clustering — the difference between "seen in the last 10
        // minutes" and "in use at the same time". See
        // `ipConcurrencyWindowSeconds` for why this is the only simultaneity
        // test the `{ ip, lastSeen }` payload can support.
        const ips = selectConcurrentSamples(observed, nowMs, concurrencyWindowMs);
        if (ips.length === 0) continue;
        const distinctNetworks = countDistinctNetworks(
          ips.map((s) => s.ip),
          {
            grouping: config.ipNetworkGrouping,
            v4Prefix: config.ipV4PrefixLength,
            v6Prefix: config.ipV6PrefixLength,
          },
        );
        // Count distinct *networks* (not raw IPs) and require exceeding the
        // device limit by a tolerance margin — this is what kills the
        // mobile/Wi-Fi/CGNAT/IPv6-rotation false positives.
        if (!isNetworkSharingOffender(distinctNetworks, meta.limit, config.ipOverageMargin)) {
          continue;
        }
        offenders.push({
          uuid: meta.identity,
          username: meta.username,
          limit: meta.limit,
          ips,
          observedIpCount: observed.length,
          distinctNetworks,
        });
      }
      if (unreadablePanelIds > 0) {
        // Never silent: an earlier reader turned `3f2a-…` into panel user #3
        // and filed those IPs against whoever that was. The contract now
        // declares `userId` as a number, so this is only reachable on the
        // drift path — where the executor hands back the panel's raw bytes and
        // the field can be anything at all.
        this.logger.warn(
          `Concurrent-IP detection skipped ${unreadablePanelIds} live-connection row(s) whose ` +
            'userId is not an integer panel id — they cannot be attributed to a user without guessing',
        );
      }
      // A node that could not be read contributes nobody, and nobody is what a
      // clean panel also contributes. Said out loud, at a level proportional to
      // how much of the panel went unseen: the run is still worth completing on
      // the nodes that answered, but its silence is not evidence.
      if (unreadableNodes === connected.length) {
        // Nothing was seen at all. That is not a degraded run, it is a blind
        // one, and it goes through the same latch as the other two blindnesses
        // so an operator gets one WARN per episode rather than one per run.
        this.reportConcurrentIpBlind({
          reason: 'live_connections_unreadable',
          message:
            `not one of the ${connected.length} connected node(s) could be read — every ` +
            'collection job failed, was refused, or did not finish inside its poll budget. This ' +
            'run examined nobody.',
        });
        return [];
      }
      this.clearConcurrentIpBlind();
      if (unreadableNodes > 0) {
        this.logger.warn(
          `Concurrent-IP detection could not read ${unreadableNodes} of ${connected.length} ` +
            'connected node(s) — their live connections were NOT examined, so a clean result ' +
            'covers only the rest',
        );
      }
      if (offenders.length === 0) return [];

      const subscriptionByUuid = await this.resolveSubscriptions(offenders.map((o) => o.uuid));
      const day = utcDay(now);
      const threshold = config.ipOverageMargin;
      return offenders.map((o) => {
        const rezeisUserId = subscriptionByUuid.get(o.uuid)?.userId ?? null;
        // Advisory signal: never HIGH. MEDIUM only when networks are at least
        // double the tolerated limit; otherwise LOW.
        const tolerated = o.limit + threshold;
        // ── Confidence ────────────────────────────────────────────────────
        // Three independent readings, plus how much of the panel list we read.
        // Nothing here touches the `severity` or `score` expressions below.
        //
        //  • SAMPLE SIZE — `ips.length / distinctNetworks`, how many IP
        //    sightings back each network the count rests on. A network seen
        //    once is a single packet's worth of evidence; four or more
        //    sightings per network is a sustained presence. This is the
        //    weakness the brief names first, and the one this detector is most
        //    exposed to: a five-network count assembled from five lone IPs and
        //    one assembled from two hundred read identically today.
        //  • MARGIN — `distinctNetworks / tolerated`, how far past the
        //    `limit + margin` line the count sits. Conclusive at 2×, which is
        //    where the severity mapping also steps; unlike HWID there is no
        //    range above it worth resolving, because this detector is capped at
        //    MEDIUM by design and an operator reading a LOW/MEDIUM advisory
        //    does not need the 4× case distinguished from the 8×.
        //  • RETENTION — `ips.length / observedIpCount`, the share of the
        //    user's recent sightings that the concurrency gate kept. A cluster
        //    that IS essentially all of the user's recent activity is a strong
        //    reading of "in use together"; four sightings picked out of forty
        //    describe a heavy roamer, and a cluster drawn from a roamer's tail
        //    is as consistent with one restless phone as with two people.
        //  • QUALITY — panel-list completeness, as for HWID. NOT node
        //    coverage: `maxNodesPerRun` truncates the scanned node set, and a
        //    node we did not scan can only ADD networks to a user's count, so
        //    node truncation can suppress a signal but can never inflate one it
        //    did raise. Penalising confidence for it would be penalising the
        //    conservative direction.
        const samplesPerNetwork = o.distinctNetworks > 0 ? o.ips.length / o.distinctNetworks : 0;
        const marginRatio = tolerated > 0 ? o.distinctNetworks / tolerated : Number.NaN;
        const retention = o.observedIpCount > 0 ? o.ips.length / o.observedIpCount : 0;
        const { confidence, explanation } = computeConfidence({
          ceiling: IP_SHARING_CONFIDENCE,
          dataQuality: coverage,
          factors: [
            {
              name: 'samplesPerNetwork',
              observed: samplesPerNetwork,
              strength: ratioStrength(samplesPerNetwork, 1, 4),
            },
            {
              name: 'networkMargin',
              observed: marginRatio,
              strength: ratioStrength(marginRatio, 1, 2),
            },
            {
              name: 'concurrencyRetention',
              observed: retention,
              // Already a fraction; a cluster that is half of everything the
              // user was seen doing is where this stops discounting.
              strength: ratioStrength(retention, 0, 0.5),
            },
          ],
        });
        return {
          code: 'SUBSCRIPTION_SHARING_IP',
          fingerprint: `${day}|${o.uuid}`,
          severity:
            o.distinctNetworks >= tolerated * 2
              ? FraudSignalSeverity.MEDIUM
              : FraudSignalSeverity.LOW,
          title: 'Subscription sharing — concurrent networks exceed device limit',
          // Says what was actually measured. The old text claimed "in the last
          // 10m", which is the staleness bound, not the concurrency test, and
          // read to an operator as "ten minutes of activity" rather than "these
          // were in use together".
          description: `User connected from ${o.distinctNetworks} distinct networks (${o.ips.length} IPs active within ${config.ipConcurrencyWindowSeconds}s of each other, out of ${o.observedIpCount} seen in ${config.ipWindowMinutes}m); plan allows ${o.limit} devices (+${threshold} tolerance).`,
          score: clampScore(30 + (o.distinctNetworks - o.limit) * 6),
          confidence,
          affectedUserIds: rezeisUserId ? [rezeisUserId] : [],
          metadata: {
            kind: 'ip_sharing',
            distinctNetworkCount: o.distinctNetworks,
            distinctIpCount: o.ips.length,
            observedIpCount: o.observedIpCount,
            deviceLimit: o.limit,
            overageMargin: threshold,
            networkGrouping: config.ipNetworkGrouping,
            windowMinutes: config.ipWindowMinutes,
            concurrencyWindowSeconds: config.ipConcurrencyWindowSeconds,
            remnawaveUuid: o.uuid,
            remnawaveUsername: o.username,
            ips: o.ips.slice(0, config.maxIpsInMetadata),
            // `deviceLimit` + `overageMargin` already give an operator the
            // tolerated line, but spelling out the sum keeps `networkMargin`
            // re-derivable without doing the addition.
            confidenceToleratedNetworks: tolerated,
            ...explanation,
          },
        } satisfies FraudSignalCandidate;
      });
    } catch (error) {
      this.logger.warn(`Concurrent-IP detection failed: ${(error as Error).message}`);
      return [];
    }
  }

  // ── Blindness reporting ─────────────────────────────────────────────────

  /**
   * The HWID top-users read did not answer, and why.
   *
   * WARN on the transition into blindness, debug on every run after it. This
   * runs every 5 minutes and the condition, once true, stays true until somebody
   * fixes the panel — a line per run would be 288 copies a day of the same text
   * and would be tuned out exactly like the failure it exists to surface. One
   * WARN when the detector goes blind, one LOG when it recovers. Once per RUN,
   * never per user: the blindness is a property of the read, not of anybody's
   * account.
   *
   * There is no "the list was empty" branch any more, and there must not be
   * one. `PanelDevicesClient` reports a failure AS a failure, so an `ok` with
   * no rows is the panel saying nobody has registered a device — a fact, not a
   * symptom. Warning about it as well would train an operator to ignore the
   * line that means something.
   */
  private reportHwidBlind(failure: PanelDevicesOutcome<unknown>): void {
    if (this.hwidTopUsersBlind) {
      this.logger.debug('HWID overage detection still blind');
      return;
    }
    this.hwidTopUsersBlind = true;
    this.logger.warn(
      'HWID overage detection is BLIND: the panel did not return its device top-users list ' +
        `(${describeReadFailure(failure)}). This run cannot tell "nobody is over their limit" ` +
        'from "we could not look", so it reports zero offenders — which is not evidence of a ' +
        'clean panel.',
    );
  }

  /** The endpoint answered with rows again. Announced once, at the edge. */
  private clearHwidBlind(): void {
    if (!this.hwidTopUsersBlind) return;
    this.hwidTopUsersBlind = false;
    this.logger.log('HWID overage detection recovered: the panel returned device rows again');
  }

  /**
   * The device inventory could not be read this run. Same one-shot shape and
   * the same reason as {@link reportHwidBlind}: the blindness is a property of
   * the read, not of anybody's account, so it is announced once at the edge
   * rather than once per device.
   */
  private reportSharedHwidBlind(failure: PanelDevicesOutcome<unknown>): void {
    if (this.sharedHwidBlind) {
      this.logger.debug('Cross-account device detection still blind');
      return;
    }
    this.sharedHwidBlind = true;
    this.logger.warn(
      'Cross-account device detection is BLIND: the panel did not return its device ' +
        `inventory (${describeReadFailure(failure)}). This run reports no shared devices, ` +
        'which is not the same fact as a panel on which no device is shared.',
    );
  }

  /** The inventory answered again. Announced once, at the edge. */
  private clearSharedHwidBlind(): void {
    if (!this.sharedHwidBlind) return;
    this.sharedHwidBlind = false;
    this.logger.log(
      'Cross-account device detection recovered: the panel returned its device inventory again',
    );
  }

  /**
   * This run could not look at who is connected, and why. Same one-shot shape as
   * {@link reportHwidBlind}, latched on the REASON so a panel that changes state
   * announces the new one.
   */
  private reportConcurrentIpBlind(blindness: LiveConnectionBlindness): void {
    if (this.concurrentIpBlindReason === blindness.reason) {
      this.logger.debug(`Concurrent-IP detection still blind (${blindness.reason})`);
      return;
    }
    this.concurrentIpBlindReason = blindness.reason;
    this.logger.warn(
      `Concurrent-IP detection is BLIND: ${blindness.message} This detector will report ` +
        'zero offenders until that is resolved — which is not the same fact as a panel ' +
        'on which nobody is sharing.',
    );
  }

  /** The detector can read the panel again. Announced once, at the edge. */
  private clearConcurrentIpBlind(): void {
    if (this.concurrentIpBlindReason === null) return;
    this.concurrentIpBlindReason = null;
    this.logger.log(
      'Concurrent-IP detection recovered: the panel answered with live-connection data again',
    );
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Map the panel's NUMERIC user id → that user's stored identity, name and
   * device limit, together with how much of the panel the map covers.
   *
   * KEYED BY THE NUMERIC ID, not by a uuid, and that is a 3.x fact rather than
   * a preference: panel 3.x deleted the uuid column from the users table, so a
   * `/api/hwid/devices/top-users` row is `{ id, username, devicesCount }` and
   * the numeric id is the only identity it carries. The `identity` field is
   * whatever `Subscription.remnawaveId` would hold for that profile — the
   * decimal id on 3.x, a uuid on a row created before the upgrade — because
   * that is what the fingerprint and the deep-link lookup are keyed on.
   *
   * `null` when the bulk read could not be vouched for — a missing row is
   * indistinguishable from `limit 0` in this map, so a lossy read would exempt
   * exactly the users it lost instead of failing visibly.
   *
   * `coverage` exists because a TRUNCATED read is vouched for: the adapter
   * returns `ok` with `complete: false` and this method has no reason to refuse
   * it (a prefix still answers every uuid it contains, and refusing would
   * disable the detector outright on the largest panels). It is a weaker
   * evidence base all the same, and the number that says so travels with the
   * map instead of being rediscovered at the call site.
   */
  private async buildPanelUserFacts(): Promise<{
    readonly byPanelId: Map<number, PanelUserFacts>;
    readonly coverage: number;
  } | null> {
    const bulk = await this.remnawaveApiService.strictGetAllPanelUsers();
    if (bulk.kind !== 'ok') {
      this.logger.warn(`Panel user list unusable: ${describeStrictOutcome(bulk)}`);
      return null;
    }
    const byPanelId = new Map<number, PanelUserFacts>();
    for (const u of bulk.value.users) {
      if (u.panelId === null) continue;
      byPanelId.set(u.panelId, {
        identity: u.uuid,
        username: u.username,
        limit: u.hwidDeviceLimit ?? 0,
      });
    }
    return {
      byPanelId,
      coverage: panelReadCoverage({
        held: bulk.value.users.length,
        population: bulk.value.total,
        complete: bulk.value.complete,
      }),
    };
  }

  /**
   * Did any node's connectivity change in the last
   * {@link NODE_STABILITY_WINDOW_MINUTES} minutes?
   *
   * Deliberately identical, source for source and window for window, to
   * `RemnawaveDetectors.findRecentNodeFlap` — two user-naming detectors reading
   * the same panel must not disagree about whether the panel was stable. It is
   * duplicated rather than shared only because that method is private to a file
   * this change does not own; the pair should be hoisted into one module the
   * next time either is touched, and until then a change to one is a change to
   * both.
   *
   * Two independent sources, either of which is enough:
   *
   *   1. `node.lastStatusChange` — the panel's own connect/disconnect
   *      timestamp. Free, already in hand, and works on a deployment with no
   *      metric history at all.
   *   2. `RemnawaveMetricSample.nodesSnapshot` — the metrics collector writes a
   *      per-node `isConnected` every 5 minutes and keeps 7 days. A uuid
   *      observed both connected and disconnected inside the window flapped.
   *      The live node list counts as the newest observation, so a node that
   *      dropped since the last sample is caught without waiting for one.
   *
   * Returns `null` when neither source shows a change — including when neither
   * has anything to say. Failing closed on missing history would disable the
   * detector forever on any deployment whose collector is not running, which is
   * the "detector that can never fire" shape this codebase keeps rediscovering.
   */
  private async findRecentNodeFlap(
    now: Date,
    liveNodes: readonly PanelNode[],
  ): Promise<NodeFlapEvidence | null> {
    const windowStart = now.getTime() - NODE_STABILITY_WINDOW_MINUTES * 60_000;

    const recentlyChanged = liveNodes
      .filter((n) => !n.isDisabled)
      .filter((n) => {
        // The contract transforms this field to a `Date`; on the executor's
        // drift path it arrives as the wire string instead. Both are read, and
        // anything else is simply not a timestamp we can place in the window.
        const changedAt = readInstant(n.lastStatusChange);
        return changedAt !== null && changedAt.ms >= windowStart;
      })
      .map((n) => n.name || n.uuid);
    if (recentlyChanged.length > 0) {
      return {
        source: 'panel_status_change',
        nodes: [...recentlyChanged].sort(),
        windowMinutes: NODE_STABILITY_WINDOW_MINUTES,
      };
    }

    let samples: readonly { nodesSnapshot: unknown }[] = [];
    try {
      samples = await this.prismaService.remnawaveMetricSample.findMany({
        where: { createdAt: { gte: new Date(windowStart) } },
        select: { nodesSnapshot: true },
        orderBy: { createdAt: 'asc' },
      });
    } catch (error) {
      this.logger.debug(
        `Node stability history unavailable: ${(error as Error).message} — ` +
          'falling back to the panel status timestamps alone',
      );
      return null;
    }

    if (samples.length === 0) {
      this.logger.debug(
        `No node snapshots in the last ${NODE_STABILITY_WINDOW_MINUTES}m — ` +
          'stability judged from panel status timestamps alone',
      );
      return null;
    }

    // uuid → the set of connectivity states observed inside the window.
    const observed = new Map<string, { name: string; states: Set<boolean> }>();
    const record = (uuid: string, name: string, connected: boolean): void => {
      const entry = observed.get(uuid);
      if (entry) {
        entry.states.add(connected);
        return;
      }
      observed.set(uuid, { name: name || uuid, states: new Set([connected]) });
    };

    for (const sample of samples) {
      for (const entry of parseNodesSnapshot(sample.nodesSnapshot)) {
        record(entry.uuid, entry.name, entry.isConnected);
      }
    }
    for (const node of liveNodes) {
      if (node.isDisabled) continue;
      record(node.uuid, node.name, node.isConnected);
    }

    const flapped = [...observed.values()]
      .filter((entry) => entry.states.size > 1)
      .map((entry) => entry.name)
      .sort();
    if (flapped.length === 0) return null;

    return {
      source: 'metric_snapshots',
      nodes: flapped,
      windowMinutes: NODE_STABILITY_WINDOW_MINUTES,
    };
  }

  /**
   * A suppressed run has to leave a trace: a skipped detector that logs nothing
   * is indistinguishable from a clean panel. WARN on the transition into
   * suppression, LOG on each subsequent suppressed run — node instability is a
   * bounded incident, so a line per 5-minute run tracks a real event and stops
   * when it does.
   */
  private logNodeFlapSuppression(flap: NodeFlapEvidence): void {
    const source =
      flap.source === 'panel_status_change'
        ? 'the panel reports a status change'
        : 'the node snapshots disagree';
    const message =
      `Concurrent-IP detection skipped: ${source} within the last ${flap.windowMinutes}m ` +
      `for ${flap.nodes.join(', ')}. A node change makes every user it carried reconnect ` +
      'from somewhere new, so the extra networks this run would count are the outage.';
    if (!this.nodeFlapSuppressionActive) {
      this.nodeFlapSuppressionActive = true;
      this.logger.warn(message);
      return;
    }
    this.logger.log(message);
  }

  /**
   * Resolve the panel's own identities to the local subscription facts both
   * detectors need: the rezeis user id (for the deep link) and the
   * limit-reduction pair `deviceLimitReducedAt` / `deviceLimitBeforeReduction`
   * (for the downgrade grace in
   * {@link SharingDetectors.detectHwidOverage}). Returns only the ones we can
   * map — an unmapped identity is judged exactly as before, with no grace,
   * because "we have no row for this panel user" is not evidence of a
   * downgrade.
   *
   * MATCHED ON BOTH ANGLES, via {@link panelIdentityLookup}. The identities
   * arriving here are whatever the panel calls its users: 2.x uuids, or 3.x
   * decimals. A subscription linked during the 2.x era stores the uuid in
   * `remnawaveId` and keeps it after the operator upgrades, so on a 3.x panel
   * `remnawaveId IN (…)` misses that whole population — and the miss does not
   * merely blank the deep link, it withholds the downgrade grace and flags a
   * customer who legitimately reduced their plan. The helper carries the two
   * bounds that keep the numeric angle safe (digits-only, safe integer, and no
   * arm at all when the numeric list is empty).
   *
   * Neither column is unique in the schema, so an identity can in principle
   * match more than one row. The LATEST reduction wins: the grace exists to
   * stop a false accusation, and between two rows that disagree the one that
   * would suppress is the safe answer. The winning row is taken WHOLE —
   * timestamp and ceiling together — because a ceiling read off a different row
   * than the timestamp gating it describes a reduction that never happened.
   */
  private async resolveSubscriptions(
    identities: readonly string[],
  ): Promise<Map<string, SubscriptionFacts>> {
    const map = new Map<string, SubscriptionFacts>();
    const lookup = panelIdentityLookup(identities);
    if (lookup === null) return map;
    const rows = await this.prismaService.subscription.findMany({
      where: lookup.where,
      select: {
        remnawaveId: true,
        remnawavePanelId: true,
        userId: true,
        deviceLimitReducedAt: true,
        deviceLimitBeforeReduction: true,
      },
    });
    for (const row of rows) {
      const candidate: SubscriptionFacts = {
        userId: row.userId,
        deviceLimitReducedAt: row.deviceLimitReducedAt ?? null,
        deviceLimitBeforeReduction: row.deviceLimitBeforeReduction ?? null,
      };
      // Keyed by the identity the CALLER asked about, not by `row.remnawaveId`:
      // on a 3.x panel those are different strings for the same profile, and
      // keying by the row would re-lose the match the widened `where` recovered.
      for (const key of lookup.keysFor(row)) {
        const existing = map.get(key);
        if (
          existing !== undefined &&
          existing.deviceLimitReducedAt !== null &&
          (candidate.deviceLimitReducedAt === null ||
            candidate.deviceLimitReducedAt <= existing.deviceLimitReducedAt)
        ) {
          continue;
        }
        map.set(key, candidate);
      }
    }
    return map;
  }
}

/**
 * Why the concurrent-IP detector could not see who is connected this run.
 *
 * `reason` is the latch key and the stable token a test can assert on; `message`
 * is the operator-facing half. All three are things the RUN observed, not
 * things a version number implied — the classification this replaces read
 * `liveIpControl` / `connectionsApi` off the capability record and could
 * therefore only ever describe the panel's era, never its behaviour. Its
 * `immature_ip_control` arm named a 2.x build `LegacyPanelRefusal` now turns
 * away centrally, and its `panel_shape_unknown` arm fired on a version probe
 * blip against a panel that was answering everything else perfectly well.
 *
 *   `panel_user_list_unreadable`   — no device limits and no way to attribute
 *      an online panel id to a subscriber. Everything downstream is unsound.
 *   `node_list_unreadable`         — nothing to scan, and no way to tell that
 *      from a panel with no connected nodes.
 *   `live_connections_unreadable`  — every connected node was scanned and not
 *      one of them answered. The run examined nobody.
 *
 * A run that reads SOME nodes is not blind: it is incomplete, which is a
 * different (and separately logged) fact.
 */
interface LiveConnectionBlindness {
  readonly reason:
    | 'panel_user_list_unreadable'
    | 'node_list_unreadable'
    | 'live_connections_unreadable';
  readonly message: string;
}

/** One row of the panel's device inventory, as this detector reads it. */
interface DeviceBinding {
  readonly panelUserId: number;
  /**
   * `platform|deviceModel`, lower-cased, or `null` when the client described
   * neither. `null` is a THIRD state and not a synonym for "they disagree":
   * a row that says nothing about itself neither confirms nor denies that two
   * bindings are the same machine, and scoring it either way would invent
   * evidence.
   */
  readonly descriptor: string | null;
  readonly platform: string | null;
  readonly deviceModel: string | null;
  readonly boundAt: { readonly ms: number; readonly iso: string } | null;
}

/** One panel profile holding a device that other profiles hold too. */
interface SharedDeviceProfile {
  readonly panelUserId: number;
  readonly username: string;
  /** What `Subscription.remnawaveId` would hold — see `buildPanelUserFacts`. */
  readonly identity: string;
}

/** One hwid seen under more than one panel profile. */
interface SharedDeviceGroup {
  readonly hwid: string;
  readonly bindings: readonly DeviceBinding[];
  readonly profiles: readonly SharedDeviceProfile[];
}

/** Local facts about the subscription behind a Remnawave profile. */
interface SubscriptionFacts {
  readonly userId: string;
  /** `Subscription.deviceLimitReducedAt` — `null` when never reduced. */
  readonly deviceLimitReducedAt: Date | null;
  /**
   * `Subscription.deviceLimitBeforeReduction` — the limit that reduction
   * reduced FROM. `0` = previously unlimited; `null` = never recorded (either
   * no reduction at all, or a stamp older than the column).
   */
  readonly deviceLimitBeforeReduction: number | null;
}

/**
 * A recent device-limit reduction that accounts for PART of an overage: the
 * offender holds more devices than `previousLimit`, so the reduction cannot
 * excuse them, but it does explain `previousLimit` of the devices they hold.
 *
 * `null` on a judged offender means the overage is theirs in full — no recent
 * reduction, or one that explains nothing they are not already over.
 */
interface ExplainedByReduction {
  readonly reducedAt: Date;
  /** Strictly greater than the current plan limit, and strictly below `devices`. */
  readonly previousLimit: number;
}

interface IpAggregate {
  readonly ip: string;
  readonly lastSeen: string;
  /** `Date.parse(lastSeen)`, guaranteed finite — samples that fail it are dropped. */
  readonly lastSeenMs: number;
  readonly nodeName: string;
  readonly countryCode: string | null;
}

/**
 * How long a node connectivity change keeps the concurrent-IP detector quiet.
 *
 * MUST stay equal to the constant of the same name in `remnawave-detectors.ts`,
 * which owns the reasoning: 30 minutes is six collector samples and six
 * detector runs at the 5-minute cadence both sides run at, short enough that a
 * genuine offender is not shielded for hours after a routine restart, long
 * enough to cover the reconnect tail after connectivity is nominally restored.
 * It is re-declared here only because that file is not exported from and is not
 * this change's to edit.
 */
const NODE_STABILITY_WINDOW_MINUTES = 30;

/**
 * How long a device-limit REDUCTION can account for devices registered before
 * it. Same shape and same reason as {@link NODE_STABILITY_WINDOW_MINUTES}: a
 * bounded window in which part of what we are looking at is our own doing.
 *
 * It is a window, NOT an exemption. Inside it the detector still judges every
 * device beyond the limit the customer had before the change; all the window
 * decides is how long "they held these already" stays a usable explanation.
 *
 * WHY FOURTEEN DAYS.
 * Bounded above by what it must not become. A monthly billing cycle is the unit
 * a customer experiences, so anything at or beyond ~30 days would let a
 * subscription sit permanently under the softer treatment by re-downgrading once
 * a month; at 14 it has expired well before the next renewal, and a customer who
 * is genuinely over a limit they have had for a fortnight is named with the
 * unchanged thresholds at full confidence.
 *
 * Bounded below by what the customer has to do. Nobody tells them the limit
 * moved, so the first they are likely to hear of it is the next time they set up
 * a device — for a spare tablet or a work laptop, easily a week or two out. They
 * then have to open the cabinet's device list and pick which HWIDs to drop
 * (`InternalUserDevicesController`). A window of hours or a couple of days would
 * accuse most of them before they had any way of knowing.
 *
 * NOT an operator tunable, and deliberately. The panel-managed knobs in
 * `AntiFraudTunablesService` are DETECTION parameters — what counts as
 * suspicious. This is not one: it is a fairness bound on the part of an
 * accusation we already know to be unfounded, and an operator who shortened it
 * to zero would simply restore the defect it exists to fix. It sits here as a
 * constant for the same reason the node-stability window does.
 *
 * WHAT STOPS IT BEING BOUGHT. Not the panel — see `detectHwidOverage`: the HWID
 * limit is bypassable, which is why this detector exists, so "they cannot
 * register more while over" is not available as an argument and a downgrade is
 * cheap for a sharer. What stops it is that the window now only ever explains
 * devices up to `Subscription.deviceLimitBeforeReduction`. Downgrading buys a
 * sharer a ceiling they already had and were already being measured against; it
 * cannot buy them one device more than that.
 */
const HWID_DOWNGRADE_GRACE_DAYS = 14;

/**
 * CONFIDENCE CEILING for an ordinary HWID overage — the most this detector's
 * evidence can be worth when the margin is conclusive, the surplus is several
 * devices, and the panel read was complete.
 *
 * It is the literal this detector used to report about every overage it ever
 * found, kept here so the TOP of the range is unchanged and every difference
 * the evidence model makes is downward. See `confidence.util.ts`.
 */
const UNEXPLAINED_OVERAGE_CONFIDENCE = 80;

/**
 * Confidence CEILING for an overage a recent limit reduction explains only PART
 * of, against the {@link UNEXPLAINED_OVERAGE_CONFIDENCE} an unexplained overage
 * of the same size can reach.
 *
 * The evidence really is weaker, and the number has to say so. Some of the
 * devices being counted are ones we know the customer held legitimately days
 * ago, we cannot say WHICH of the current registrations those are, and an
 * operator acting on the signal will be met with a true mitigating fact. What
 * survives is still strong — registered devices beyond a ceiling we ourselves
 * authorised, on a panel limit that does not stop anyone — so this stays above
 * the {@link IP_SHARING_CONFIDENCE} the advisory concurrent-IP detector
 * carries, and well clear of the severity thresholds, which are untouched and
 * do their own weakening: the same count measured from the higher pre-reduction
 * baseline lands a step lower on its own, without any special case.
 *
 * It is a CEILING and not a value: the ratio/surplus factors still apply on top
 * of it, measured from the pre-reduction baseline, so a partly-explained
 * overage that is barely over that baseline lands far below 65 — which is the
 * point, because that is the weakest accusation this detector can make.
 */
const PARTLY_EXPLAINED_CONFIDENCE = 65;

/**
 * Confidence CEILING for the advisory concurrent-IP detector — again the
 * literal it used to report unconditionally.
 *
 * Lower than either HWID ceiling because the underlying fact is weaker in kind
 * and not merely in degree: HWID counts device registrations the panel holds,
 * while this infers simultaneity from `{ ip, lastSeen }` pairs with no session
 * intervals to intersect (see the class header). No amount of agreement among
 * the factors can turn an inference into an observation, so the best case stays
 * where it was.
 */
const IP_SHARING_CONFIDENCE = 60;

/**
 * Best case for a cross-account device finding.
 *
 * Below the 80 an unexplained device overage reports, and deliberately. An
 * overage is measured against a number WE set and the panel enforces; this is
 * measured against an identifier the client chose and nothing verifies. A
 * duplicate is strong evidence — two installs do not collide by accident — but
 * it is evidence about what a client reported, and the ceiling says so. Above
 * the 60 the IP detector reports, because a matching hwid is a far narrower
 * coincidence than two addresses in one subnet.
 */
const SHARED_HWID_CONFIDENCE = 75;

/**
 * How many profiles of one shared device are spelled out in signal metadata.
 *
 * The account ceiling already bounds the customers; this bounds the PROFILES,
 * which is a larger number whenever one of those customers holds several
 * subscriptions. Metadata is rendered inside a table row, so a group that
 * exceeds this reports its full counts and a prefix of its members.
 */
const SHARED_HWID_MAX_PROFILES_IN_METADATA = 20;

/**
 * Longest hwid this detector will treat as a device identifier.
 *
 * The contract declares `hwid` as an unbounded `z.string()` and the value is
 * chosen by the client, so nothing upstream stops a very long one. It reaches
 * a `FraudSignal.fingerprint` that carries a UNIQUE index, and PostgreSQL's
 * btree refuses a key past roughly 2700 bytes — which would turn a hostile
 * client's registration into a failing upsert on every detector run. 256 is far
 * above any real identifier (a uuid is 36, a sha-256 hex is 64) and far below
 * that limit.
 */
const MAX_HWID_LENGTH = 256;

/**
 * What fraction of the panel a strict bulk read actually returned, as the
 * `dataQuality` input to {@link computeConfidence}.
 *
 * `complete: true` is the whole list — quality 1, and the overwhelmingly common
 * case. `complete: false` means the walk stopped at the adapter's page ceiling
 * and `users` is a valid PREFIX; the panel's own `total` then measures the
 * shortfall directly. When the panel reported no usable total the adapter falls
 * back to `total = users.length`, so the ratio would come out at 1 and claim a
 * complete read — that case gets {@link TRUNCATED_UNKNOWN_COVERAGE} instead.
 *
 * Only an explicit `false` is read as a truncation claim. `complete` is a
 * required field of `RemnawavePanelUserList`, so an absent one can only come
 * from a hand-built stub, and a stub means "a normal, complete read".
 */
function panelReadCoverage(read: {
  /** Rows actually in hand. */
  readonly held: number;
  /** The panel's own count of the rows it holds. */
  readonly population: number;
  readonly complete: boolean;
}): number {
  if (read.complete !== false) return 1;
  const held = read.held;
  const population = read.population;
  if (!Number.isFinite(population) || population <= held) return TRUNCATED_UNKNOWN_COVERAGE;
  if (held <= 0) return 0;
  return held / population;
}

/**
 * Coverage assumed for a read we KNOW is a prefix but cannot size — the panel
 * refused to say how many rows it holds.
 *
 * Half, because that is the honest midpoint of "somewhere between one row more
 * than we hold and arbitrarily many": treating it as complete would be the one
 * answer we know to be false, and treating it as near-zero would collapse every
 * signal on such a panel to the floor when the rows we do hold are all real.
 */
const TRUNCATED_UNKNOWN_COVERAGE = 0.5;

interface NodeSnapshotEntry {
  readonly uuid: string;
  readonly name: string;
  readonly isConnected: boolean;
}

/** Tolerant read of `RemnawaveMetricSample.nodesSnapshot` (untyped JSON). */
function parseNodesSnapshot(raw: unknown): readonly NodeSnapshotEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: NodeSnapshotEntry[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const uuid = record['uuid'];
    const isConnected = record['isConnected'];
    if (typeof uuid !== 'string' || uuid.length === 0) continue;
    if (typeof isConnected !== 'boolean') continue;
    out.push({
      uuid,
      name: typeof record['name'] === 'string' ? record['name'] : uuid,
      isConnected,
    });
  }
  return out;
}

/** A non-empty trimmed string, or `null`. */
function readOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * How a device row describes the machine it is bound to: `platform|deviceModel`,
 * lower-cased so casing differences between client builds are not read as two
 * different machines. `null` when the row describes neither.
 */
function deviceDescriptor(record: Record<string, unknown>): string | null {
  const parts = [readOptionalString(record['platform']), readOptionalString(record['deviceModel'])]
    .filter((part): part is string => part !== null)
    .map((part) => part.toLowerCase());
  return parts.length === 0 ? null : parts.join('|');
}

/**
 * What share of the self-describing rows for one hwid agree about the machine.
 *
 * `1` = every row that said anything said the same thing, which is what one real
 * machine registered under two identities looks like. Below 1 the rows disagree,
 * and a single identifier reported by devices that are demonstrably not the same
 * device is the signature of a client sending a constant value rather than of
 * somebody lending a laptop out.
 *
 * `null` — NOT `1` — when fewer than two rows describe themselves at all. There
 * is nothing to compare, and reporting perfect agreement for an unmeasured
 * factor would raise an accusation's confidence on evidence that was never
 * collected. The caller drops the factor entirely rather than scoring it.
 */
function descriptorAgreement(bindings: readonly DeviceBinding[]): number | null {
  const described = bindings
    .map((binding) => binding.descriptor)
    .filter((descriptor): descriptor is string => descriptor !== null);
  if (described.length < 2) return null;
  const counts = new Map<string, number>();
  for (const descriptor of described) {
    counts.set(descriptor, (counts.get(descriptor) ?? 0) + 1);
  }
  return Math.max(...counts.values()) / described.length;
}

/**
 * An hwid as it appears in operator-facing prose. The full value is in the
 * signal metadata; a 64-character hex string in the middle of a sentence is
 * unreadable and is what the description is competing with.
 */
function shortHwid(hwid: string): string {
  return hwid.length <= HWID_PROSE_LENGTH ? hwid : `${hwid.slice(0, HWID_PROSE_LENGTH)}…`;
}

const HWID_PROSE_LENGTH = 20;

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * How long ago `from` was, for operator-facing prose only — the exact instant is
 * in the signal metadata. Whole days, floored, with the under-a-day case spelled
 * out rather than rendered as a confusing "0d ago".
 */
function describeAge(from: Date, to: Date): string {
  const days = Math.floor((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000));
  return days <= 0 ? 'less than a day ago' : `${days}d ago`;
}

function clampScore(value: number): number {
  if (value < 0) return 0;
  if (value > 100) return 100;
  return Math.round(value);
}

/**
 * How a failed panel read is rendered into an operator-facing log line.
 *
 * Every arm is named, and `unreadable` is named separately from `rejected` on
 * purpose: they are different operator actions. `rejected` is the panel saying
 * no — a token, a permission, a route. `unreadable` is the panel saying yes and
 * answering a shape this build could not find the data in, which is a contract
 * problem somebody has to look at. Collapsing them into "the panel did not
 * answer" is what the old adapter did, and it is why a malformed request could
 * 400 on every run for months while the detector reported a clean panel.
 */
function describeReadFailure(outcome: PanelReadOutcome<unknown>): string {
  switch (outcome.kind) {
    case 'ok':
      // Unreachable by construction — every caller checks `kind` first — but a
      // silent empty string here would read as "no reason given" in the log.
      return 'the read succeeded';
    case 'rejected':
      return `the panel refused it: HTTP ${outcome.status}${
        outcome.code === null ? '' : ` ${outcome.code}`
      }`;
    case 'network':
      return `nothing came back: ${outcome.detail}`;
    case 'unconfigured':
      return 'the Remnawave connection is not configured';
    case 'invalid-request':
      return `rezeis built the request wrong and it was never sent: ${outcome.detail}`;
    case 'unreadable':
      return `the panel answered a shape this build could not read: ${outcome.detail}`;
  }
}

/** One panel profile's facts, as both detectors need them. */
interface PanelUserFacts {
  /** What `Subscription.remnawaveId` holds for this profile — see the builder. */
  readonly identity: string;
  readonly username: string;
  readonly limit: number;
}

/**
 * A timestamp the panel sent, as both the milliseconds the window arithmetic
 * needs and the ISO string the signal metadata carries.
 *
 * BOTH SHAPES ARE READ, and neither is a fallback for sloppiness. The vendor
 * contract transforms every `lastSeen` / `lastStatusChange` into a `Date`, so
 * that is what a validated response yields; on the executor's DRIFT path the
 * panel's raw bytes come back instead and the same field is the wire string.
 * A reader that handled only one of them would silently drop every sample from
 * a panel whose response the pinned contract does not fully accept — and
 * dropping samples here means under-counting networks, which means not naming
 * a sharer.
 *
 * `null` for anything that is not a placeable instant. Fail-open is the wrong
 * direction for evidence: a sighting we cannot place in time cannot show
 * simultaneity, so it is dropped and counted rather than treated as current.
 */
function readInstant(value: unknown): { readonly ms: number; readonly iso: string } | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? { ms, iso: value.toISOString() } : null;
  }
  if (typeof value === 'string' && value.length > 0) {
    const ms = Date.parse(value);
    // The ORIGINAL string is kept, not a re-rendered one: it is what the panel
    // said, and an operator comparing a signal against the panel's own view
    // should see the same characters.
    return Number.isFinite(ms) ? { ms, iso: value } : null;
  }
  return null;
}

// Re-exported for tests that want to assert on the resolved config shape.
export type { SharingDetectionConfig };

// Exported so a test can name the blindness it expects by its stable token
// rather than by matching prose.
export type { LiveConnectionBlindness };
