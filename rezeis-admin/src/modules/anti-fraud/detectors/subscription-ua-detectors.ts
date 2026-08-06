import { Injectable, Logger } from '@nestjs/common';
import { FraudSignalSeverity } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { RemnawaveSubscriptionRequestEntryInterface } from '../../remnawave/interfaces/remnawave-extended.interface';
import { describeStrictOutcome } from '../../remnawave/interfaces/remnawave-strict-outcome.interface';
import { RemnawaveApiService } from '../../remnawave/services/remnawave-api.service';
import { FraudSignalCandidate } from '../interfaces/fraud-signal.interface';
import { AntiFraudTunablesService } from '../services/anti-fraud-tunables.service';
import { SubscriptionUaDetectionConfig } from '../subscription-ua-detection.config';
import { findProxyConfigUri, redactUserAgentForEvidence } from '../subscription-ua.util';

/**
 * Subscription-fetch User-Agent detector — "our subscription is being pulled
 * by something that is carrying a proxy config".
 *
 * THE GAP THIS FILLS. Every other detector here counts things a *customer's
 * own devices* do: registered HWIDs, concurrent source networks, per-node
 * traffic. A party that re-hosts our subscription behind their own panel or
 * aggregator defeats all of them at once — from our side it is one endpoint,
 * fetching politely, on one address, with one device. The subscription-request
 * log is the only surface that sees it at all, and only through the UA.
 *
 * WHAT IS ACTUALLY BEING CLAIMED, AND HOW STRONG IT IS.
 * The claim is narrow and structural: this fetch's User-Agent contained a
 * proxy config URI (`vless://`, `trojan://`, `ss://`, …). A client
 * identifying itself sends `Product/Version (platform)`; it has no reason to
 * put a node config in that header. Software that does is passing an upstream
 * through — the double-tunnel / re-host signature.
 *
 * It is NOT a proof of resale, and it is filed accordingly: LOW/MEDIUM, never
 * HIGH. It proves pass-through, not payment, and it cannot see how many people
 * sit behind the pass-through. `subscription-ua.util.ts` documents the four
 * neighbouring heuristics (empty UA, HTTP library, browser UA, "mixed client
 * set") that were considered and refused as mass-false-positive for a customer
 * base that is actively encouraged to try several clients.
 *
 * WHAT IT CAN AND CANNOT SEE.
 * `GET /api/subscription-request-history` takes `size` and `start` and nothing
 * else on both 2.7.4 and 2.8.0 — no user filter, no time filter. So this reads
 * the newest `uaRequestPageSize` rows once per run and windows them itself.
 * When the whole page is newer than the window, the window was not fully
 * covered and the run says so rather than implying it saw everything.
 * Under-detection is the acceptable direction here; a silent claim of full
 * coverage is not.
 *
 * COST. One HTTP call in the overwhelmingly common case. The panel user list —
 * needed only to turn 2.8.0's numeric `userId` into a uuid — is fetched ONLY
 * once a config-carrying UA has actually been seen, so a clean panel never
 * pays for the 50-page walk.
 *
 * WIRED, SWITCHED OFF BY DEFAULT.
 * Registered in `AntiFraudService.runDetectors` as `observational` — it reads a
 * live panel surface, so an empty result can mean "we could not see" and must
 * never auto-resolve an open signal — and gated on the
 * `enableSubscriptionUaTunnel` panel tunable, which ships OFF. The window and
 * page size are the other two knobs; all three live in
 * `subscription-ua-detection.config.ts` and reach here through
 * `AntiFraudTunablesService`, so a change lands on the next run without a
 * restart.
 */
@Injectable()
export class SubscriptionUaDetectors {
  private readonly logger = new Logger(SubscriptionUaDetectors.name);

  /** True while the run is degraded by an uncovered evidence window. */
  private coverageWarningActive = false;

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly remnawaveApiService: RemnawaveApiService,
    private readonly tunablesService: AntiFraudTunablesService,
  ) {}

  /**
   * Effective subscription-UA tunables for this run: the operator's panel
   * value, else the built-in default.
   *
   * Resolved OUTSIDE the try/catch below, exactly as `SharingDetectors` does
   * it. If the settings row is unreadable this REJECTS: `runDetectors` then
   * records the detector as having observed nothing, so no signal is raised or
   * auto-resolved on the strength of a guess. Falling back to the default here
   * would silently re-enable a detector an operator had switched off.
   */
  private async resolveConfig(): Promise<SubscriptionUaDetectionConfig> {
    return (await this.tunablesService.resolve()).subscriptionUa;
  }

  /**
   * Users whose subscription was fetched by something carrying a proxy config.
   *
   * Returns `[]` both for "clean" and for "could not be read" — the caller
   * cannot tell those apart from the return value alone, which is why every
   * degraded path below logs at WARN before returning. That asymmetry is the
   * orchestrator's contract (`Promise.allSettled`, a rejected detector is not
   * "saw nothing"), and this detector stays inside it rather than throwing on
   * a panel that is merely unavailable.
   */
  public async detectSubscriptionUaTunnel(now: Date): Promise<readonly FraudSignalCandidate[]> {
    const config = await this.resolveConfig();
    // Switched off reports itself the same way the sharing detectors' switches
    // do: a silent `[]`, with no log, because a run that was never asked to look
    // is not an event. What makes that safe is the run plan, not this line — the
    // detector is registered `observational`, so an empty result keeps
    // `SUBSCRIPTION_UA_TUNNEL` out of the reconcile set and switching the
    // detector off cannot auto-resolve the signals it already raised.
    if (!config.enableSubscriptionUaTunnel) return [];
    try {
      const page = await this.remnawaveApiService.strictGetSubscriptionRequestHistory(
        config.uaRequestPageSize,
      );
      if (page.kind !== 'ok') {
        // Loud, and specific about which failure it was: an `invalidContract`
        // here means the panel changed the log's shape and this detector is
        // blind until someone looks, which is a different operator action from
        // "the panel was briefly down".
        this.logger.warn(
          `Subscription-UA detection skipped: the subscription request log is not readable ` +
            `(${describeStrictOutcome(page)})`,
        );
        return [];
      }

      const windowMinutes = config.uaEvidenceWindowMinutes;
      const nowMs = now.getTime();
      const windowStartMs = nowMs - windowMinutes * 60_000;
      const records = page.value.records;

      let undatedRecords = 0;
      let oldestInPageMs: number | null = null;
      const windowed: RemnawaveSubscriptionRequestEntryInterface[] = [];
      for (const record of records) {
        const atMs = Date.parse(record.requestedAt);
        if (!Number.isFinite(atMs)) {
          // A fetch we cannot place in time cannot be placed in the window
          // either. Keeping it would let an arbitrarily old record be judged as
          // if it had just happened.
          undatedRecords += 1;
          continue;
        }
        oldestInPageMs = oldestInPageMs === null ? atMs : Math.min(oldestInPageMs, atMs);
        if (atMs < windowStartMs) continue;
        windowed.push(record);
      }
      if (undatedRecords > 0) {
        this.logger.warn(
          `Subscription-UA detection dropped ${undatedRecords} request record(s) with an ` +
            'unreadable requestAt — the panel is sending timestamps this detector cannot ' +
            'parse, so its view of the evidence window is incomplete',
        );
      }

      // Coverage: the page is capped at `size` and cannot be filtered by time,
      // so a FULL page whose oldest row is still inside the window means the
      // window extends past what we were served.
      const windowFullyCovered =
        records.length < page.value.requestedSize ||
        (oldestInPageMs !== null && oldestInPageMs < windowStartMs);
      this.reportCoverage(windowFullyCovered, page.value.total, records.length, windowMinutes);

      // Classify first, resolve identities second. The overwhelmingly common
      // outcome is zero hits, and that outcome must not cost a panel-wide user
      // walk.
      const hits: UaHit[] = [];
      for (const record of windowed) {
        const finding = findProxyConfigUri(record.userAgent);
        if (finding === null) continue;
        hits.push({
          userUuid: record.userUuid,
          panelUserId: record.panelUserId,
          scheme: finding.scheme,
          percentEncoded: finding.percentEncoded,
          // Redacted at the point of capture, never after: a `vless://` UA
          // carries the client uuid and a `trojan://` UA carries the password.
          evidence: redactUserAgentForEvidence(record.userAgent ?? ''),
          requestedAt: record.requestedAt,
          ipAddress: record.ipAddress,
        });
      }
      if (hits.length === 0) return [];

      const attributed = await this.attributeHits(hits);
      if (attributed === null) return [];
      if (attributed.size === 0) return [];

      const subscriptionUserIdByUuid = await this.resolveRezeisUserIds([...attributed.keys()]);
      const day = utcDay(now);

      return [...attributed.entries()].map(([uuid, group]) => {
        const rezeisUserId = subscriptionUserIdByUuid.get(uuid) ?? null;
        const schemes = [...new Set(group.map((h) => h.scheme))].sort();
        // Repetition is the only strength gradient available: one sighting can
        // be a one-off experiment by the customer themselves, a sustained
        // pattern is something operating continuously. Neither reaches HIGH —
        // see the class note.
        const repeated = group.length >= REPEAT_OCCURRENCE_THRESHOLD;
        return {
          code: 'SUBSCRIPTION_UA_TUNNEL',
          fingerprint: `${day}|${uuid}`,
          severity: repeated ? FraudSignalSeverity.MEDIUM : FraudSignalSeverity.LOW,
          title: 'Subscription fetched by a client carrying a proxy config',
          description:
            `${group.length} subscription fetch(es) in the last ${windowMinutes}m ` +
            `arrived with a User-Agent carrying a proxy config URI (${schemes.join(', ')}). ` +
            'A client identifying itself sends a product name, not a node config; a UA that ' +
            'carries one indicates the subscription is being pulled through another panel, ' +
            'aggregator, or tunnel rather than by the customer\'s own client. This is evidence ' +
            'of pass-through, not proof of resale.',
          // Deliberately modest and flat. The count of observations is a
          // property of how chatty the fetcher is, not of how bad it is, so it
          // moves the score only slightly.
          score: clampScore(25 + Math.min(group.length, 10) * 2),
          // Structural evidence, one inferential step from the conclusion. The
          // concurrent-IP detector — a stronger, count-based signal — files at
          // 60, so a single UA sighting sits below it and a sustained pattern
          // just above.
          confidence: repeated ? 65 : 50,
          affectedUserIds: rezeisUserId !== null ? [rezeisUserId] : [],
          metadata: {
            kind: 'ua_tunnel',
            remnawaveUuid: uuid,
            occurrences: group.length,
            schemes,
            percentEncoded: group.some((h) => h.percentEncoded),
            windowMinutes,
            // Carried into the signal, not just the log: an operator reading
            // this row later has to know the run only saw part of its window.
            windowFullyCovered,
            recordsScanned: records.length,
            panelLogTotal: page.value.total,
            detectedVersion: page.detectedVersion,
            samples: group.slice(0, MAX_SAMPLES_IN_METADATA).map((h) => ({
              at: h.requestedAt,
              ip: h.ipAddress,
              scheme: h.scheme,
              userAgent: h.evidence,
            })),
          },
        } satisfies FraudSignalCandidate;
      });
    } catch (error) {
      this.logger.warn(`Subscription-UA detection failed: ${(error as Error).message}`);
      return [];
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Group hits by Remnawave uuid, resolving 2.8.0's numeric ids on the way.
   *
   * `null` means the run must be abandoned: 2.8.0 records identify their owner
   * only by the panel-internal integer, and without a trustworthy user list
   * that integer cannot become a uuid. Guessing is not available — the
   * fingerprint is keyed by uuid, so a wrong mapping does not merely mislabel a
   * row, it files one customer's evidence against another.
   */
  private async attributeHits(hits: readonly UaHit[]): Promise<Map<string, UaHit[]> | null> {
    const byUuid = new Map<string, UaHit[]>();
    const needsPanelLookup = hits.filter((h) => h.userUuid === null && h.panelUserId !== null);
    const unattributable = hits.filter((h) => h.userUuid === null && h.panelUserId === null);
    if (unattributable.length > 0) {
      this.logger.warn(
        `Subscription-UA detection dropped ${unattributable.length} matching request record(s) ` +
          'carrying neither userUuid (2.7.4) nor userId (2.8.0) — they cannot be attributed to a ' +
          'user without guessing',
      );
    }

    let uuidByPanelId: Map<number, string> | null = null;
    if (needsPanelLookup.length > 0) {
      const bulk = await this.remnawaveApiService.strictGetAllPanelUsers();
      if (bulk.kind !== 'ok') {
        this.logger.warn(
          `Subscription-UA detection skipped: ${needsPanelLookup.length} matching record(s) are ` +
            'identified only by the panel-internal numeric id, and the panel user list needed to ' +
            `resolve them is not trustworthy (${describeStrictOutcome(bulk)})`,
        );
        return null;
      }
      uuidByPanelId = new Map<number, string>();
      for (const user of bulk.value.users) {
        if (user.panelId !== null) uuidByPanelId.set(user.panelId, user.uuid);
      }
    }

    let unresolvedPanelIds = 0;
    for (const hit of hits) {
      let uuid: string | null = hit.userUuid;
      if (uuid === null && hit.panelUserId !== null) {
        uuid = uuidByPanelId?.get(hit.panelUserId) ?? null;
        if (uuid === null) {
          unresolvedPanelIds += 1;
          continue;
        }
      }
      if (uuid === null) continue;
      const group = byUuid.get(uuid);
      if (group === undefined) byUuid.set(uuid, [hit]);
      else group.push(hit);
    }
    if (unresolvedPanelIds > 0) {
      this.logger.warn(
        `Subscription-UA detection dropped ${unresolvedPanelIds} matching request record(s) whose ` +
          'panel numeric id is absent from the panel user list — the user was most likely deleted ' +
          'between the log write and this read',
      );
    }
    return byUuid;
  }

  /**
   * A degraded evidence window has to leave a trace, and a persistent one must
   * not drown the log. WARN on entering the degraded state and on recovery,
   * DEBUG while it merely persists — the same shape the node-flap suppression
   * uses, for the same reason.
   */
  private reportCoverage(
    fullyCovered: boolean,
    panelLogTotal: number,
    scanned: number,
    windowMinutes: number,
  ): void {
    if (fullyCovered) {
      if (this.coverageWarningActive) {
        this.coverageWarningActive = false;
        this.logger.warn(
          'Subscription-UA detection is covering its full evidence window again ' +
            `(${scanned} of ${panelLogTotal} logged requests scanned)`,
        );
      }
      return;
    }
    const message =
      `Subscription-UA detection saw only the newest ${scanned} of ${panelLogTotal} logged ` +
      `requests, and all of them fall inside the ${windowMinutes}m evidence window — ` +
      'the panel log has no time filter, so requests older than this page were NOT examined and ' +
      'this run can only under-detect. Raise the page size or shorten the window.';
    if (!this.coverageWarningActive) {
      this.coverageWarningActive = true;
      this.logger.warn(message);
    } else {
      this.logger.debug(message);
    }
  }

  /** Remnawave uuid → rezeis user id, for deep-linking the signal. */
  private async resolveRezeisUserIds(uuids: readonly string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const unique = [...new Set(uuids)].filter((u) => u.length > 0);
    if (unique.length === 0) return map;
    const rows = await this.prismaService.subscription.findMany({
      where: { remnawaveId: { in: unique } },
      select: { remnawaveId: true, userId: true },
    });
    for (const row of rows) {
      if (!row.remnawaveId) continue;
      if (!map.has(row.remnawaveId)) map.set(row.remnawaveId, row.userId);
    }
    return map;
  }
}

/** One request record whose UA was found to carry a proxy config. */
interface UaHit {
  readonly userUuid: string | null;
  readonly panelUserId: number | null;
  readonly scheme: string;
  readonly percentEncoded: boolean;
  /** ALREADY REDACTED — never the raw UA. */
  readonly evidence: string;
  readonly requestedAt: string;
  readonly ipAddress: string | null;
}

/*
 * The page size and the evidence window used to be constants here. They are now
 * operator tunables — `uaRequestPageSize` and `uaEvidenceWindowMinutes` in
 * `subscription-ua-detection.config.ts`, which is the single place their
 * defaults and bounds are declared and is read by the panel validator, the PATCH
 * DTO and the admin form alike. Re-declaring either value here would be the
 * second literal that makes one of those four layers wrong.
 */

/** Occurrences within the window at which a sighting becomes a pattern. */
const REPEAT_OCCURRENCE_THRESHOLD = 3;

/** Cap on redacted UA samples carried into signal metadata. */
const MAX_SAMPLES_IN_METADATA = 5;

/** UTC day stamp, so a signal dedupes per day like its neighbours. */
function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}
