import {
  BulkDeleteUsersCommand,
  BulkExtendExpirationDateCommand,
  BulkResetTrafficUsersCommand,
  BulkRevokeUsersSubscriptionCommand,
  BulkUpdateUsersCommand,
  BulkUpdateUsersSquadsCommand,
  CreateUserCommand,
  DeleteUserCommand,
  DisableUserCommand,
  EnableUserCommand,
  ExtendUserCommand,
  GetUserByIdCommand,
  GetUserByShortUuidCommand,
  GetUserByUsernameCommand,
  GetUserSubscriptionRequestHistoryCommand,
  GetUsersStreamCommand,
  GetUsersTagsCommand,
  ResetUserTrafficCommand,
  ResolveUserCommand,
  RevokeUserSubscriptionCommand,
  UpdateUserCommand,
} from '@remnawave/contract-v34';
import type { z } from 'zod';

import type { PanelCommand } from './panel-command.contract';
import type { PanelCommandExecutor, PanelCommandOutcome } from './panel-command.executor';

/**
 * PanelUsersClient
 * ════════════════
 * The user surface of the Remnawave panel, expressed once, in the vendor's own
 * terms. Every method here is a contract command plus the arguments that
 * command declares — no route strings, no verbs, no hand-written response
 * interfaces, and no era branching.
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
 * ── Responses are the contract's own types ──────────────────────────────────
 * Return shapes are `z.infer` over the command's `ResponseSchema`, never
 * re-declared. The envelope is NOT unwrapped for the caller, and that is
 * deliberate: the executor is lenient by design, so an `ok` may carry
 * `drifted: true`, and a drifted body is the panel's RAW answer — unvalidated
 * and untransformed. Unwrapping `.response` there would mean handing back
 * `undefined` typed as a user, and reading `expireAt` as a `Date` when the
 * panel sent a string. The envelope keeps that visible: `drifted` sits next to
 * the data it qualifies, and a caller that cares can check it.
 *
 * ── Request bodies are the contract's own types too ─────────────────────────
 * Bodies are `z.input` (what we SEND) rather than `z.infer` (what the panel's
 * own parser produces after its transforms). The two differ on every date
 * field — `expireAt` is an ISO string on the wire and a `Date` after parsing —
 * and typing a caller against the latter would demand the one value the route
 * cannot accept.
 *
 * ── 3.x ONLY ────────────────────────────────────────────────────────────────
 * There is no uuid addressing here, and no `by-email` / `by-telegram-id`
 * lookup: 3.x deleted the user uuid column outright and those two routes do
 * not exist on 3.3.2. Users are named by numeric id, by username or by
 * shortUuid, which is the whole set the panel still answers to.
 */
export class PanelUsersClient {
  public constructor(private readonly executor: PanelCommandExecutor) {}

  // ═══════════════════════════════════════════════════════════════════════════
  //  CRUD
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * `POST /api/users/`.
   *
   * `trafficLimitStrategy` is optional and NEVER nullable upstream, so a
   * caller with no opinion — a plan snapshot imported without the key, which
   * is every 3x-ui import — must OMIT the field rather than send `null`, and
   * let the panel apply its own `NO_RESET`. The old adapter carried that as a
   * hand-written spread; here the contract states it, and an explicit `null`
   * is refused before the request instead of earning a `400`.
   */
  public async createUser(
    body: CreatePanelUserBody,
  ): Promise<PanelCommandOutcome<PanelUserResponse>> {
    return this.executor.call<PanelUserResponse>(CreateUserCommand, { body });
  }

  /**
   * `PATCH /api/users/` — the identifier lives in the BODY, not the path.
   *
   * The whole body is taken rather than an id plus fields, because the
   * contract accepts two identities (`id` and `username`) and the second is
   * the only one that still addresses a profile created on 2.x whose numeric
   * id we never recorded. Which one to send is the caller's fact, not this
   * file's guess.
   *
   * A body keyed `{ uuid }` — what this integration sends today — dies at the
   * executor with the contract's own wording and never reaches the panel. It
   * is a guaranteed `400`, and the sync layer files a `400` as terminal, so
   * every such profile silently stopped converging.
   */
  public async updateUser(
    body: UpdatePanelUserBody,
  ): Promise<PanelCommandOutcome<PanelUserResponse>> {
    return this.executor.call<PanelUserResponse>(UpdateUserCommand, { body });
  }

  /** `GET /api/users/{id}`. */
  public async getUserById(userId: number): Promise<PanelCommandOutcome<PanelUserResponse>> {
    return this.callForUser<PanelUserResponse>(GetUserByIdCommand, userId);
  }

  /**
   * `DELETE /api/users/{id}`.
   *
   * `unknown`, not `{ isDeleted: boolean }`: contract 3.4.2 declares no
   * `ResponseSchema` for this route, and 3.x answers `204` with an empty body
   * where 2.x answered `200 {"response":{"isDeleted":true}}`. Inventing a
   * shape here would put a hand-written interface back in exactly the place
   * this migration is removing them from. A `2xx` is the success signal.
   */
  public async deleteUser(userId: number): Promise<PanelCommandOutcome<unknown>> {
    return this.callForUser<unknown>(DeleteUserCommand, userId);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  LOOKUPS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * `GET /api/users/by-username/{username}`.
   *
   * THE SEGMENT IS ENCODED HERE because the vendor's builder does not encode:
   * `USERS_ROUTES.GET_BY.USERNAME` is a bare template literal, so a value
   * carrying `/` would silently address a different route and a value carrying
   * `?` would turn the rest of the name into a query string. Panel usernames
   * we create are `[a-zA-Z0-9_-]+`, but this method is also the operator
   * search box, which takes whatever was typed.
   *
   * This is the CREATE path's idempotency check: if a previous attempt made
   * the profile but failed to persist the link, reusing it is the only way to
   * avoid a create loop against `400 username already exists`.
   */
  public async getUserByUsername(
    username: string,
  ): Promise<PanelCommandOutcome<PanelUserResponse>> {
    return this.callByKey<PanelUserResponse>(GetUserByUsernameCommand, 'username', username);
  }

  /** `GET /api/users/by-short-uuid/{shortUuid}`. Encoded for the same reason. */
  public async getUserByShortUuid(
    shortUuid: string,
  ): Promise<PanelCommandOutcome<PanelUserResponse>> {
    return this.callByKey<PanelUserResponse>(GetUserByShortUuidCommand, 'shortUuid', shortUuid);
  }

  /**
   * `POST /api/users/resolve` — maps any ONE of id / shortUuid / username onto
   * the others.
   *
   * EXACTLY one: the contract refuses a selector carrying two, and so does the
   * panel. The refusal happens here, before the round-trip, and quotes the
   * panel's own sentence.
   *
   * The 3.x answer carries no `uuid`, because 3.x users have none. A caller
   * still reading one off this result is reading a field the panel stopped
   * sending.
   */
  public async resolveUser(
    selector: ResolvePanelUserSelector,
  ): Promise<PanelCommandOutcome<PanelUserResolutionResponse>> {
    return this.executor.call<PanelUserResolutionResponse>(ResolveUserCommand, { body: selector });
  }

  /**
   * `GET /api/users/stream` — ONE keyset page.
   *
   * WHY THE OFFSET ROUTE (`GET /api/users/`) IS NOT EXPOSED HERE. Offset
   * paging over a list that keeps mutating loses rows at the source: delete
   * one user between page 0 and page 1 and every later row shifts one place
   * left, so a live user is never served — and the arithmetic still
   * reconciles, because the panel's own `total` fell by the same one. That
   * user then misses in the caller's overlay map and is written EXPIRED. The
   * keyset cursor cannot do that, and on a 3.x-only target there is no version
   * left that lacks it.
   *
   * THE CURSOR CROSSES TYPES, and it is not a mistake to accommodate both: the
   * response declares `nextCursor` as a nullable STRING while the query
   * declares `cursor` as a coerced NUMBER. Feeding the panel's own answer
   * straight back is the intended use, so both are accepted and the contract's
   * coercion does the rest.
   *
   * The query is validated against the contract before it is sent, which the
   * executor does not do for queries — it guards bodies only. That is worth
   * the four lines: `size` is bounded `1..1000` upstream, and a caller asking
   * for more gets a SERVER-SIDE CLAMP, i.e. fewer rows than it asked for with
   * nothing saying so. A walk that then advances by the size it requested
   * skips every row the panel chose not to send.
   *
   * The PARSED query is what goes on the wire, not the caller's object — which
   * is the opposite of what the executor does with a body, and deliberately
   * so. Here the parse is the only thing that turns a string cursor into the
   * number the route wants and supplies the vendor's own `size` default; a
   * body, by contrast, is forwarded verbatim so that what we validated and
   * what we sent are the same bytes.
   *
   * ONE PAGE, and the walk stays with the caller. Whether a short read may be
   * treated as the whole panel is a question about what the caller does with a
   * miss, not about HTTP: `strictGetAllPanelUsers` refuses a prefix flagged
   * complete because a miss there is written EXPIRED. A generic client cannot
   * make that judgement for everyone.
   */
  public async streamUsers(
    options: PanelUserStreamOptions = {},
  ): Promise<PanelCommandOutcome<PanelUserStreamResponse>> {
    const parsed = GetUsersStreamCommand.RequestQuerySchema.safeParse(options);
    if (!parsed.success) {
      return refusal(GetUsersStreamCommand, parsed.error);
    }
    return this.executor.call<PanelUserStreamResponse>(GetUsersStreamCommand, {
      query: parsed.data,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  SINGLE-USER ACTIONS
  // ═══════════════════════════════════════════════════════════════════════════

  /** `POST /api/users/{id}/actions/reset-traffic` — zero the traffic counter. */
  public async resetTraffic(userId: number): Promise<PanelCommandOutcome<PanelUserResponse>> {
    return this.callForUser<PanelUserResponse>(ResetUserTrafficCommand, userId);
  }

  /**
   * `POST /api/users/{id}/actions/revoke` — rotate the subscription link.
   *
   * The body defaults to `{}` rather than being omitted. The route's schema is
   * a `preprocess` that tolerates an absent body, but omitting it also drops
   * `Content-Type: application/json` in the transport, and the adapter this
   * replaces always sent `{}` against live panels. Keeping the empty object
   * changes nothing the panel can object to and keeps the request identical to
   * the one already proven in production.
   *
   * `revokeOnlyPasswords: true` is the option that rotates credentials WITHOUT
   * changing the short uuid — i.e. without invalidating the customer's saved
   * subscription URL. Rotating it is what a mis-addressed call did to a paying
   * customer once; naming the narrower option here is what makes the safer
   * choice available rather than folklore.
   */
  public async revokeSubscription(
    userId: number,
    body: RevokePanelUserSubscriptionBody = {},
  ): Promise<PanelCommandOutcome<PanelUserResponse>> {
    return this.callForUser<PanelUserResponse>(RevokeUserSubscriptionCommand, userId, { body });
  }

  /** `POST /api/users/{id}/actions/enable`. */
  public async enableUser(userId: number): Promise<PanelCommandOutcome<PanelUserResponse>> {
    return this.callForUser<PanelUserResponse>(EnableUserCommand, userId);
  }

  /** `POST /api/users/{id}/actions/disable`. */
  public async disableUser(userId: number): Promise<PanelCommandOutcome<PanelUserResponse>> {
    return this.callForUser<PanelUserResponse>(DisableUserCommand, userId);
  }

  /**
   * `POST /api/users/{id}/actions/extend` — add `days` to the expiry.
   *
   * NOT the same operation as a `PATCH` with a computed `expireAt`, and the
   * difference is the panel's, not ours: an EXPIRED user is extended from
   * TODAY and becomes ACTIVE again, an ACTIVE one from its existing expiry,
   * and DISABLED/LIMITED users are extended without their status changing.
   * Computing the date on our side would have to reproduce all four rules and
   * would get the first one wrong for exactly the population that is renewing.
   */
  public async extendUser(
    userId: number,
    days: number,
  ): Promise<PanelCommandOutcome<PanelUserResponse>> {
    return this.callForUser<PanelUserResponse>(ExtendUserCommand, userId, { body: { days } });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  BULK ACTIONS
  // ═══════════════════════════════════════════════════════════════════════════
  //
  //  ONE REQUEST FOR N USERS. That is the entire reason these routes exist,
  //  and the reason a loop over the single-user actions is not an acceptable
  //  substitute: the panel applies the whole set in one transaction, while N
  //  requests can stop halfway and leave a set of users in two different
  //  states with no record of where the line fell.
  //
  //  THE 500 CAP IS THE CONTRACT'S AND IS NOT WORKED AROUND. `userIds` is
  //  `min(1).max(500)`, so a larger list is refused here, before the request,
  //  as `invalid-request`. Chunking it silently would give back the failure
  //  mode above — several requests behind a signature that promises one, and a
  //  single outcome that cannot say which chunks landed. A caller that needs
  //  more than 500 has to decide for itself what a half-applied batch means.
  //  `min(1)` matters just as much in the other direction: an EMPTY list is
  //  refused rather than sent, because `bulk/delete` with no ids is a request
  //  whose meaning depends entirely on how the panel reads it.

  /** `POST /api/users/bulk/reset-traffic`. */
  public async bulkResetTraffic(
    userIds: readonly number[],
  ): Promise<PanelCommandOutcome<unknown>> {
    return this.executor.call<unknown>(BulkResetTrafficUsersCommand, {
      body: { userIds: [...userIds] },
    });
  }

  /** `POST /api/users/bulk/delete`. */
  public async bulkDelete(userIds: readonly number[]): Promise<PanelCommandOutcome<unknown>> {
    return this.executor.call<unknown>(BulkDeleteUsersCommand, {
      body: { userIds: [...userIds] },
    });
  }

  /**
   * `POST /api/users/bulk/update` — the same `fields` for every id.
   *
   * `fields` is a NARROWER set than the single-user `PATCH` accepts: there is
   * no `activeInternalSquads` here, because squads have their own bulk route
   * below. The contract's object STRIPS unknown keys rather than refusing
   * them, so a caller that puts squads in `fields` gets a clean validation, a
   * `200`, and no squad change — use {@link bulkUpdateSquads}.
   */
  public async bulkUpdate(
    userIds: readonly number[],
    fields: BulkUpdatePanelUserFields,
  ): Promise<PanelCommandOutcome<unknown>> {
    return this.executor.call<unknown>(BulkUpdateUsersCommand, {
      body: { userIds: [...userIds], fields },
    });
  }

  /**
   * `POST /api/users/bulk/update-squads`.
   *
   * The squad list REPLACES the users' membership, it does not add to it — an
   * empty array is how every squad is removed, and is a legitimate call rather
   * than a caller that forgot to fill it in.
   */
  public async bulkUpdateSquads(
    userIds: readonly number[],
    activeInternalSquads: readonly string[],
  ): Promise<PanelCommandOutcome<unknown>> {
    return this.executor.call<unknown>(BulkUpdateUsersSquadsCommand, {
      body: { userIds: [...userIds], activeInternalSquads: [...activeInternalSquads] },
    });
  }

  /**
   * `POST /api/users/bulk/revoke-subscription`.
   *
   * Unlike the single-user route this has no `revokeOnlyPasswords`, so it
   * ALWAYS rotates the short uuid — every customer in the list gets a new
   * subscription URL and their saved one stops working. There is no narrower
   * bulk form to reach for.
   */
  public async bulkRevokeSubscription(
    userIds: readonly number[],
  ): Promise<PanelCommandOutcome<unknown>> {
    return this.executor.call<unknown>(BulkRevokeUsersSubscriptionCommand, {
      body: { userIds: [...userIds] },
    });
  }

  /** `POST /api/users/bulk/extend-expiration-date` — `1..9999` days, per the contract. */
  public async bulkExtendExpirationDate(
    userIds: readonly number[],
    extendDays: number,
  ): Promise<PanelCommandOutcome<unknown>> {
    return this.executor.call<unknown>(BulkExtendExpirationDateCommand, {
      body: { userIds: [...userIds], extendDays },
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  READS AROUND A USER
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * `GET /api/users/{id}/subscription-request-history`.
   *
   * FIXED AT 24 RECORDS UPSTREAM — the per-user route declares no page size,
   * and the adapter this replaces used to send `userUuid` and `limit` as query
   * parameters that exist in NO spec, so a caller asking for one customer's
   * trail was served an unfiltered page of the whole panel's log and had no
   * way to tell. There is no page size to pass here because there is none to
   * pass.
   */
  public async getSubscriptionRequestHistory(
    userId: number,
  ): Promise<PanelCommandOutcome<PanelUserSubscriptionRequestHistoryResponse>> {
    return this.callForUser<PanelUserSubscriptionRequestHistoryResponse>(
      GetUserSubscriptionRequestHistoryCommand,
      userId,
    );
  }

  /** `GET /api/users/tags` — every tag in use on the panel. */
  public async getUserTags(): Promise<PanelCommandOutcome<PanelUserTagsResponse>> {
    return this.executor.call<PanelUserTagsResponse>(GetUsersTagsCommand);
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
   *   • the contract's own `RequestParamSchema` (`z.coerce.number().positive()`),
   *     so a rule the vendor changes changes here with it;
   *   • safe-integer, which the vendor's rule does NOT imply and `String()`
   *     punishes: `String(1e21)` is `'1e+21'` and `String(4471.5)` is
   *     `'4471.5'`. Both pass `positive()`, and both address a route that
   *     cannot exist. `NaN` — what `Number(remnawaveId)` yields for a 2.x uuid
   *     still sitting in the column — is caught by the first rule and never
   *     reaches `/api/users/NaN`.
   */
  private async callForUser<TResult>(
    command: PanelCommand,
    userId: number,
    input: { readonly body?: unknown } = {},
  ): Promise<PanelCommandOutcome<TResult>> {
    const parsed = command.RequestParamSchema?.safeParse({ userId });
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
    return this.executor.call<TResult>(command, { pathParts: [String(userId)], ...input });
  }

  /**
   * One command against a string key that goes in the path.
   *
   * Encoded, for the reason on {@link PanelUsersClient.getUserByUsername}, and
   * refused when empty: the vendor's builder would produce
   * `/api/users/by-username/`, which is a DIFFERENT route and answers about a
   * different thing entirely.
   */
  private async callByKey<TResult>(
    command: PanelCommand,
    keyName: string,
    value: string,
  ): Promise<PanelCommandOutcome<TResult>> {
    const parsed = command.RequestParamSchema?.safeParse({ [keyName]: value });
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
//  Types, taken from the contract rather than restated
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The `{ response: … }` envelope every single-user route answers with.
 *
 * Sourced from `GetUserByIdCommand` and shared by create, update, the four
 * actions and both `by-*` lookups because the contract itself shares one
 * `UserResponseSchema` across all of them. If the vendor ever splits them, the
 * split shows up here as a type error rather than as a runtime surprise.
 */
export type PanelUserResponse = z.infer<typeof GetUserByIdCommand.ResponseSchema>;

/** One user row: id, status, limits, squads, traffic. Never hand-written. */
export type PanelUser = PanelUserResponse['response'];

/** One keyset page: `{ response: { users, nextCursor, hasMore } }`. */
export type PanelUserStreamResponse = z.infer<typeof GetUsersStreamCommand.ResponseSchema>;

/** `{ response: { id, username, shortUuid } }` — no uuid on 3.x, by design. */
export type PanelUserResolutionResponse = z.infer<typeof ResolveUserCommand.ResponseSchema>;

/** `{ response: { total, records } }`, capped at 24 records upstream. */
export type PanelUserSubscriptionRequestHistoryResponse = z.infer<
  typeof GetUserSubscriptionRequestHistoryCommand.ResponseSchema
>;

/** `{ response: { tags } }`. */
export type PanelUserTagsResponse = z.infer<typeof GetUsersTagsCommand.ResponseSchema>;

/** What `POST /api/users/` accepts. `z.input`: `expireAt` is an ISO string here. */
export type CreatePanelUserBody = z.input<typeof CreateUserCommand.RequestBodySchema>;

/** What `PATCH /api/users/` accepts, identity included. */
export type UpdatePanelUserBody = z.input<typeof UpdateUserCommand.RequestBodySchema>;

/** Exactly one of `id` / `shortUuid` / `username`, enforced by the contract. */
export type ResolvePanelUserSelector = z.input<typeof ResolveUserCommand.RequestBodySchema>;

/**
 * `z.output`, not `z.input`, and only because the vendor wrapped this one body
 * in a `preprocess` — whose declared input is `unknown` and would type a
 * caller against nothing at all. The output side still describes the two
 * fields the route reads.
 */
export type RevokePanelUserSubscriptionBody = z.output<
  typeof RevokeUserSubscriptionCommand.RequestBodySchema
>;

/** The fields `bulk/update` applies to every id in the batch. */
export type BulkUpdatePanelUserFields = z.input<
  typeof BulkUpdateUsersCommand.RequestBodySchema
>['fields'];

/**
 * The stream filters, with the two coerced parameters narrowed.
 *
 * `z.input` of a `z.coerce.number()` is `unknown`, which would let a caller
 * pass anything and learn about it at runtime. `cursor` admits both forms on
 * purpose — the panel hands back `nextCursor` as a string and feeding it
 * straight back is the intended use — while `size` is a number the caller
 * chose, not something read off a response.
 */
export type PanelUserStreamOptions = Omit<
  z.input<typeof GetUsersStreamCommand.RequestQuerySchema>,
  'cursor' | 'size'
> & {
  readonly cursor?: string | number;
  readonly size?: number;
};

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
 * A short, log-safe rendering of a zod failure. The MESSAGE only, never the
 * value: a zod issue can carry `received`, and for a request that is our own
 * payload — on this integration, customer emails and telegram ids — and this
 * string goes to the log. Deliberately the same rule the executor applies to
 * its own refusals; duplicated rather than shared because the executor keeps
 * its renderer private and neither should reach into the other.
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
  const suffix = issues.length > rendered.length ? ` (+${issues.length - rendered.length} more)` : '';
  return rendered.length === 0 ? 'no detail' : `${rendered.join('; ')}${suffix}`;
}

/**
 * Names the command in a refusal. A parameterised route is rendered with the
 * vendor's own builder against `:userId` — the point of the line is to say
 * WHICH route was refused, and the parameter is the thing that was wrong.
 */
function describeCommand(command: PanelCommand): string {
  const method = command.endpointDetails.REQUEST_METHOD.toUpperCase();
  const url = typeof command.url === 'string' ? command.url : command.url(':userId');
  const description = command.endpointDetails.METHOD_DESCRIPTION;
  return description === undefined ? `${method} ${url}` : `${method} ${url} (${description})`;
}
