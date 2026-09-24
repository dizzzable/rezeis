import type { z } from 'zod';

import { describeIssues, type PanelCommand } from './panel-command.contract';
import type { PanelCommandExecutor, PanelCommandOutcome } from './panel-command.executor';
import { PANEL_COMMANDS } from './panel-commands';

/**
 * PanelUsersClient
 * ════════════════
 * The user surface of the Remnawave panel that rezeis actually uses — create,
 * update, read by id or by name, resolve, reset traffic, delete — expressed as
 * entries of the hand-owned command table. No route strings, no verbs, and no
 * era branching live here.
 *
 * ── Why every method hands back the executor's outcome ──────────────────────
 * The methods this replaces answered `null` for six different events: a
 * missing profile, an expired token, a 5xx, a timeout, an unconfigured
 * integration and a body we built wrong. `sharing-detectors.ts` records what
 * that costs — a detector whose device read had failed reported a clean panel
 * forever, because "nobody is over their limit" and "we could not look" arrive
 * as the same empty value, and the detector had no way to ask which one it
 * held. So nothing here collapses: `rejected` (the panel answered and refused,
 * with its status and its `A0xx` code), `network` (nothing was heard back),
 * `unconfigured` (a setting, not a fault) and `invalid-request` (our bug,
 * never sent) stay apart all the way to the caller.
 *
 * Nothing here decides what a `404` MEANS, either. A `404` carrying the
 * panel's own `A025`/`A063` envelope is a missing profile; a bare `404` is
 * what a reverse proxy answers to everything while it has no healthy backend,
 * and `remnawave-api.service.ts` documents what reading the second as the
 * first did — it detached live subscriptions from running profiles. Both
 * arrive here as `rejected` with `status` and `code` intact, and the caller
 * that knows which of the two it can act on makes the call.
 *
 * ── Responses are the panel's JSON ──────────────────────────────────────────
 * The `{ response: … }` envelope is handed back as it arrived, typed by
 * {@link PanelUserResponse} for the fields rezeis reads and validated by nobody.
 * Every consumer already reads those fields defensively — `readPanelUserId`,
 * `panelTimestamp`, `panelExpiryToLocal`, the ownership check — because that is what
 * the executor's old drift path handed them on some panel releases anyway. The
 * consumer audit behind this change found no users caller that depended on the
 * vendor parse's `Date` objects or stripped keys.
 *
 * ── Request bodies come from the table ──────────────────────────────────────
 * Bodies are `z.input` of the table's own schemas (what we SEND) rather than
 * the parsed output: `expireAt` is an ISO string on the way in and the executor
 * sends what the schema produced.
 *
 * ── 3.x ONLY ────────────────────────────────────────────────────────────────
 * There is no uuid addressing here: 3.x deleted the user uuid column outright.
 * Users are named by numeric id or by username, and resolved by shortUuid or
 * username when neither id is on hand.
 */
export class PanelUsersClient {
  public constructor(private readonly executor: PanelCommandExecutor) {}

  // ═══════════════════════════════════════════════════════════════════════════
  //  CRUD
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * `POST /api/users/`.
   *
   * `trafficLimitStrategy` is optional and NEVER nullable upstream, so a caller
   * with no opinion — a plan snapshot imported without the key, which is every
   * 3x-ui import — OMITS the field rather than sending `null`. The table's
   * schema then fills the panel's own default, `NO_RESET`, into the body that is
   * sent, exactly as the vendor schema did; an explicit `null` is refused before
   * the request instead of earning a `400`.
   */
  public async createUser(
    body: CreatePanelUserBody,
  ): Promise<PanelCommandOutcome<PanelUserResponse>> {
    return this.executor.call<PanelUserResponse>(PANEL_COMMANDS.CreateUserCommand, { body });
  }

  /**
   * `PATCH /api/users/` — the identifier lives in the BODY, not the path.
   *
   * The whole body is taken rather than an id plus fields, because the route
   * accepts two identities (`id` and `username`). Which one to send is the
   * caller's fact, not this file's guess. A body carrying neither — the
   * `{ uuid }` key this integration once sent — is refused with the panel's own
   * wording and never reaches the wire.
   */
  public async updateUser(
    body: UpdatePanelUserBody,
  ): Promise<PanelCommandOutcome<PanelUserResponse>> {
    return this.executor.call<PanelUserResponse>(PANEL_COMMANDS.UpdateUserCommand, { body });
  }

  /** `GET /api/users/{id}`. */
  public async getUserById(userId: number): Promise<PanelCommandOutcome<PanelUserResponse>> {
    return this.callForUser<PanelUserResponse>(PANEL_COMMANDS.GetUserByIdCommand, userId);
  }

  /**
   * `DELETE /api/users/{id}`.
   *
   * `unknown`: 3.x answers `204` with an empty body where 2.x answered
   * `200 {"response":{"isDeleted":true}}`. A `2xx` is the success signal.
   */
  public async deleteUser(userId: number): Promise<PanelCommandOutcome<unknown>> {
    return this.callForUser<unknown>(PANEL_COMMANDS.DeleteUserCommand, userId);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  LOOKUPS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * `GET /api/users/by-username/{username}`.
   *
   * THE SEGMENT IS ENCODED HERE because the route builder does not encode, and
   * neither does the vendor's: a value carrying `/` would silently address a
   * different route and a value carrying `?` would turn the rest of the name
   * into a query string. Panel usernames we create are `[a-zA-Z0-9_-]+`, but a
   * stored name is not something this method gets to assume.
   *
   * This is the CREATE path's idempotency check: if a previous attempt made
   * the profile but failed to persist the link, reusing it is the only way to
   * avoid a create loop against `400 username already exists`.
   */
  public async getUserByUsername(
    username: string,
  ): Promise<PanelCommandOutcome<PanelUserResponse>> {
    return this.callByKey<PanelUserResponse>(
      PANEL_COMMANDS.GetUserByUsernameCommand,
      'username',
      username,
    );
  }

  /**
   * `POST /api/users/resolve` — maps any ONE of id / shortUuid / username onto
   * the others.
   *
   * EXACTLY one: the table refuses a selector carrying two, and so does the
   * panel. The refusal happens here, before the round-trip, and quotes the
   * panel's own sentence.
   *
   * The 3.x answer carries no `uuid`, because 3.x users have none.
   */
  public async resolveUser(
    selector: ResolvePanelUserSelector,
  ): Promise<PanelCommandOutcome<PanelUserResolutionResponse>> {
    return this.executor.call<PanelUserResolutionResponse>(PANEL_COMMANDS.ResolveUserCommand, {
      body: selector,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  SINGLE-USER ACTIONS
  // ═══════════════════════════════════════════════════════════════════════════

  /** `POST /api/users/{id}/actions/reset-traffic` — zero the traffic counter. */
  public async resetTraffic(userId: number): Promise<PanelCommandOutcome<PanelUserResponse>> {
    return this.callForUser<PanelUserResponse>(PANEL_COMMANDS.ResetUserTrafficCommand, userId);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Addressing
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * One command against one numeric user id.
   *
   * THE ID IS CHECKED BEFORE IT BECOMES A PATH SEGMENT, which the executor
   * does not do — it guards request bodies only, and a path parameter is just
   * as much ours as a body is. Two rules, in order:
   *
   *   • the table's `params` schema (`z.coerce.number().positive()`, the rule
   *     every contract declares for this parameter);
   *   • safe-integer, which that rule does NOT imply and `String()` punishes:
   *     `String(1e21)` is `'1e+21'` and `String(4471.5)` is `'4471.5'`. Both
   *     pass `positive()`, and both address a route that cannot exist. `NaN` —
   *     what `Number(remnawaveId)` yields for a 2.x uuid still sitting in the
   *     column — is caught by the first rule and never reaches `/api/users/NaN`.
   */
  private async callForUser<TResult>(
    command: PanelCommand,
    userId: number,
  ): Promise<PanelCommandOutcome<TResult>> {
    const parsed = command.params?.safeParse({ userId });
    if (parsed !== undefined && !parsed.success) {
      return refusal(command, parsed.error);
    }
    if (!Number.isSafeInteger(userId)) {
      return {
        kind: 'invalid-request',
        detail: `userId: ${userId} is not a safe integer and has no usable decimal form`,
        command: describeCommand(command),
      };
    }
    return this.executor.call<TResult>(command, { pathParts: [String(userId)] });
  }

  /**
   * One command against a string key that goes in the path.
   *
   * Encoded, for the reason on {@link PanelUsersClient.getUserByUsername}, and
   * refused when empty: the builder would produce `/api/users/by-username/`,
   * which is a DIFFERENT route and answers about a different thing entirely.
   */
  private async callByKey<TResult>(
    command: PanelCommand,
    keyName: string,
    value: string,
  ): Promise<PanelCommandOutcome<TResult>> {
    const parsed = command.params?.safeParse({ [keyName]: value });
    if (parsed !== undefined && !parsed.success) {
      return refusal(command, parsed.error);
    }
    if (value.length === 0) {
      return {
        kind: 'invalid-request',
        detail: `${keyName}: an empty lookup key addresses the collection route, not a user`,
        command: describeCommand(command),
      };
    }
    return this.executor.call<TResult>(command, { pathParts: [encodeURIComponent(value)] });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  Types
// ═════════════════════════════════════════════════════════════════════════════

/**
 * One user row, as the panel serves it — the fields rezeis READS, and only
 * those. Hand-written on purpose: this is a statement about what the callers
 * rely on, not a copy of any one release's schema. The panel sends more (see
 * `test/fixtures/remnawave/3.3.2/user.json`), and nothing strips it any more.
 *
 * Dates are the wire strings. Every reader goes through a helper that accepts a
 * string or a `Date` (`panelTimestamp`, `panelExpiryToLocal`), so a test double
 * that hands over a `Date` still exercises the real path.
 */
export type PanelUser = {
  readonly id: number;
  readonly username: string;
  readonly description: string | null;
  readonly subscriptionUrl: string;
  readonly expireAt: string;
  readonly createdAt: string;
  readonly trafficLimitBytes: number;
  /** `null` and `0` both mean unlimited on 3.x. */
  readonly hwidDeviceLimit: number | null;
  /**
   * `ACTIVE`, `DISABLED`, `LIMITED` or `EXPIRED` — required in `UserResponseDto`
   * on 3.2.1 to 3.4.4, and, in the answer to a PATCH, the status AFTER the
   * change: the panel lifts LIMITED and EXPIRED in the same call when the
   * change warrants it. Optional here because nothing validates the body;
   * read it through `readPanelDerivedStatus`.
   */
  readonly status?: string;
};

/** The `{ response: … }` envelope every single-user route answers with. */
export type PanelUserResponse = { readonly response: PanelUser };

/** `{ response: { id, username, shortUuid } }` — no uuid on 3.x, by design. */
export type PanelUserResolutionResponse = {
  readonly response: {
    readonly id: number;
    readonly username: string;
    readonly shortUuid: string;
  };
};

/** What `POST /api/users/` accepts. `z.input`: `expireAt` is an ISO string here. */
export type CreatePanelUserBody = z.input<typeof PANEL_COMMANDS.CreateUserCommand.body>;

/** What `PATCH /api/users/` accepts, identity included. */
export type UpdatePanelUserBody = z.input<typeof PANEL_COMMANDS.UpdateUserCommand.body>;

/** Exactly one of `id` / `shortUuid` / `username`, enforced by the table. */
export type ResolvePanelUserSelector = z.input<typeof PANEL_COMMANDS.ResolveUserCommand.body>;

// ═════════════════════════════════════════════════════════════════════════════
//  Refusals
// ═════════════════════════════════════════════════════════════════════════════

/**
 * A request we built wrong, phrased exactly as the executor phrases its own.
 *
 * Same tagged shape on purpose: a caller must not have to learn whether a
 * refusal came from the path check here or the body check one layer down —
 * both mean "our bug, nothing was sent, retrying will not help".
 */
function refusal<TResult>(
  command: PanelCommand,
  error: { readonly issues?: ReadonlyArray<unknown> },
): PanelCommandOutcome<TResult> {
  return {
    kind: 'invalid-request',
    detail: describeIssues(error),
    command: describeCommand(command),
  };
}

/**
 * Names the command in a refusal. A parameterised route is rendered against
 * `:userId` — the point of the line is to say WHICH route was refused, and the
 * parameter is the thing that was wrong.
 */
function describeCommand(command: PanelCommand): string {
  const url = typeof command.url === 'string' ? command.url : command.url(':userId');
  return `${command.method.toUpperCase()} ${url} (${command.description})`;
}
