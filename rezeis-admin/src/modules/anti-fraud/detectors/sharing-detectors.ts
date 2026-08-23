import { Injectable, Logger } from '@nestjs/common';
import { FraudSignalSeverity } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { RemnawaveNodeInterface } from '../../remnawave/interfaces/remnawave-node.interface';
import { describeStrictOutcome } from '../../remnawave/interfaces/remnawave-strict-outcome.interface';
import { RemnawaveApiService } from '../../remnawave/services/remnawave-api.service';
import { panelIdentityLookup } from '../../remnawave/services/panel-user-address';
import {
  RemnawaveVersionService,
  type RemnawaveCapabilities,
} from '../../remnawave/services/remnawave-version.service';
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
 * Two complementary signals:
 *   - HWID over-limit: a user has more *registered devices* than their plan's
 *     `hwidDeviceLimit` (cheap, uses the top-users endpoint).
 *   - Concurrent-IP: a user is connected from more *distinct networks* than
 *     their device limit, at the same time (uses whichever live-connection
 *     family the panel serves behind its "Active sessions" view —
 *     `/api/ip-control/*` on 2.8+, `/api/connections/*` on 3.x, picked by the
 *     adapter from the detected panel shape).
 *
 * Both resolve the Remnawave user to a rezeis user id (via
 * `Subscription.remnawaveId`) for deep-linking, and fail soft so a panel
 * outage never aborts the cron detector batch.
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
   * True once the HWID device endpoint has answered "nobody" for a panel that
   * demonstrably has users, and until it answers with rows again — the latch
   * behind the transition-only WARN in {@link detectHwidOverage}.
   *
   * Same shape and same reason as `RemnawaveDetectors.perUserTrafficBlind`:
   * process-local, deliberately not persisted, and a restart re-announcing a
   * still-blind detector once is the useful direction to be wrong in.
   */
  private hwidTopUsersBlind = false;

  /**
   * Which blindness the concurrent-IP detector last announced, or `null` while
   * it can actually see. Keyed by REASON rather than a bare boolean so a panel
   * that moves between states (2.7 → 3.x, reachable → unreachable) re-announces
   * once per state instead of staying quiet under a stale latch.
   */
  private concurrentIpBlindReason: LiveConnectionBlindness['reason'] | null = null;

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly remnawaveApiService: RemnawaveApiService,
    private readonly versionService: RemnawaveVersionService,
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
        this.remnawaveApiService.getHwidTopUsers(),
        this.buildDeviceLimitByUuid(),
      ]);
      // A partial device-limit map does not under-report — it MIS-reports. A
      // user whose row we lost reads back as limit 0 and is silently dropped,
      // while everyone else is still judged, so the run looks healthy. Skip.
      if (panelLimits === null) {
        this.logger.warn('HWID overage detection skipped: the panel user list is not trustworthy');
        return [];
      }
      const { limitByUuid, coverage } = panelLimits;
      if (topUsers.length === 0) {
        // "NOBODY HAS A DEVICE" AND "WE COULD NOT READ THE DEVICE LIST" ARRIVE
        // AS THE SAME EMPTY ARRAY, and until this branch existed the second one
        // returned in silence — a detector reporting a clean panel forever.
        //
        // The distinction is destroyed one layer down: `getHwidTopUsers` wraps
        // its request in `try { … } catch { return [] }`, so a 404, a 401 and a
        // panel that genuinely has no registered devices are one value by the
        // time they get here. Restoring it properly means teaching the adapter
        // to report the failure — `src/modules/remnawave/**`, which this change
        // does not own. What IS available here is the contradiction: the strict
        // panel-user read above just vouched for a list of users, and an
        // endpoint that answers "not one of them has ever registered a device"
        // about a populated panel is far more likely to be a read we cannot
        // make than a fact. Remnawave 3.x moved the `/api/hwid/*` family, which
        // is exactly how a live panel arrives in this state.
        //
        // An empty panel is NOT this: no users means no devices, consistently,
        // so it stays silent.
        await this.reportHwidBlind(limitByUuid.size);
        return [];
      }
      this.clearHwidBlind();

      const offenders = topUsers
        .map((u) => ({
          uuid: u.userUuid,
          username: u.username,
          devices: u.devicesCount,
          limit: limitByUuid.get(u.userUuid) ?? 0,
        }))
        .filter((u) => u.limit > 0 && u.devices > u.limit);
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

  // ── Detector: concurrent-IP sharing ─────────────────────────────────────

  public async detectConcurrentIpSharing(now: Date): Promise<readonly FraudSignalCandidate[]> {
    const config = await this.resolveConfig();
    if (!config.enableIpSharing) return [];
    // WHY THIS IS NOT `if (!caps.liveIpControl) return []` ANY MORE.
    //
    // That test had one true answer and three different meanings, and it
    // reported the same silent nothing for all of them. Two questions are
    // asked separately instead:
    //
    //   • does the panel HAVE live-connection data?  `connectionsApi`
    //   • can this detector READ it?                 `liveIpControl`
    //
    // A "no" to the second is a blind detector whatever the first says, and it
    // now says so out loud instead of returning a clean-looking empty list.
    //
    // WHAT IS TRUE OF A 3.x PANEL TODAY, because this comment used to say the
    // opposite and read as a live defect report rather than as history. It
    // stated that `liveIpControl` is `major === 2 && minor >= 8` and that
    // `fetchUsersIpsForNode` "is hard-wired to the `/api/ip-control/*` family
    // 3.x deleted", so every call 404s. Both halves are now false, and a reader
    // who believes them concludes this detector is dead on the operator's 3.3.2
    // panel — which would mean either "fixing" working code or discounting a
    // real signal:
    //
    //   • `liveIpControl` is `major === 3 || (major === 2 && minor >= 8)`, so a
    //     3.x panel reports TRUE;
    //   • the adapter reads both families and picks by the DETECTED PANEL
    //     SHAPE — `fetchUsersIpsForNode`, `fetchUserIps` and `dropConnections`
    //     each branch on `connectionsApi`, taking `/api/connections/*` on 3.x
    //     and `/api/ip-control/*` on 2.8+.
    //
    // So on 3.x this detector runs, and the blindness classifier below has no
    // `connections` branch left to take — see the note there.
    //
    // Returning `[]` is still the only safe output when it IS blind — see the
    // class header and `AntiFraudService`'s `observational` evidence class: an
    // empty run from a panel-backed detector is no information at all and must
    // never auto-resolve anybody's open signal.
    const caps = await this.versionService.getCapabilities();
    const blindness = classifyLiveConnectionBlindness(caps);
    if (blindness !== null) {
      this.reportConcurrentIpBlind(blindness);
      return [];
    }
    this.clearConcurrentIpBlind();
    try {
      // Degrade, never guess: this detector writes a fraud signal keyed by
      // `day|uuid`, and a uuid-less row would collide every such user onto one
      // fingerprint. An unvouched-for list is skipped with a warning rather
      // than quietly under-detecting for a run.
      const bulk = await this.remnawaveApiService.strictGetAllPanelUsers();
      if (bulk.kind !== 'ok') {
        this.logger.warn(
          `Concurrent-IP detection skipped: the panel user list is not trustworthy (${describeStrictOutcome(bulk)})`,
        );
        return [];
      }
      const panelUsers = bulk.value.users;
      if (panelUsers.length === 0) return [];
      const coverage = panelReadCoverage(bulk.value);

      // panelId → { uuid, username, limit } (ip-control keys online users by panel id)
      const byPanelId = new Map<number, { uuid: string; username: string; limit: number }>();
      for (const u of panelUsers) {
        if (u.panelId !== null) {
          byPanelId.set(u.panelId, { uuid: u.uuid, username: u.username, limit: u.hwidDeviceLimit ?? 0 });
        }
      }

      const nodes = (await this.remnawaveApiService.getAllNodes()) ?? [];

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

      // Sort before slicing. `getAllNodes` returns the panel's order, which is
      // not stable, so an unsorted `.slice()` scans a different set of nodes
      // from one run to the next — and the distinct-IP count that this whole
      // accusation rests on is taken over exactly those nodes. Sorting by uuid
      // makes the same panel produce the same slice, so a user's verdict stops
      // depending on which nodes the panel happened to list first.
      const connected = nodes
        .filter((n) => n.isConnected && !n.isDisabled)
        .sort((a, b) => a.uuid.localeCompare(b.uuid))
        .slice(0, config.maxNodesPerRun);
      if (connected.length === 0) return [];

      const nowMs = now.getTime();
      const staleBefore = nowMs - config.ipWindowMinutes * 60_000;
      // panelId → ip → sample
      const byUser = new Map<string, Map<string, IpAggregate>>();
      let undatedSamples = 0;

      let unreadableNodes = 0;
      for (const node of connected) {
        const rows = await this.remnawaveApiService.fetchUsersIpsForNode(node.uuid);
        // `null` is "this node could not be read", not "this node was quiet".
        // Counting it is the whole point: a node whose collection job failed or
        // timed out contributes nobody, and without this the run would report a
        // clean panel having looked at a fraction of it.
        if (rows === null) {
          unreadableNodes += 1;
          continue;
        }
        for (const row of rows) {
          for (const sample of row.ips) {
            const lastSeenMs = Date.parse(sample.lastSeen);
            // An unparseable timestamp used to be KEPT — `Number.isFinite(seen)
            // && seen < windowStart` only excluded samples it could read, so a
            // malformed `lastSeen` counted as in-window and as concurrent with
            // everything else. Fail-open is the wrong direction for evidence:
            // a sighting we cannot place in time cannot show simultaneity.
            if (!Number.isFinite(lastSeenMs)) {
              undatedSamples += 1;
              continue;
            }
            if (lastSeenMs < staleBefore) continue;
            let ipMap = byUser.get(row.userId);
            if (!ipMap) {
              ipMap = new Map<string, IpAggregate>();
              byUser.set(row.userId, ipMap);
            }
            const existing = ipMap.get(sample.ip);
            // The same IP can appear on several nodes. Keep the NEWEST sighting,
            // not the first node's: recency is now what decides concurrency, and
            // first-wins would date a live IP by whichever node we happened to
            // scan first and drop it out of its own user's cluster.
            if (existing !== undefined && existing.lastSeenMs >= lastSeenMs) continue;
            ipMap.set(sample.ip, {
              ip: sample.ip,
              lastSeen: sample.lastSeen,
              lastSeenMs,
              nodeName: node.name,
              countryCode: node.countryCode ?? null,
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
      let unreadablePanelIds = 0;
      for (const [panelIdStr, ipMap] of byUser) {
        const panelId = parsePanelId(panelIdStr);
        if (panelId === null) {
          unreadablePanelIds += 1;
          continue;
        }
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
          uuid: meta.uuid,
          username: meta.username,
          limit: meta.limit,
          ips,
          observedIpCount: observed.length,
          distinctNetworks,
        });
      }
      if (unreadablePanelIds > 0) {
        // Never silent: the old code turned `3f2a-…` into panel user #3 and
        // filed those IPs against whoever that was.
        this.logger.warn(
          `Concurrent-IP detection skipped ${unreadablePanelIds} ip-control row(s) whose ` +
            'userId is not an integer panel id — they cannot be attributed to a user without guessing',
        );
      }
      // A node that could not be read contributes nobody, and nobody is what a
      // clean panel also contributes. Said out loud, at a level proportional to
      // how much of the panel went unseen: the run is still worth completing on
      // the nodes that answered, but its silence is not evidence.
      if (unreadableNodes > 0) {
        const total = connected.length;
        const message =
          `Concurrent-IP detection could not read ${unreadableNodes} of ${total} connected node(s) — ` +
          'their live connections were NOT examined, so a clean result covers only the rest';
        if (unreadableNodes === total) {
          this.logger.warn(`${message}. This run saw nothing at all and proves nothing.`);
        } else {
          this.logger.warn(message);
        }
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
   * The HWID device endpoint returned nothing for a panel holding
   * `panelUserCount` users.
   *
   * WARN on the transition into blindness, debug on every run after it. This
   * runs every 5 minutes and the condition, once true, stays true until somebody
   * fixes the panel or the adapter — a line per run would be 288 copies a day of
   * the same text and would be tuned out exactly like the failure it exists to
   * surface. One WARN when the detector goes blind, one LOG when it recovers.
   * Once per RUN, never per user: the blindness is a property of the read, not
   * of anybody's account.
   */
  private async reportHwidBlind(panelUserCount: number): Promise<void> {
    // No users, no devices — a consistent, unremarkable empty panel.
    if (panelUserCount <= 0) return;
    if (this.hwidTopUsersBlind) {
      this.logger.debug('HWID overage detection still blind');
      return;
    }
    this.hwidTopUsersBlind = true;
    this.logger.warn(
      `HWID overage detection is BLIND: the panel user list vouches for ${panelUserCount} ` +
        'user(s), and the HWID device endpoint reports that not one of them has a ' +
        `registered device (${await this.describePanel()}). The adapter collapses a 404, ` +
        'a rejected request and a genuinely empty list into the same empty array, so ' +
        'this run cannot tell "nobody is over their limit" from "we could not look" — ' +
        'and Remnawave 3.x moved the `/api/hwid/*` family this reads. This detector ' +
        'will report zero offenders until that is resolved; it is not evidence of a ' +
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
      'Concurrent-IP detection recovered: the panel serves a live-connection family this ' +
        'detector can read',
    );
  }

  /**
   * The panel's self-reported version, for a log line and never for a decision.
   *
   * Swallows its own failure twice over: a message that cannot name the panel is
   * still worth sending, and a capability read that throws must not turn a blind
   * detector into a *failed* one — the caller sits inside the detector's
   * try/catch, where a throw would be reported as "HWID overage detection
   * failed" and lose the blindness it was trying to announce.
   */
  private async describePanel(): Promise<string> {
    try {
      const caps = await this.versionService.getCapabilities();
      return typeof caps.version === 'string' && caps.version.length > 0
        ? `panel version ${caps.version}`
        : 'the panel version could not be read';
    } catch {
      return 'the panel version could not be read';
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Map Remnawave subscription UUIDs → device limits via panel users, together
   * with how much of the panel that map actually covers.
   * Keyed by uuid for the HWID detector (top-users endpoint gives uuid).
   *
   * `null` when the bulk read could not be vouched for — a missing uuid is
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
  private async buildDeviceLimitByUuid(): Promise<{
    readonly limitByUuid: Map<string, number>;
    readonly coverage: number;
  } | null> {
    const bulk = await this.remnawaveApiService.strictGetAllPanelUsers();
    if (bulk.kind !== 'ok') {
      this.logger.warn(`Panel user list unusable: ${describeStrictOutcome(bulk)}`);
      return null;
    }
    const limitByUuid = new Map<string, number>();
    for (const u of bulk.value.users) {
      limitByUuid.set(u.uuid, u.hwidDeviceLimit ?? 0);
    }
    return { limitByUuid, coverage: panelReadCoverage(bulk.value) };
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
    liveNodes: readonly RemnawaveNodeInterface[],
  ): Promise<NodeFlapEvidence | null> {
    const windowStart = now.getTime() - NODE_STABILITY_WINDOW_MINUTES * 60_000;

    const recentlyChanged = liveNodes
      .filter((n) => !n.isDisabled)
      .filter((n) => {
        const changedAt = n.lastStatusChange ? Date.parse(n.lastStatusChange) : NaN;
        return Number.isFinite(changedAt) && changedAt >= windowStart;
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
 * Why the concurrent-IP detector cannot see who is connected this run.
 *
 * `reason` is the latch key and the stable token a test can assert on; `message`
 * is the operator-facing half. Two states, and they are two different operator
 * actions — which is the whole reason the old single `liveIpControl` test was
 * not good enough:
 *
 *   `immature_ip_control` — a 2.x panel below 2.8, where the active-session data
 *      exists but is not trustworthy. Fixed by upgrading the panel, and the
 *      detector lights up on its own when that happens.
 *   `panel_shape_unknown` — we do not know what the panel is. Version detection
 *      collapses 401 / timeout / DNS / unconfigured token into one "no version",
 *      so this is a rezeis-side configuration or connectivity problem.
 */
interface LiveConnectionBlindness {
  readonly reason: 'immature_ip_control' | 'panel_shape_unknown';
  readonly message: string;
}

/**
 * Can {@link SharingDetectors.detectConcurrentIpSharing} observe this panel?
 * `null` = yes; anything else is why not.
 *
 * Reads `connectionsApi` — the field the version service already exposes and its
 * own comment nominates as the eventual gate — for "does live-connection data
 * exist?", and `liveIpControl` for "can this detector read it?". Deliberately a
 * pure function of the capability record and nothing else, so the classification
 * is testable without a panel and cannot acquire a side effect later.
 */
function classifyLiveConnectionBlindness(
  caps: Pick<RemnawaveCapabilities, 'liveIpControl' | 'connectionsApi' | 'version'>,
): LiveConnectionBlindness | null {
  // `liveIpControl` is "this build can read live connections from this panel",
  // and the adapter backs that with BOTH families — `ip-control/*` from 2.8 up,
  // `connections/*` on 3.x — chosen by the detected panel shape. This line used
  // to read "the only family the adapter can currently read is `ip-control`,
  // and only from 2.8 up", which the note a dozen lines below already
  // contradicts: that window closed when the connections reader landed.
  // Everything else is blind, in one of the two ways the union above names.
  if (caps.liveIpControl) return null;
  const panel =
    typeof caps.version === 'string' && caps.version.length > 0
      ? `panel version ${caps.version}`
      : 'a panel version rezeis could not read';
  // There is deliberately no `connectionsApi === 'connections'` branch. It used
  // to exist, for the window in which a 3.x panel served live-connection data
  // the adapter could not read. That window closed: `connectionsApiFor` only
  // ever answers 'connections' for major 3, and `liveIpControl` is true for
  // major 3, so the branch became unreachable the moment the reader landed.
  // Keeping it would have left an operator-facing message asserting something
  // false ("rezeis cannot, until the adapter learns the connections family")
  // behind a condition no panel can satisfy.
  if (caps.connectionsApi === 'ip-control') {
    return {
      reason: 'immature_ip_control',
      message:
        `the panel reports ${panel}: \`/api/ip-control/*\` exists but did not mature ` +
        'until 2.8, and the active-session data older builds return is not reliable ' +
        'enough to accuse anybody with.',
    };
  }
  return {
    reason: 'panel_shape_unknown',
    message:
      `rezeis is running against ${panel}, so it cannot tell which live-connection ` +
      'family the panel serves. Every version-detection failure — 401, request ' +
      'timeout, DNS, an unconfigured token, a panel mid-restart — collapses into this ' +
      'one state, so the panel may well be fine and unreachable.',
  };
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
function panelReadCoverage(list: {
  readonly users: readonly unknown[];
  readonly total: number;
  readonly complete: boolean;
}): number {
  if (list.complete !== false) return 1;
  const held = list.users.length;
  const population = list.total;
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

// Re-exported for tests that want to assert on the resolved config shape.
export type { SharingDetectionConfig };

// Exported so the observability classification can be asserted directly, on
// every capability shape, without standing up a panel double per case.
export { classifyLiveConnectionBlindness };
export type { LiveConnectionBlindness };
