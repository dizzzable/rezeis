import { Injectable, Logger } from '@nestjs/common';
import { FraudSignalSeverity } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { panelIdentityLookup } from '../../remnawave/services/panel-user-address';
import {
  PanelInfraClient,
  type PanelReadOutcome,
  type PanelSubscriptionRequestHistoryPage,
} from '../../remnawave/services/panel-infra.client';
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
 * `GET /api/subscription-request-history` takes `start` and `size` and nothing
 * this detector can use — no user filter, no time filter. So it reads the
 * newest `uaRequestPageSize` rows once per run and windows them itself. When
 * the whole page is newer than the window, the window was not fully covered
 * and the run says so rather than implying it saw everything. Under-detection
 * is the acceptable direction here; a silent claim of full coverage is not.
 *
 * COST. ONE HTTP call, always — which is a change, and a simplification the
 * 3.x-only target hands over for free. A record identifies its owner by the
 * panel's numeric `userId`, and on 3.x that decimal IS the identity
 * `Subscription.remnawaveId` holds, so there is nothing left to translate.
 * The whole-panel user walk this used to run whenever a 2.8.0 record turned up
 * — 50 pages, and a run ABANDONED outright when the list came back
 * untrustworthy — is gone with the panel version that needed it.
 *
 * A row created back in the 2.x era still stores a uuid in `remnawaveId`, and
 * that is handled where it belongs: `panelIdentityLookup` matches the numeric
 * angle through `Subscription.remnawavePanelId` as well as the string one, so
 * the deep link survives the upgrade without a panel round-trip.
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
    private readonly infraClient: PanelInfraClient,
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
      const requestedSize = config.uaRequestPageSize;
      const page = await this.infraClient.getSubscriptionRequestHistory({
        start: 0,
        size: requestedSize,
      });
      if (page.kind !== 'ok') {
        // Loud, and specific about which failure it was: `unreadable` here
        // means the panel answered `2xx` with a body carrying no `records`
        // array — the log's shape changed and this detector is blind until
        // someone looks, which is a different operator action from "the panel
        // was briefly down". Reporting that as an empty log would let a panel
        // that changed shape read as a panel where nothing happened.
        this.logger.warn(
          'Subscription-UA detection skipped: the subscription request log is not readable ' +
            `(${describeReadFailure(page)})`,
        );
        return [];
      }

      const windowMinutes = config.uaEvidenceWindowMinutes;
      const nowMs = now.getTime();
      const windowStartMs = nowMs - windowMinutes * 60_000;
      const records = page.data.records;

      let undatedRecords = 0;
      let unattributableRecords = 0;
      let oldestInPageMs: number | null = null;
      const windowed: Array<{ readonly record: PanelRequestRecord; readonly atIso: string }> = [];
      for (const record of records) {
        // `requestAt` arrives as a `Date` on the validated path and as the wire
        // string on the executor's drift path. Both are read; anything else is
        // a fetch we cannot place in time, and a fetch we cannot place in time
        // cannot be placed in the window either. Keeping it would let an
        // arbitrarily old record be judged as if it had just happened.
        const at = readInstant(record.requestAt);
        if (at === null) {
          undatedRecords += 1;
          continue;
        }
        oldestInPageMs = oldestInPageMs === null ? at.ms : Math.min(oldestInPageMs, at.ms);
        if (at.ms < windowStartMs) continue;
        windowed.push({ record, atIso: at.iso });
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
      // window extends past what we were served. `requestedSize` is what THIS
      // call asked for — the panel does not echo it back, and reading a size
      // off the response would compare the page against itself.
      const windowFullyCovered =
        records.length < requestedSize ||
        (oldestInPageMs !== null && oldestInPageMs < windowStartMs);
      this.reportCoverage(windowFullyCovered, page.data.total, records.length, windowMinutes);

      const hits: UaHit[] = [];
      for (const { record, atIso } of windowed) {
        const finding = findProxyConfigUri(record.userAgent);
        if (finding === null) continue;
        // The identity, straight off the record. A 3.x request-log row carries
        // the panel's numeric `userId` and nothing else, and its decimal
        // rendering is exactly what `Subscription.remnawaveId` holds for a
        // profile created on 3.x — so this is a format, not a lookup. It is
        // also the fingerprint key, which is why an unreadable one is dropped
        // rather than approximated: a wrong mapping does not mislabel a row, it
        // files one customer's evidence against another.
        const identity = readPanelUserIdentity(record.userId);
        if (identity === null) {
          unattributableRecords += 1;
          continue;
        }
        hits.push({
          identity,
          scheme: finding.scheme,
          percentEncoded: finding.percentEncoded,
          // Redacted at the point of capture, never after: a `vless://` UA
          // carries the client uuid and a `trojan://` UA carries the password.
          evidence: redactUserAgentForEvidence(record.userAgent ?? ''),
          requestedAt: atIso,
          ipAddress: record.requestIp,
        });
      }
      if (unattributableRecords > 0) {
        this.logger.warn(
          `Subscription-UA detection dropped ${unattributableRecords} matching request record(s) ` +
            'whose userId is not an integer panel id — they cannot be attributed to a user ' +
            'without guessing',
        );
      }
      if (hits.length === 0) return [];

      const attributed = new Map<string, UaHit[]>();
      for (const hit of hits) {
        const group = attributed.get(hit.identity);
        if (group === undefined) attributed.set(hit.identity, [hit]);
        else group.push(hit);
      }

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
            panelLogTotal: page.data.total,
            // `detectedVersion` is gone. It came off the legacy strict-outcome
            // envelope, and it recorded which of 2.7.4 / 2.8.0 / 3.x answered —
            // a question with one possible answer now, and a field an operator
            // would read as still meaning something.
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

  /**
   * Panel identity → rezeis user id, for deep-linking the signal.
   *
   * MATCHED ON BOTH ANGLES, via {@link panelIdentityLookup}, for the reason
   * spelled out there: the identity a 3.x panel hands us is a decimal, while a
   * subscription linked during the 2.x era still stores its uuid in
   * `remnawaveId` and always will. Asking `remnawaveId IN (…)` alone drops the
   * deep link for that whole population — `affectedUserIds` comes back empty
   * and the operator gets a signal they cannot open.
   */
  private async resolveRezeisUserIds(identities: readonly string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const lookup = panelIdentityLookup(identities);
    if (lookup === null) return map;
    const rows = await this.prismaService.subscription.findMany({
      where: lookup.where,
      select: { remnawaveId: true, remnawavePanelId: true, userId: true },
    });
    for (const row of rows) {
      // Keyed by the identity the caller asked about — see `keysFor`.
      for (const key of lookup.keysFor(row)) {
        if (!map.has(key)) map.set(key, row.userId);
      }
    }
    return map;
  }
}

/** One row of the panel's subscription-request log, as the contract declares it. */
type PanelRequestRecord = PanelSubscriptionRequestHistoryPage['records'][number];

/** One request record whose UA was found to carry a proxy config. */
interface UaHit {
  /**
   * The panel's numeric user id in decimal — the same string
   * `Subscription.remnawaveId` holds for a profile created on 3.x, and the key
   * both the fingerprint and the deep-link lookup use.
   *
   * The pair of nullable owner fields this replaces (`userUuid` for 2.7.4,
   * `panelUserId` for 2.8.0) is gone with the versions that spelled it that
   * way: a 3.x row carries one owner field and it is never absent.
   */
  readonly identity: string;
  readonly scheme: string;
  readonly percentEncoded: boolean;
  /** ALREADY REDACTED — never the raw UA. */
  readonly evidence: string;
  /** ISO-8601, normalised — see {@link readInstant}. */
  readonly requestedAt: string;
  readonly ipAddress: string | null;
}

/**
 * A panel timestamp as milliseconds plus the ISO string a signal carries.
 *
 * BOTH SHAPES ARE READ. The contract transforms `requestAt` into a `Date`, so
 * that is what a validated response yields; on the executor's DRIFT path the
 * panel's raw bytes come back and the field is the wire string. A reader that
 * handled only one of them would drop every record on a drifted response — and
 * "dropped" here means the fetch is judged as undated and never examined.
 *
 * `null` for anything that is not a placeable instant.
 */
function readInstant(value: unknown): { readonly ms: number; readonly iso: string } | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? { ms, iso: value.toISOString() } : null;
  }
  if (typeof value === 'string' && value.length > 0) {
    const ms = Date.parse(value);
    // The panel's own characters, kept: an operator comparing a signal against
    // the panel's request log should see the same string.
    return Number.isFinite(ms) ? { ms, iso: value } : null;
  }
  return null;
}

/**
 * A request record's owner, as the identity string rezeis stores.
 *
 * The contract declares `userId` as a number, so the string arm is only
 * reachable on the drift path — but it is reachable, and refusing a `'4471'`
 * there would drop a genuine sighting. The WHOLE string has to be digits:
 * `Number.parseInt` reads a LEADING run and stops, so a uuid-shaped value would
 * become panel user #3 and file one customer's evidence against another's name.
 */
function readPanelUserIdentity(value: unknown): string | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? String(value) : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) ? String(parsed) : null;
}

/**
 * How a failed panel read is rendered into an operator-facing log line.
 *
 * `unreadable` is named separately from `rejected` on purpose: they are
 * different operator actions. `rejected` is the panel saying no. `unreadable`
 * is the panel saying yes and answering a body with no `records` array — a
 * shape change somebody has to look at, and the case this detector must never
 * report as an empty log.
 */
function describeReadFailure(outcome: PanelReadOutcome<unknown>): string {
  switch (outcome.kind) {
    case 'ok':
      // Unreachable by construction — the caller checks `kind` first — but a
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
