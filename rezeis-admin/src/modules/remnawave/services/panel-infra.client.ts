import type { RemnawaveSquadOptionInterface } from '../interfaces/remnawave-squad-option.interface';
import type { PanelCommand } from './panel-command.contract';
import {
  PanelCommandExecutor,
  type PanelCommandInput,
  type PanelReadOutcome,
  type PanelTransport,
} from './panel-command.executor';
import { PANEL_COMMANDS } from './panel-commands';
import { decodeSquadOptionList, type PanelSquadListKey } from './panel-response-decoders';
import { decodePanelInstant } from './panel-response-fields';

/**
 * PanelInfraClient
 * ════════════════
 * The whole-panel half of the Remnawave adapter that production reads — the
 * version probe, the node list, per-user node bandwidth, the squad selectors and
 * the panel-wide subscription-request log — expressed as calls on
 * {@link PanelCommandExecutor} with entries of the hand-owned command table
 * (`panel-commands.ts`).
 *
 * It carries no routes, no verbs and no response schemas. Every path and verb
 * comes off the table, which `test/panel-command-conformance.spec.ts` holds to
 * every 3.x contract the fleet runs; the trailing slashes on `/api/nodes/` and
 * the squad routes are the vendor's own and are what rezeis has always sent.
 *
 * TARGET IS PANEL 3.x. There are no version branches here and no legacy
 * fallbacks: `LegacyPanelRefusal` turns a 2.x panel away before a request is
 * built, so a second era-shaped code path below it would be unreachable
 * decoration. The one exception is stated where it lives — see
 * {@link PanelInfraClient.forVersionProbe}.
 *
 * ── Responses are the panel's JSON, and every read checks what it relies on ─
 * A read returns the `response` payload, unwrapped, inside a
 * {@link PanelReadOutcome} — but only after checking that the envelope is an
 * object and that the list a caller will iterate is an array. Nothing in front
 * of this client validates a body, so those checks are the whole guarantee.
 * The types below name the fields rezeis READS; they are not a promise about
 * the rest of the bytes.
 *
 * ── Failure is a value, never an exception ──────────────────────────────────
 * Nothing in here throws and nothing collapses a failure into `null` or `[]`.
 * The methods this replaces did both, and `panel-transport.ts` names the cost
 * in its own comment: a swallowed failure makes a panel outage indistinguishable
 * from "the panel has no data". `panel-response-decoders.ts` names the caller it
 * misleads — `PlansAdminValidators.assertSquadsAreValid` blocks a write when the
 * panel could not be asked, but tells the operator `External squad not found`
 * when it reads `[]`. So the two outcomes keep different shapes all the way up,
 * and the caller decides its own fail-soft policy with the facts in hand.
 */
export class PanelInfraClient {
  public constructor(private readonly executor: PanelCommandExecutor) {}

  /**
   * A client for the version probe, and ONLY for it.
   *
   * `LegacyPanelRefusal` waits on the detected panel major before letting a
   * request out. The probe is what produces that answer, so a probe behind the
   * refusal is a circular wait — the refusal blocks until the probe answers and
   * the probe cannot be sent until the refusal unblocks. `panel-transport.ts`
   * settles this structurally rather than with an allowlist of exempt paths:
   * the probing client is built on the BARE transport, everything else on the
   * wrapper. This factory is that structure, and it is the only place in the
   * codebase allowed to hand a raw `PanelTransport` to this client.
   *
   * Use it with {@link readPanelVersion} and nothing else. Any other call made
   * through a probe-only instance silently escapes the 2.x refusal, which is
   * exactly the fourteen-call-sites-of-400s outcome the refusal exists to
   * prevent.
   */
  public static forVersionProbe(transport: PanelTransport): PanelInfraClient {
    return new PanelInfraClient(new PanelCommandExecutor(transport));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  SYSTEM
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * The panel's version string, or `null` when we could not tell.
   *
   * THE PROBE, and the one method here that must survive a panel of any era —
   * because it is what decides which era the panel is. A 2.7.4 panel answers
   * `{ version }` alone and a build that predates the endpoint answers 404;
   * neither may stop the probe, so this reads `version` off the raw shape and
   * nothing else.
   *
   * `null` means "could not tell", never "old". `panel-transport.ts` records why
   * that distinction has to survive this far: a refusal keyed on an unknown
   * version fires exactly when the panel is already struggling, and the sync
   * layer reads "cannot act" as transient, so it retries forever with nobody
   * alerted. Unknown proceeds as 3.x.
   */
  public async readPanelVersion(): Promise<string | null> {
    const outcome = await this.readEnvelope(PANEL_COMMANDS.GetMetadataCommand);
    if (outcome.kind !== 'ok') return null;
    const payload = asObject(outcome.response);
    if (payload === null) return null;
    const version = payload['version'];
    return typeof version === 'string' && version.length > 0 ? version : null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  NODES
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Every node the panel serves.
   *
   * The payload is a BARE array on 3.x — there is no `{ total, nodes }` wrapper,
   * and the old reader's tolerance for one was era cover that no longer has an
   * era to cover.
   */
  public async getNodes(): Promise<PanelReadOutcome<readonly PanelNode[]>> {
    return this.readArray<PanelNode>(PANEL_COMMANDS.GetNodesCommand);
  }

  /**
   * Per-user traffic across the given nodes, for the node-traffic-abuse
   * detector.
   *
   * A `POST` that reads nothing and changes nothing — the node list travels in
   * the body because it is a list, and the window in the query.
   *
   * THE WINDOW AND THE LIMIT ARE THE CALLER'S, not this client's, and that is a
   * deliberate move of a decision rather than an omission. `topUsersLimit` sizes
   * the panel's "top N by traffic" cut, and the detector derives its own
   * baseline FROM the rows it gets back: it takes the cohort median and the sum
   * of the list, then flags a user against both. Ask for too few and the light
   * tail is truncated, the median lands near the offender's own magnitude, and
   * a genuine offender is silently dropped — while the smaller sum inflates
   * every share percentage at the same time. A default here would put that
   * sizing somewhere the detector's author never looks. The values in use today
   * (a one-day UTC window, 25 000 rows) and the full reasoning for them live
   * with `NODE_USERS_BANDWIDTH_TOP_LIMIT` in `remnawave-detectors.ts`.
   *
   * An EMPTY `nodeUuids` never leaves the process: the table declares the array
   * as minimum one, so the executor answers `invalid-request`. The old reader
   * sent it and collected a `400`, which it then reported as `null` — "the
   * panel did not answer" — for a request the panel was right to refuse.
   */
  public async getNodeUsersBandwidth(input: {
    readonly nodeUuids: readonly string[];
    /** Inclusive window start, as the panel spells dates (`YYYY-MM-DD`). */
    readonly start: string;
    /** Inclusive window end. */
    readonly end: string;
    /** How many rows to ask for. See the note above before choosing one. */
    readonly topUsersLimit: number;
  }): Promise<PanelReadOutcome<PanelNodeUsersBandwidth>> {
    const outcome = await this.readObject<PanelNodeUsersBandwidth>(
      PANEL_COMMANDS.GetStatsNodesUsersUsageCommand,
      {
        body: { nodesUuids: [...input.nodeUuids] },
        query: { start: input.start, end: input.end, topUsersLimit: input.topUsersLimit },
      },
    );
    if (outcome.kind !== 'ok') return outcome;
    if (!Array.isArray(outcome.data.topUsers)) {
      // "No offenders" and "we could not read the answer" must not wear the
      // same clothes — the detector accuses customers on the strength of this
      // list. The reader this replaces returned `[]` for both, which is the
      // conflation its own comment argued against.
      return unreadable(
        `\`response.topUsers\` is ${describe(outcome.data.topUsers)}, not an array`,
      );
    }
    return outcome;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  SQUADS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * `{ uuid, name }` for every internal squad, for the plan squad checks.
   *
   * Decoded by {@link decodeSquadOptionList}, NEVER by executing a vendor schema
   * for its verdict. Read that module's header before changing anything here:
   * this exact read is the one that took a feature down. The option reader used
   * to `safeParse` the response with the pinned contract of the day, a field had
   * been renamed between panel eras, and the external-squad twin of this method
   * threw `ServiceUnavailableException` on EVERY panel that had at least one
   * external squad — deterministically, while an empty list passed trivially,
   * which is why operators reported it as intermittent.
   */
  public async getInternalSquadOptions(): Promise<
    PanelReadOutcome<readonly RemnawaveSquadOptionInterface[]>
  > {
    return this.readSquadOptions(PANEL_COMMANDS.GetInternalSquadsCommand, 'internalSquads');
  }

  /**
   * `{ uuid, name }` for every external squad. The read that broke. See
   * {@link getInternalSquadOptions}.
   */
  public async getExternalSquadOptions(): Promise<
    PanelReadOutcome<readonly RemnawaveSquadOptionInterface[]>
  > {
    return this.readSquadOptions(PANEL_COMMANDS.GetExternalSquadsCommand, 'externalSquads');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  SUBSCRIPTION REQUEST LOG
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * The whole-panel "who is pulling /sub/xxx" log, newest first.
   *
   * WHOLE-PANEL ONLY, and the omission is the point. This endpoint takes `start`
   * and `size` and nothing else — no user filter, no time filter. A caller that
   * once passed `userUuid` here was served an unfiltered page of the entire
   * panel's log with no way to tell.
   *
   * `total` is the panel's own count of the ENTIRE log rather than of this page,
   * so a caller that has to window by `requestAt` can at least say how small a
   * slice it looked at — and must treat a page entirely newer than its window as
   * evidence the window was NOT fully covered.
   *
   * `requestAt` IS DECODED into a `Date` when it is a well-formed date-time, on
   * every record. The UA detector keeps a string as the panel's own characters
   * but renders a `Date` through `toISOString()`, and the result is persisted in
   * signal metadata; the vendor parse used to hand it a `Date`, so this keeps the
   * stored evidence in the form it has always had. Anything else is handed on as
   * the panel sent it, for the detector's own "undated" count.
   *
   * THE QUERY IS NOT VALIDATED, as it never has been. Every contract oracle,
   * 2.7 through 3.4, caps `size` at 1000, and a page size above that is refused
   * by the panel; the caller reports that as a read it could not make. The
   * `uaRequestPageSize` tunable used to allow up to 2000 and now stops at the
   * panel's ceiling (`subscription-ua-page-size-cap.spec.ts`).
   */
  public async getSubscriptionRequestHistory(
    input: { readonly start?: number; readonly size?: number } = {},
  ): Promise<PanelReadOutcome<PanelSubscriptionRequestHistoryPage>> {
    const outcome = await this.readObject<PanelSubscriptionRequestHistoryPage>(
      PANEL_COMMANDS.GetSubscriptionRequestHistoryCommand,
      { query: { start: input.start, size: input.size } },
    );
    if (outcome.kind !== 'ok') return outcome;
    const records: unknown = outcome.data.records;
    if (!Array.isArray(records)) {
      // A 2xx whose body is not the documented envelope is a contract
      // violation, NOT an empty log. Reporting it as "no records" would let a
      // panel that changed shape read as a panel where nothing happened — and
      // the caller is a detector that treats a clean log as evidence.
      return unreadable(`\`response.records\` is ${describe(records)}, not an array`);
    }
    return {
      kind: 'ok',
      data: {
        ...outcome.data,
        records: records.map((record) => decodeRequestTime(record)),
      } as PanelSubscriptionRequestHistoryPage,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  INTERNALS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * One command, with the envelope peeled off and nothing assumed about what
   * was under it.
   *
   * The envelope check is not ceremony. A 2xx payload that is an HTML error page
   * or a proxy's own JSON has no `response` key at all. Reading `.response` off
   * it yields `undefined`, which every guard below would then have to recognise
   * separately. Refusing once, here, is what keeps "unreadable" from arriving
   * downstream disguised as "empty".
   */
  private async readEnvelope(
    command: PanelCommand,
    input?: PanelCommandInput,
  ): Promise<{ readonly kind: 'ok'; readonly response: unknown } | PanelReadFailure> {
    const outcome = await this.executor.call<unknown>(command, input);
    if (outcome.kind !== 'ok') return outcome;
    const envelope = asObject(outcome.data);
    if (envelope === null || !('response' in envelope)) {
      return unreadable(`the payload is ${describe(outcome.data)}, carrying no \`response\``);
    }
    return { kind: 'ok', response: envelope['response'] };
  }

  /** A read whose payload is an object. */
  private async readObject<T>(
    command: PanelCommand,
    input?: PanelCommandInput,
  ): Promise<PanelReadOutcome<T>> {
    const outcome = await this.readEnvelope(command, input);
    if (outcome.kind !== 'ok') return outcome;
    if (asObject(outcome.response) === null) {
      return unreadable(`\`response\` is ${describe(outcome.response)}, not an object`);
    }
    return { kind: 'ok', data: outcome.response as T };
  }

  /** A read whose payload IS the array — `GET /api/nodes/`. */
  private async readArray<T>(command: PanelCommand): Promise<PanelReadOutcome<readonly T[]>> {
    const outcome = await this.readEnvelope(command);
    if (outcome.kind !== 'ok') return outcome;
    if (!Array.isArray(outcome.response)) {
      return unreadable(`\`response\` is ${describe(outcome.response)}, not an array`);
    }
    return { kind: 'ok', data: outcome.response as readonly T[] };
  }

  /**
   * Shared tail of both squad option reads.
   *
   * The WHOLE body goes to the decoder rather than an unwrapped payload,
   * because the decoder owns the envelope rules too — including the one that
   * distinguishes an empty list the panel confirmed with `total: 0` from an
   * empty list it did not. Splitting that decision across two files is how it
   * would drift.
   */
  private async readSquadOptions(
    command: PanelCommand,
    listKey: PanelSquadListKey,
  ): Promise<PanelReadOutcome<readonly RemnawaveSquadOptionInterface[]>> {
    const outcome = await this.executor.call<unknown>(command);
    if (outcome.kind !== 'ok') return outcome;
    const decoded = decodeSquadOptionList(outcome.data, listKey);
    if (!decoded.ok) return unreadable(decoded.reason);
    return { kind: 'ok', data: decoded.value };
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  OUTCOMES
// ═════════════════════════════════════════════════════════════════════════════

/**
 * What a read answers.
 *
 * {@link PanelCommandOutcome} plus one member the executor has no reason to
 * know about: `unreadable` — the panel returned 2xx and a body this client
 * could not find the asked-for data in. That is a THIRD thing, distinct from
 * both "the panel refused" and "the panel answered, and the answer is empty",
 * and it is exactly the distinction `panel-response-decoders.ts` exists to
 * defend. It is a value rather than a throw so that no caller can acquire it by
 * accident.
 */
export type { PanelReadOutcome };

/** Every read outcome except success, so the guards above can return one. */
export type PanelReadFailure = Exclude<PanelReadOutcome<unknown>, { readonly kind: 'ok' }>;

// ═════════════════════════════════════════════════════════════════════════════
//  RETURN TYPES — the fields rezeis reads, hand-written
// ═════════════════════════════════════════════════════════════════════════════
//
// Not a copy of any release's schema. Each type names what a production reader
// actually touches, with the nullability every 3.x contract declares for it; the
// panel sends more, and nothing strips it. A field typed `unknown` is one this
// client does not decode and every reader handles in more than one shape.

/**
 * One node, as the detectors and the connection collector read it.
 *
 * `lastStatusChange` is `unknown` because nothing here decodes it: the panel
 * sends an ISO string or `null`, and both readers (`readInstantMs` in the
 * traffic detectors, `readInstant` in the sharing detectors) accept a string or
 * a `Date` and render the instant themselves.
 */
export type PanelNode = {
  readonly uuid: string;
  readonly name: string;
  readonly isConnected: boolean;
  readonly isDisabled: boolean;
  readonly isConnecting: boolean;
  readonly countryCode: string;
  readonly usersOnline: number;
  readonly trafficLimitBytes: number | null;
  readonly trafficUsedBytes: number | null;
  readonly lastStatusChange: unknown;
};

/** The per-user rows of `POST /api/bandwidth-stats/nodes/users`. */
export type PanelNodeUsersBandwidth = {
  readonly topUsers: ReadonlyArray<{ readonly username: string; readonly total: number }>;
};

/**
 * One fetch of a subscription URL.
 *
 * `requestAt` is a `Date` when the panel sent a well-formed date-time and
 * otherwise exactly what it sent — see
 * {@link PanelInfraClient.getSubscriptionRequestHistory}.
 */
export type PanelSubscriptionRequestRecord = {
  readonly userId: number;
  readonly requestIp: string | null;
  readonly userAgent: string | null;
  readonly requestAt: unknown;
};

export type PanelSubscriptionRequestHistoryPage = {
  /** The panel's count of the WHOLE log, not of this page. */
  readonly total: number;
  readonly records: readonly PanelSubscriptionRequestRecord[];
};

// ═════════════════════════════════════════════════════════════════════════════
//  HELPERS
// ═════════════════════════════════════════════════════════════════════════════

function unreadable(detail: string): { readonly kind: 'unreadable'; readonly detail: string } {
  return { kind: 'unreadable', detail };
}

/** One request-log record with `requestAt` decoded; anything not a record is handed on. */
function decodeRequestTime(record: unknown): unknown {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) return record;
  const row = record as Record<string, unknown>;
  return { ...row, requestAt: decodePanelInstant(row['requestAt']) };
}

/**
 * A plain JSON object, or `null` for anything else.
 *
 * Arrays are rejected on purpose, for the reason `panel-response-decoders.ts`
 * gives at length: `typeof [] === 'object'` and every property read off one
 * yields `undefined`, so an array reaching an envelope check would present as
 * "an object whose every field is missing" — the misreading that turns an
 * unreadable payload into a confident empty answer.
 */
function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Short, log-safe description of an unexpected value. Numbers and booleans
 * print by value because that is usually the whole diagnosis; strings and
 * objects print only their type, because their contents are panel data —
 * usernames, urls, header values — and this text reaches the operator log.
 */
function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'absent';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `an array of ${value.length}`;
  return `a ${typeof value}`;
}
