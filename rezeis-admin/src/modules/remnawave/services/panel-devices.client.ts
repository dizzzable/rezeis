import { Logger } from '@nestjs/common';
import {
  ConnectionsByNodeCommand,
  ConnectionsByNodeResultCommand,
  ConnectionsByUserCommand,
  ConnectionsByUserResultCommand,
  DeleteAllUserHwidDevicesCommand,
  DeleteUserHwidDeviceCommand,
  DropConnectionsCommand,
  GetHwidDevicesCommand,
  GetHwidDevicesStatsCommand,
  GetTopUsersByHwidDevicesCommand,
  GetUserHwidDevicesCommand,
} from '@remnawave/contract-v34';
import type { z, ZodType } from 'zod';

import { resolveCommandUrl, type PanelCommand } from './panel-command.contract';
import type {
  PanelCommandExecutor,
  PanelCommandOutcome,
  PanelReadOutcome,
} from './panel-command.executor';

/**
 * PanelDevicesClient
 * ══════════════════
 * The HWID-device and live-connection half of the panel integration, expressed
 * as calls onto {@link PanelCommandExecutor} with the vendor's own command
 * objects. Every route, verb and schema below arrives from
 * `@remnawave/contract-v34` (= `@remnawave/backend-contract@3.4.2`, the
 * contract minor that belongs to panel 3.3.x); nothing here is a hand-copied
 * literal that can drift from the panel without a word.
 *
 * ── THIS CLIENT IS 3.x ONLY, and that removes three things ─────────────────
 *
 * 1. `/api/ip-control/*` is gone. It was the 2.x spelling of this family and
 *    panel 3.3.2 does not serve it at all, so the era branch that chose
 *    between `ip-control` and `connections` has nothing left to choose. There
 *    is deliberately NO version check here either: `LegacyPanelRefusal` in
 *    `panel-transport.ts` is the one place a 2.x panel is turned away, and
 *    duplicating that decision per call site is how the old code ended up with
 *    nine sites that each guessed differently about an unknown version.
 *
 * 2. Device ownership in a request body is `userId`, a NUMBER. The old code
 *    sent `userUuid` whenever the addressing era was not positively known to
 *    be 3.x — and 3.3.2 declares no such field, so those requests were
 *    guaranteed `400`s that the sync layer files as terminal. The contract's
 *    `RequestBodySchema` now refuses that body before it can be sent.
 *
 * 3. `GET /api/hwid/stats` does not exist. The old `getHwidStats()` tried
 *    `/api/hwid/devices/stats` and then fell through to `/api/hwid/stats` in a
 *    bare `catch { continue }`, which meant a real failure on the first path —
 *    an expired token, a panel restart — was answered by a second request that
 *    could only 404, and the pair returned `null` as if the panel had simply
 *    not been asked. One command, one call, and the failure keeps its reason.
 *
 * ── The type on the tin, and where it is a promise we cannot keep ──────────
 * Return shapes are `z.infer` of the contract's own `ResponseSchema`. That is
 * exact on the validated path. On the DRIFT path it is not: the executor hands
 * back the panel's raw bytes when a response fails the pinned schema (see the
 * asymmetry note there — rejecting a merely-surprising response has already
 * taken this integration down once). So a drifted `lastSeen` is the wire
 * string, not the `Date` the transform produces, and a field the panel dropped
 * is `undefined` behind a type that says otherwise. Every read below that a
 * caller could mistake for an ANSWER is therefore re-checked at runtime on
 * that path, and reports {@link PanelDevicesOutcome} `unreadable` rather than
 * an empty one.
 */
export class PanelDevicesClient {
  private readonly logger = new Logger(PanelDevicesClient.name);

  public constructor(private readonly executor: PanelCommandExecutor) {}

  // ── HWID devices ──────────────────────────────────────────────────────────

  /**
   * The devices bound to one panel profile.
   *
   * `GET /api/hwid/devices/{userId}` — the path part is the numeric 3.x id and
   * the contract says so (`RequestParamSchema` is `{ userId: number }`), which
   * is why it is checked here before the path is built. A non-integer would
   * otherwise reach the panel as `/api/hwid/devices/NaN` and come back as a
   * validation `400` that reads like a rejected user rather than our own bad
   * call.
   */
  public async listUserDevices(userId: number): Promise<PanelDevicesOutcome<PanelHwidDeviceList>> {
    const refusal = refuseInvalidParam(GetUserHwidDevicesCommand, { userId }, userId);
    if (refusal !== null) return refusal;

    const outcome = await this.executor.call<PanelHwidDeviceListEnvelope>(
      GetUserHwidDevicesCommand,
      { pathParts: [String(userId)] },
    );
    return unwrapDeviceList(outcome);
  }

  /**
   * Every HWID device the panel holds, walked page by page.
   *
   * `GET /api/hwid/devices` — the SAME rows {@link listUserDevices} serves,
   * unfiltered by owner, each carrying the `userId` it is bound to. That is
   * the whole reason this method exists: the per-user route answers "which
   * devices does THIS profile hold", and no amount of asking it can answer
   * "is this device also on somebody else's profile" without one call per
   * subscriber. One paged walk replaces that N+1 entirely.
   *
   * NO `filters`, DELIBERATELY. The contract's own endpoint description warns
   * that the filter parameters "rely on expensive operators such as LIKE under
   * the hood" and that misusing them "may negatively impact the performance of
   * your database" — the panel's database, which is the operator's production
   * one. Paging is cheap; filtering is not, and there is nothing to filter for
   * anyway: a cross-account duplicate is only visible against the whole set.
   *
   * NO `sorting` either, and the cost of that is stated rather than hidden.
   * Offset paging over a list whose order the panel is free to choose is not a
   * stable cursor: a device registered mid-walk can shift a row across a page
   * boundary, so a row can be seen twice or missed. Seeing one twice costs
   * nothing (the caller groups into a set); missing one can shrink a
   * two-account group to one and hide a finding for a run. That is the SAFE
   * direction — it under-reports, never invents — and sending a sort column
   * whose name is a guess would trade it for a `400` on every run.
   *
   * A page that fails is returned AS THE FAILURE. `[]` from here would mean
   * "no device is bound to two accounts", which is exactly what a healthy
   * panel looks like.
   */
  public async listAllDevices(
    limit: number = PANEL_ALL_DEVICES_CEILING,
  ): Promise<PanelDevicesOutcome<PanelHwidDeviceInventory>> {
    const ceiling = Math.max(1, Math.min(Math.trunc(limit), PANEL_ALL_DEVICES_CEILING));
    const devices: PanelHwidDevice[] = [];
    let total = 0;
    // Whether the panel ever told us how many rows it holds. Without this the
    // walk could not tell "the panel says zero" from "we never read a count":
    // `total` starts at 0, so on the drift path — where a renamed or absent
    // field leaves it there — the very first full page satisfied
    // `devices.length >= total` and the walk returned `complete: true` after
    // one page of a fifteen-thousand-row fleet, at full confidence.
    let totalKnown = false;

    while (devices.length < ceiling) {
      const query = {
        start: devices.length,
        size: Math.min(PANEL_ALL_DEVICES_PAGE_SIZE, ceiling - devices.length),
      };
      // Same rule as the top-users walk: the query is OURS, so it is checked
      // against the contract's own schema before a round-trip is spent
      // learning that a later contract narrowed the page ceiling.
      const refusal = refuseInvalid(GetHwidDevicesCommand, 'query', query, []);
      if (refusal !== null) return refusal;

      const outcome = await this.executor.call<PanelHwidDeviceInventoryEnvelope>(
        GetHwidDevicesCommand,
        { query },
      );
      const page = unwrapEnvelope(outcome, 'devices');
      if (page.kind !== 'ok') return page;

      if (typeof page.data.total === 'number') {
        total = page.data.total;
        totalKnown = true;
      }
      devices.push(...page.data.devices);

      // A short page ends the list on any build that honours `size`, and also
      // stops an endless walk against one that ignores it and re-serves the
      // first page forever.
      if (page.data.devices.length === 0 || page.data.devices.length < query.size) {
        return { kind: 'ok', data: { devices, total, complete: true }, drifted: page.drifted };
      }
      // Only an answer we actually read can end the walk this way.
      if (totalKnown && devices.length >= total) {
        return { kind: 'ok', data: { devices, total, complete: true }, drifted: page.drifted };
      }
    }

    const complete = totalKnown && devices.length >= total;
    if (!complete) {
      this.logger.warn(
        `Remnawave HWID inventory: stopped at the ${devices.length}-row ceiling with ${total} ` +
          'reported — cross-account device detection is INCOMPLETE for this run, not clean',
      );
    }
    return { kind: 'ok', data: { devices, total, complete }, drifted: false };
  }

  /**
   * Unbinds one device.
   *
   * `POST /api/hwid/devices/delete` with `{ userId, hwid }` — a POST and not a
   * DELETE, which is the panel's own choice and the contract's. The body key
   * is where the old implementation was wrong: it sent `{ userUuid, hwid }`
   * unless the era probe had positively identified a 3.x panel, and 3.3.2
   * declares no `userUuid`. Nothing needs to remember that any more — the
   * contract's schema is what builds the expectation, and the executor refuses
   * a body that misses it without spending a round-trip.
   */
  public async deleteUserDevice(
    userId: number,
    hwid: string,
  ): Promise<PanelDevicesOutcome<PanelHwidDeviceList>> {
    const outcome = await this.executor.call<PanelHwidDeviceListEnvelope>(
      DeleteUserHwidDeviceCommand,
      { body: { userId, hwid } },
    );
    return unwrapDeviceList(outcome);
  }

  /**
   * Unbinds every device on a profile. Used when a subscription is regenerated
   * so a client holding a dead link cannot keep occupying a slot.
   */
  public async deleteAllUserDevices(
    userId: number,
  ): Promise<PanelDevicesOutcome<PanelHwidDeviceList>> {
    const outcome = await this.executor.call<PanelHwidDeviceListEnvelope>(
      DeleteAllUserHwidDevicesCommand,
      { body: { userId } },
    );
    return unwrapDeviceList(outcome);
  }

  /**
   * Fleet-wide device statistics for the admin dashboard.
   *
   * One path, no fallback — see point 3 of the class note.
   */
  public async getDeviceStats(): Promise<PanelDevicesOutcome<PanelHwidDeviceStats>> {
    const outcome = await this.executor.call<PanelHwidDeviceStatsEnvelope>(
      GetHwidDevicesStatsCommand,
    );
    return unwrapEnvelope(outcome, null);
  }

  /**
   * Users ordered by device count, walked page by page.
   *
   * THE PAGE SIZE IS SENT, AND THAT IS THE WHOLE POINT OF THE WALK. The
   * contract declares `size` as `z.coerce.number().min(1).max(100).default(5)`,
   * so omitting it never meant "everything" — it meant FIVE ROWS. The consumer
   * that matters is the device-overage detector, which joins this list against
   * each subscriber's limit; on any panel with more than five device-registering
   * users it was judging a five-row sample and calling everyone else clean.
   * Nothing said so, because five rows is a perfectly ordinary answer.
   *
   * `limit` is what the CALLER wants — a dashboard card wants a card's worth,
   * the detector wants coverage — clamped to {@link PANEL_TOP_DEVICE_USERS_CEILING}
   * so neither can walk a huge panel forever. A walk stopped by that ceiling
   * with rows still unread reports `complete: false`, because a silently
   * truncated list reads exactly like a clean panel.
   *
   * Offset paging over a list ordered by device count is not a stable cursor —
   * a device registered mid-walk can shift a row across a page boundary — but
   * the cost is one offender missed until the next run and the endpoint offers
   * nothing better.
   *
   * A page that fails is returned AS THE FAILURE, not as the rows gathered so
   * far. The old version swallowed the error into `[]`, which in the detector
   * means "nobody is over their limit" — the same value a healthy panel
   * produces.
   */
  public async listTopUsersByDeviceCount(
    limit: number = PANEL_TOP_DEVICE_USERS_CEILING,
  ): Promise<PanelDevicesOutcome<PanelHwidTopUsersPage>> {
    const ceiling = Math.max(1, Math.min(Math.trunc(limit), PANEL_TOP_DEVICE_USERS_CEILING));
    const users: PanelHwidTopUser[] = [];
    let total = 0;

    while (users.length < ceiling) {
      const query = {
        start: users.length,
        size: Math.min(PANEL_TOP_DEVICE_USERS_PAGE_SIZE, ceiling - users.length),
      };
      // The executor validates bodies but not query strings, and this is the
      // one call here that has a query at all. Checking it against the
      // contract's own `RequestQuerySchema` keeps the same rule: a page size a
      // later contract no longer allows becomes a refusal that names the field,
      // not a `400` from the panel.
      const refusal = refuseInvalid(GetTopUsersByHwidDevicesCommand, 'query', query, []);
      if (refusal !== null) return refusal;

      const outcome = await this.executor.call<PanelHwidTopUsersEnvelope>(
        GetTopUsersByHwidDevicesCommand,
        { query },
      );
      const page = unwrapEnvelope(outcome, 'users');
      if (page.kind !== 'ok') return page;

      total = typeof page.data.total === 'number' ? page.data.total : total;
      users.push(...page.data.users);

      // A short page is the end of the list on any build that honours `size`,
      // and it is also the stop that saves us from an endless walk against one
      // that ignores it and re-serves the first page forever.
      if (page.data.users.length === 0 || page.data.users.length < query.size) {
        return { kind: 'ok', data: { users, total, complete: true }, drifted: page.drifted };
      }
      if (users.length >= total) {
        return { kind: 'ok', data: { users, total, complete: true }, drifted: page.drifted };
      }
    }

    const complete = users.length >= total;
    if (!complete) {
      this.logger.warn(
        `Remnawave HWID top users: stopped at the ${users.length}-row ceiling with ${total} ` +
          'reported — device-overage detection is INCOMPLETE for this run, not clean',
      );
    }
    return { kind: 'ok', data: { users, total, complete }, drifted: false };
  }

  // ── Live connections ──────────────────────────────────────────────────────

  /**
   * Asks the panel to collect the nodes and source IPs one user is connected
   * from. Asynchronous on the panel side: this returns a `jobId` to poll.
   *
   * NOTE THE ADDRESS TRAP. `ConnectionsByUserCommand.url` and
   * `ConnectionsByUserResultCommand.url` both build
   * `/api/connections/by-user/{…}` — the POST takes a USER ID and the GET takes
   * a JOB ID. Feeding one to the other produces a perfectly well-formed URL and
   * a nonsense request, so each side is checked against its own
   * `RequestParamSchema` (`{ userId: number }` vs `{ jobId: string }`) before
   * the path is built.
   */
  public async startUserConnectionsJob(
    userId: number,
  ): Promise<PanelDevicesOutcome<PanelConnectionsJob>> {
    const refusal = refuseInvalidParam(ConnectionsByUserCommand, { userId }, userId);
    if (refusal !== null) return refusal;

    const outcome = await this.executor.call<PanelConnectionsJobEnvelope>(
      ConnectionsByUserCommand,
      // The contract declares no body for this POST. An empty JSON object is
      // sent anyway because that is what has actually run against live panels;
      // it satisfies a handler that expects a parsed body and is inert to one
      // that does not.
      { pathParts: [String(userId)], body: {} },
    );
    return unwrapEnvelope(outcome, null);
  }

  /** Polls a by-user job. See {@link pollJob} for what `null` versus `[]` means. */
  public async pollUserConnectionsJob(
    jobId: string,
    options: PanelJobPollOptions = {},
  ): Promise<readonly PanelUserConnectionNode[] | null> {
    return this.pollJob<PanelUserConnectionNode>(
      ConnectionsByUserResultCommand,
      'connections by user',
      jobId,
      'nodes',
      options,
    );
  }

  /**
   * Start-then-poll for one user: which nodes they are on and from which IPs.
   *
   * `null` means WE COULD NOT FIND OUT. `[]` means the panel answered and the
   * user has no live connections.
   */
  public async fetchUserConnections(
    userId: number,
    options: PanelJobPollOptions = {},
  ): Promise<readonly PanelUserConnectionNode[] | null> {
    const started = await this.startUserConnectionsJob(userId);
    if (started.kind !== 'ok') {
      this.logger.warn(
        `Remnawave connections by user ${userId}: the job did not start (${started.kind}) — ` +
          'this user\'s live connections are UNKNOWN for this run, not empty',
      );
      return null;
    }
    return this.pollUserConnectionsJob(started.data.jobId, options);
  }

  /**
   * Asks the panel to collect everyone currently online on one node. Returns a
   * `jobId` to poll.
   */
  public async startNodeConnectionsJob(
    nodeUuid: string,
  ): Promise<PanelDevicesOutcome<PanelConnectionsJob>> {
    const refusal = refuseInvalidParam(ConnectionsByNodeCommand, { nodeUuid }, nodeUuid);
    if (refusal !== null) return refusal;

    const outcome = await this.executor.call<PanelConnectionsJobEnvelope>(
      ConnectionsByNodeCommand,
      { pathParts: [nodeUuid], body: {} },
    );
    return unwrapEnvelope(outcome, null);
  }

  /** Polls a by-node job. See {@link pollJob} for what `null` versus `[]` means. */
  public async pollNodeConnectionsJob(
    jobId: string,
    options: PanelJobPollOptions = {},
  ): Promise<readonly PanelNodeConnectionUser[] | null> {
    return this.pollJob<PanelNodeConnectionUser>(
      ConnectionsByNodeResultCommand,
      'connections by node',
      jobId,
      'users',
      options,
    );
  }

  /**
   * Start-then-poll for one node: who is online on it, and from which IPs —
   * the data behind the panel's "Active sessions" view and the input to the
   * concurrent-IP sharing detector.
   *
   * `null` means THIS NODE COULD NOT BE READ. `[]` means it was read and nobody
   * was online. The caller must keep those apart: they are the difference
   * between "no sharing here" and "no idea", and the one consumer's whole
   * purpose is to accuse people.
   */
  public async fetchNodeConnections(
    nodeUuid: string,
    options: PanelJobPollOptions = {},
  ): Promise<readonly PanelNodeConnectionUser[] | null> {
    const started = await this.startNodeConnectionsJob(nodeUuid);
    if (started.kind !== 'ok') {
      this.logger.warn(
        `Remnawave connections by node ${nodeUuid}: the job did not start (${started.kind}) — ` +
          'this node is UNKNOWN for this run, not clean',
      );
      return null;
    }
    return this.pollNodeConnectionsJob(started.data.jobId, options);
  }

  /**
   * Drops live connections for the given users or IPs across the targeted
   * nodes — the enforcement end of the anti-fraud path.
   *
   * The body is the contract's `{ dropBy, targetNodes }` discriminated pair,
   * and 3.x spells the user arm `userIds: number[]`. The 2.x spelling was
   * `userUuids: string[]`, and the migration away from it is exactly where a
   * mistake is most expensive: the old code parsed stored identities into ids,
   * and a `Number.parseInt` there would read a leading run of digits out of a
   * 2.x uuid (`330f2b38-…` → `330`) — a valid-looking id belonging to somebody
   * else, whose connections this call then drops. Taking `number[]` from the
   * caller removes the parse from this layer entirely, and the contract's
   * schema refuses anything that still arrives in the old shape.
   *
   * An EMPTY selector is refused here rather than sent. The contract permits an
   * empty array, so `{ by: 'userIds', userIds: [] }` with `targetNodes:
   * allNodes` is a well-formed request that asks a fleet-wide endpoint to act
   * on nobody — a no-op at best, and not a request worth betting a panel's
   * interpretation on.
   *
   * The panel answers `202 Accepted` with no body: nothing confirms the drop
   * actually happened, so the `ok` outcome means "accepted", not "done".
   */
  public async dropConnections(
    body: PanelDropConnectionsBody,
  ): Promise<PanelDevicesOutcome<unknown>> {
    if (hasEmptySelector(body)) {
      return {
        kind: 'invalid-request',
        detail: 'dropBy: selector is empty, so this request would target nobody',
        command: describeCommand(DropConnectionsCommand, []),
      };
    }
    return this.executor.call<unknown>(DropConnectionsCommand, { body });
  }

  /**
   * Polls a connections job until it completes, fails, or the attempt budget
   * runs out.
   *
   * ── `null` AND `[]` ARE DIFFERENT ANSWERS AND MUST STAY THAT WAY ──────────
   * This is the load-bearing behaviour of the whole file. `[]` means the panel
   * read the target and found nobody. `null` means we could not find out. The
   * concurrent-IP sharing detector accuses subscribers on the strength of this
   * value, and it reads `[]` as "clean" — so flattening `null` into `[]` turns
   * a node whose collection job failed, or simply answered slower than the
   * budget, into a node reported as clean. The big nodes are both the slowest
   * and the ones sharers live on, so the flattening does its damage exactly
   * where the detector matters most.
   *
   * Five distinct ways to not know, all of them `null`:
   *   • the poll request itself failed (rejected, network, unconfigured);
   *   • the envelope was not readable — only reachable on the drift path,
   *     where the executor hands back raw bytes;
   *   • the panel reported `isFailed`;
   *   • the job completed but its `result` is absent, or carries
   *     `success: false` — a collection that ran and did not work;
   *   • the attempt budget ran out with the job still running.
   *
   * The fourth is where the old implementation leaked. It checked
   * `result.success === false` but let `result: null` fall through into an
   * extractor that answered `[]` for a missing list — so a completed-but-empty
   * result was reported as an empty node.
   */
  private async pollJob<TRow>(
    command: PanelCommand,
    label: string,
    jobId: string,
    rowsKey: 'users' | 'nodes',
    options: PanelJobPollOptions,
  ): Promise<readonly TRow[] | null> {
    const attempts = Math.max(1, Math.trunc(options.attempts ?? PANEL_JOB_POLL_ATTEMPTS));
    const intervalMs = Math.max(0, Math.trunc(options.intervalMs ?? PANEL_JOB_POLL_INTERVAL_MS));

    if (refuseInvalidParam(command, { jobId }, jobId) !== null) {
      this.unknown(label, jobId, 'the job id is not one this command accepts');
      return null;
    }

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      // `unknown`, deliberately, and not the inferred response type. On the
      // drift path `data` is the panel's raw body, so a typed read here would
      // be a promise the executor does not keep — and this is the one place in
      // the file where believing it produces a confident wrong accusation.
      const outcome = await this.executor.call<unknown>(command, { pathParts: [jobId] });
      if (outcome.kind !== 'ok') {
        this.unknown(label, jobId, `the poll failed (${outcome.kind})`);
        return null;
      }

      const job = readJobEnvelope(outcome.data);
      if (job === null) {
        this.unknown(label, jobId, 'the panel answered a body with no readable job state');
        return null;
      }
      if (job.failed) {
        this.unknown(label, jobId, 'the panel reported the job as failed');
        return null;
      }
      if (job.completed) {
        const rows = readJobRows<TRow>(job.result, rowsKey);
        if (rows === null) {
          this.unknown(label, jobId, 'the job completed without a usable result');
        }
        return rows;
      }

      // No sleep after the last look — there is nothing left to wait for.
      if (attempt + 1 < attempts) await delay(intervalMs);
    }

    this.unknown(label, jobId, `the job was still running after ${attempts} attempts`);
    return null;
  }

  /**
   * Says out loud that a `null` is about to be returned, and why.
   *
   * Fail-soft stays, but not silently: `null` and `[]` are opposite facts to
   * the caller and identical to a log reader, and the reason a node went
   * unread is the only thing that distinguishes a slow panel from a broken one.
   */
  private unknown(label: string, jobId: string, reason: string): void {
    this.logger.warn(
      `Remnawave ${label} job ${jobId}: ${reason} — reporting UNKNOWN (null), not empty`,
    );
  }
}

// ── Outcome ─────────────────────────────────────────────────────────────────

/**
 * What one device or connection call can answer.
 *
 * A superset of {@link PanelCommandOutcome} with one extra arm. `unreadable`
 * is not a transport failure and not a rejection: the panel answered, the
 * answer did not validate, and what came back in its place could not be read
 * as the payload either. It exists because the alternative is to hand a caller
 * an empty list, and "we could not read it" rendering as "you have no devices"
 * is this repository's most repeated defect — the same one
 * `panel-response-decoders.ts` was written to stop and the same one the
 * `null`/`[]` rule above protects on the connections side.
 */
export type PanelDevicesOutcome<T> = PanelReadOutcome<T>;

// ── Types, all derived from the contract's own schemas ──────────────────────

type PanelHwidDeviceListEnvelope = z.infer<typeof GetUserHwidDevicesCommand.ResponseSchema>;

/**
 * `{ total, devices }`.
 *
 * Derived from the LIST command, and shared with both delete commands, which
 * declare the identical payload in 3.4.2 — `test/panel-devices-client.spec.ts`
 * pins that against the real schemas so a later contract that splits them
 * cannot leave the deletes silently mistyped.
 */
export type PanelHwidDeviceList = PanelHwidDeviceListEnvelope['response'];
export type PanelHwidDevice = PanelHwidDeviceList['devices'][number];

type PanelHwidDeviceInventoryEnvelope = z.infer<typeof GetHwidDevicesCommand.ResponseSchema>;

/**
 * One walk of the whole device inventory. `complete` is ours; the rest is the
 * panel's.
 *
 * The row type is deliberately the SAME `PanelHwidDevice` the per-user list
 * serves. 3.4.2 declares both off `HwidUserDeviceSchema`, so a contract that
 * ever splits them fails the compile here rather than letting a caller read a
 * field one of the two routes stopped sending.
 */
export interface PanelHwidDeviceInventory {
  readonly devices: readonly PanelHwidDevice[];
  /** The panel's own count of bound devices, not `devices.length`. */
  readonly total: number;
  /** `false` when the ceiling stopped the walk with rows the panel still had. */
  readonly complete: boolean;
}

type PanelHwidDeviceStatsEnvelope = z.infer<typeof GetHwidDevicesStatsCommand.ResponseSchema>;
export type PanelHwidDeviceStats = PanelHwidDeviceStatsEnvelope['response'];

type PanelHwidTopUsersEnvelope = z.infer<typeof GetTopUsersByHwidDevicesCommand.ResponseSchema>;
export type PanelHwidTopUser = PanelHwidTopUsersEnvelope['response']['users'][number];

/** One walk of the top-users list. `complete` is ours; the rest is the panel's. */
export interface PanelHwidTopUsersPage {
  readonly users: readonly PanelHwidTopUser[];
  /** The panel's own count of device-registering users, not `users.length`. */
  readonly total: number;
  /** `false` when the ceiling stopped the walk with rows the panel still had. */
  readonly complete: boolean;
}

type PanelConnectionsJobEnvelope = z.infer<typeof ConnectionsByUserCommand.ResponseSchema>;
export type PanelConnectionsJob = PanelConnectionsJobEnvelope['response'];

type PanelUserConnectionsResult = NonNullable<
  z.infer<typeof ConnectionsByUserResultCommand.ResponseSchema>['response']['result']
>;
/** One node a user is connected to, with the IPs seen there. */
export type PanelUserConnectionNode = PanelUserConnectionsResult['nodes'][number];

type PanelNodeConnectionsResult = NonNullable<
  z.infer<typeof ConnectionsByNodeResultCommand.ResponseSchema>['response']['result']
>;
/** One user online on a node, with the IPs seen there. */
export type PanelNodeConnectionUser = PanelNodeConnectionsResult['users'][number];

export type PanelDropConnectionsBody = z.infer<typeof DropConnectionsCommand.RequestBodySchema>;

export interface PanelJobPollOptions {
  readonly attempts?: number;
  readonly intervalMs?: number;
}

// ── Tunables ────────────────────────────────────────────────────────────────

/**
 * The contract's own ceiling: `size … .max(100, 'Size (limit) must be less
 * than 100')`. Not a preference — asking for more is a `400`.
 */
export const PANEL_TOP_DEVICE_USERS_PAGE_SIZE = 100;

/**
 * How far the top-users walk goes before it stops and says it stopped.
 *
 * Ten pages. The list is ordered by device count, so the tail is users with one
 * or two devices — nobody a device-limit detector can act on — and a panel with
 * more than a thousand device-registering users has a problem that will not be
 * found in row 1001.
 */
export const PANEL_TOP_DEVICE_USERS_CEILING = 1000;

/**
 * The contract's own ceiling for the inventory route:
 * `size … .max(1000, 'Size (limit) must be less than 1000')`. Ten times the
 * top-users page because this route is paging DEVICES, not users, and a fleet
 * holds several of them per subscriber.
 */
export const PANEL_ALL_DEVICES_PAGE_SIZE = 1000;

/**
 * How many device rows the inventory walk reads before it stops and says so.
 *
 * Twenty pages. Sized against what the walk is FOR: finding one hwid bound to
 * two owners, which is only visible when both of its rows are in hand. Unlike
 * the top-users list this one has no useful ordering to lean on — the tail is
 * not "users with one device", it is simply the rest of the fleet — so a
 * truncated read here is a genuine blind spot rather than a boring one, and
 * the ceiling has to sit above any realistic fleet rather than at a
 * comfortable sample. At ~3 devices per subscriber this covers roughly 6–7k
 * subscribers; past that the walk reports `complete: false` and the detector
 * says the run was incomplete instead of calling the panel clean.
 */
export const PANEL_ALL_DEVICES_CEILING = 20_000;

/**
 * Twelve attempts at half a second: the same ~6-second budget the hand-rolled
 * implementation used, kept identical so this migration changes routes and
 * body keys and nothing about timing. It is known to be tight for large nodes,
 * which is why it is a per-call option rather than a constant a caller cannot
 * reach — but a budget that runs out reports `null`, never `[]`, so widening it
 * is a matter of coverage and not of correctness.
 */
export const PANEL_JOB_POLL_ATTEMPTS = 12;
export const PANEL_JOB_POLL_INTERVAL_MS = 500;

// ── Envelope reading ────────────────────────────────────────────────────────

/**
 * Takes `response` out of the panel's envelope.
 *
 * On the validated path the contract has already guaranteed the shape, so this
 * is a field access. On the DRIFT path it is the guard: the payload has to be
 * an object, and — when the caller names one — the list it carries has to be an
 * array, or the answer is {@link PanelDevicesOutcome} `unreadable`. A missing
 * list is not an empty list, and rendering it as one is precisely the bug this
 * whole family of guards exists to prevent.
 */
function unwrapEnvelope<T>(
  outcome: PanelCommandOutcome<{ readonly response: T }>,
  requiredArrayField: string | null,
): PanelDevicesOutcome<T> {
  if (outcome.kind !== 'ok') return outcome;
  if (!outcome.drifted) {
    return { kind: 'ok', data: outcome.data.response, drifted: false };
  }

  const envelope = outcome.data as unknown as { response?: unknown } | null;
  const payload = envelope === null ? undefined : envelope.response;
  if (payload === null || typeof payload !== 'object') {
    return { kind: 'unreadable', detail: 'the answer carries no `response` object' };
  }
  if (requiredArrayField !== null) {
    const list = (payload as Record<string, unknown>)[requiredArrayField];
    if (!Array.isArray(list)) {
      return {
        kind: 'unreadable',
        detail: `\`response.${requiredArrayField}\` is not an array, so an empty list would be an invention`,
      };
    }
  }
  return { kind: 'ok', data: payload as T, drifted: true };
}

/**
 * The three device commands all answer `{ total, devices }`, and all three
 * carry the same risk: a caller reads `total` to decide whether a subscriber
 * has a free slot. On the drift path `total` may be missing, so it is filled
 * from the rows we do hold — the rows are the payload, the count is the panel's
 * cross-check, and failing the whole read over a missing count would blank a
 * list we have in full.
 */
function unwrapDeviceList(
  outcome: PanelCommandOutcome<PanelHwidDeviceListEnvelope>,
): PanelDevicesOutcome<PanelHwidDeviceList> {
  const unwrapped = unwrapEnvelope(outcome, 'devices');
  if (unwrapped.kind !== 'ok' || !unwrapped.drifted) return unwrapped;
  const { data } = unwrapped;
  if (typeof data.total === 'number') return unwrapped;
  return { kind: 'ok', data: { ...data, total: data.devices.length }, drifted: true };
}

/** The three job fields, read without trusting a type the drift path can break. */
function readJobEnvelope(
  data: unknown,
): { readonly completed: boolean; readonly failed: boolean; readonly result: unknown } | null {
  const envelope = data as { response?: unknown } | null;
  const body = envelope === null || typeof envelope !== 'object' ? undefined : envelope.response;
  if (body === null || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  const completed = record['isCompleted'];
  const failed = record['isFailed'];
  if (typeof completed !== 'boolean' || typeof failed !== 'boolean') return null;
  return { completed, failed, result: record['result'] };
}

/**
 * The rows out of a completed job, or `null` for "the job ran and we still do
 * not know".
 *
 * `success: false` is a collection that executed and did not work — the panel
 * says so explicitly, and it is not an empty node. An absent `result`, or a
 * `result` whose row list is not an array, is the same fact arriving less
 * politely.
 */
function readJobRows<TRow>(result: unknown, rowsKey: 'users' | 'nodes'): readonly TRow[] | null {
  if (result === null || typeof result !== 'object') return null;
  const record = result as Record<string, unknown>;
  if (record['success'] === false) return null;
  const rows = record[rowsKey];
  return Array.isArray(rows) ? (rows as readonly TRow[]) : null;
}

// ── Request-side checks the executor does not make ─────────────────────────

/**
 * Checks a path parameter or a query against the command's own schema.
 *
 * The executor validates BODIES for the reason it states — a body we built
 * wrong is our bug and a round-trip wasted to learn it. Path parameters and
 * query strings are ours in exactly the same way and it does not cover them, so
 * the rule is extended here rather than left to the panel: `/api/hwid/devices/NaN`
 * comes back as a validation `400` that reads like a rejected user, and
 * `?size=250` comes back as one that reads like a broken endpoint.
 */
function refuseInvalid(
  command: PanelCommand,
  kind: 'param' | 'query',
  value: unknown,
  pathParts: readonly string[],
): { readonly kind: 'invalid-request'; readonly detail: string; readonly command: string } | null {
  const schema: ZodType | undefined =
    kind === 'param' ? command.RequestParamSchema : command.RequestQuerySchema;
  if (schema === undefined) return null;
  const parsed = schema.safeParse(value);
  if (parsed.success) return null;
  return {
    kind: 'invalid-request',
    detail: describeIssues(parsed.error),
    command: describeCommand(command, pathParts),
  };
}

/** {@link refuseInvalid} for the single-parameter routes, which is all of them here. */
function refuseInvalidParam(
  command: PanelCommand,
  params: Record<string, unknown>,
  pathPart: string | number,
): { readonly kind: 'invalid-request'; readonly detail: string; readonly command: string } | null {
  return refuseInvalid(command, 'param', params, [String(pathPart)]);
}

/**
 * Whether a drop request would target nobody.
 *
 * Reads defensively and answers `false` for anything it does not recognise: the
 * body may have been cast past the compiler, and deciding what a malformed one
 * means is the contract's job, not this function's.
 */
function hasEmptySelector(body: PanelDropConnectionsBody): boolean {
  const dropBy = (body as unknown as { dropBy?: unknown }).dropBy;
  if (dropBy === null || typeof dropBy !== 'object') return false;
  const record = dropBy as Record<string, unknown>;
  for (const key of ['userIds', 'ipAddresses']) {
    const list = record[key];
    if (Array.isArray(list) && list.length === 0) return true;
  }
  return false;
}

/**
 * A short, safe rendering of a zod failure — the same shape the executor
 * produces, and the same rule: the MESSAGE only. A zod issue can carry
 * `received`, which for a request is our own payload, and this string goes to
 * the log.
 */
function describeIssues(error: { readonly issues?: ReadonlyArray<unknown> }): string {
  const issues = Array.isArray(error.issues) ? error.issues : [];
  const rendered = issues.slice(0, 5).map((issue) => {
    const record = issue as { path?: unknown; message?: unknown };
    const path =
      Array.isArray(record.path) && record.path.length > 0 ? record.path.join('.') : '(root)';
    const message = typeof record.message === 'string' ? record.message : 'invalid';
    return `${path}: ${message}`;
  });
  return rendered.length === 0 ? 'no detail' : rendered.join('; ');
}

function describeCommand(command: PanelCommand, pathParts: readonly string[]): string {
  const method = command.endpointDetails.REQUEST_METHOD.toUpperCase();
  return `${method} ${resolveCommandUrl(command, pathParts)}`;
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
