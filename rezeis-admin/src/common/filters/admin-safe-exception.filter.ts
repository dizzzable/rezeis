import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Request, Response } from 'express';

import { isSafeRequestId, sanitizePath } from './filter-utils';

interface SafeErrorResponse {
  timestamp: string;
  path: string;
  requestId: string | null;
  statusCode: number;
  message: string | string[];
  errorCode: string;
  /**
   * Stable product code from intentional HttpException bodies
   * (`{ code: 'SUBSCRIPTION_LIMIT_REACHED', message: '...' }`). Allowlisted —
   * never forwards arbitrary exception fields.
   */
  code?: string;
  /**
   * Which credential a re-authentication refusal is asking for. Carried only
   * by the codes in `CODES_CARRYING_REAUTH_FACTOR`, and only with one of the
   * two literal values below — see `extractSafeReauthFactor`.
   */
  factor?: SafeReauthFactor;
  error?: string;
}

/**
 * The complete set of credentials the panel can demand a second time. Declared
 * as a union rather than `string` so widening it is an edit somebody has to
 * make on purpose, not a value that arrives from an exception body.
 */
type SafeReauthFactor = 'totp' | 'password';

const GENERIC_INTERNAL_ERROR_MESSAGE = 'Internal server error';
const GENERIC_INTERNAL_ERROR_CODE = 'INTERNAL_SERVER_ERROR';
/**
 * Product codes that BFF/SPA may branch on. Only these survive the safe filter
 * when thrown as `new BadRequestException({ code, message })`.
 *
 * EXPORTED so the two-set rule below can be checked mechanically instead of
 * remembered — the same reason `SAFE_PRODUCT_MESSAGES` is exported. Read-only
 * at the type level: this is the filter's allowlist, not a registry anything
 * else may add to at runtime.
 */
export const SAFE_PRODUCT_CODES: ReadonlySet<string> = new Set<string>([
  'SUBSCRIPTION_LIMIT_REACHED',
  'REGISTRATION_DISABLED',
  'INVITE_REQUIRED',
  // Sits with its two neighbours above for the same reason: all three are
  // registration refusals at 403, and without the code the BFF cannot tell
  // them apart. Collapsed into one message, "accept the terms" reaches the
  // visitor as "registration is disabled" — false whenever registration is in
  // fact enabled, and nothing they can act on.
  'LEGAL_CONSENT_REQUIRED',
  'SERVICE_RESTRICTED',
  'PURCHASES_DISABLED',
  'PAYMENT_DRAFT_QUOTE_NOT_ELIGIBLE',
  'PAYMENT_DRAFT_TRIAL_UNSUPPORTED',
  'PARTNER_BALANCE_DISABLED',
  'PARTNER_BALANCE_NOT_AVAILABLE',
  'USER_DELETE_PROTECTED_HISTORY',
  // Its nearest neighbour, and here for the same reason: both are deletions
  // refused on the STATE OF THE DATA rather than on the request, both are 409,
  // and a 409 without a code is indistinguishable from every other conflict the
  // panel can answer with. This one refuses because the subscription's stored
  // Remnawave identity is a 2.x uuid on a panel that is now 3.x, so a deletion
  // would remove whatever the address fallback resolves to instead of the
  // profile the row was written for. The operator's next action is specific —
  // run the panel-link reconciliation on the Subscriptions page, then delete
  // again — and stripped of the code the SPA can only offer a retry, which
  // presses the same refusal a second time.
  'SUBSCRIPTION_DELETE_STALE_PANEL_LINK',
  // The same refusal on the DEVICE verb, and a separate code rather than a
  // second use of the one above because a client BRANCHES on it and the two
  // branches differ. `deletePanelUserDevice` addresses its owner through the
  // identical `panelUserAddress` fallback, so on a 3.x panel a stale 2.x
  // identity unbinds a device belonging to whichever account is live at that
  // address. What the client has to say afterwards is not what the subscription
  // refusal says: the subscription is intact and it is the DEVICE that is still
  // bound, so the follow-up is "revoke it again after the repair", not "delete
  // it again". Sharing the code would put subscription-deletion copy on a
  // device dialog and offer the wrong retry.
  //
  // It is raised at three call sites across TWO audiences — the operator panel
  // and the reiwa cabinet — with one code and two sentences; the code is what
  // each client branches on, and the sentence is the fallback for a build that
  // does not know the code yet. Stripped of the code, the cabinet would print
  // an untyped 409 and the customer would be invited to press revoke again.
  'SUBSCRIPTION_DEVICE_DELETE_STALE_PANEL_LINK',
  // The same refusal on the REGENERATE verb, and a THIRD code for the same
  // reason the second one exists: a client branches on it and the branches
  // differ. `regeneratePanelUserSubscription` addresses its target through the
  // identical `panelUserAddress` fallback, so on a 3.x panel a stale 2.x
  // identity rotates the subscription short uuid of whichever account is live
  // at that address — and unlike the other two, that is IRREVERSIBLE: every
  // client link the real customer holds dies at once, the panel cannot re-issue
  // the old value, and nothing here ever held it in a restorable form.
  //
  // What the client has to say is the OPPOSITE of what a successful
  // regeneration means: the links were NOT rotated and all of them still work,
  // so the follow-up is "regenerate again after the repair" — not "delete it
  // again", not "revoke it again". Stripped of the code the cabinet prints an
  // untyped 409 and invites the customer to press regenerate a second time,
  // which presses the same refusal, and the one fact they needed — that the
  // link they wanted rotated is still live — is never said at all.
  'SUBSCRIPTION_REGENERATE_STALE_PANEL_LINK',
  // The two paid-trial refusals ask the buyer for opposite things — one is
  // final, the other is resolvable by abandoning their own unfinished
  // checkout. Without both here the filter strips the code and the BFF can
  // only report a generic failure, which is the very confusion these codes
  // were split apart to end.
  'TRIAL_ALREADY_USED',
  'TRIAL_PENDING_CHECKOUT_STALE',
  // Abandon refusals. Both mean "not now, and here is why" — collapsed into an
  // untyped 400 the buyer would just see a cancel button that does nothing.
  'PAYMENT_ALREADY_AT_PROVIDER',
  'PAYMENT_PROVIDER_CREATE_IN_FLIGHT',
  // The three renewal-checkout outcomes the reiwa BFF maps in
  // `api/routes/payments-errors.ts` (`RENEWAL_ERROR_MESSAGES`). It reads the
  // `code` field off the upstream body and nothing else, so a stripped code
  // is not a degraded message — it is a different one, or none at all.
  //
  // `QUOTE_CHANGED` and `IDEMPOTENCY_KEY_CONFLICT` are both 409, and the BFF
  // falls back to QUOTE_CHANGED for *any* untyped 409. So the key conflict
  // did not go missing; it arrived wearing the other one's name and told the
  // buyer to refresh a quote that was never the problem, while the retry key
  // that actually blocked them stayed bound to someone else's renewal.
  //
  // `PROVIDER_CHECKOUT_CREATION_UNRESOLVED` is worse, because it is 503: no
  // fallback catches it, the BFF finds no contract and reports a generic
  // "failed to create renewal checkout". The one thing that warning exists to
  // say — the payment may already exist at the provider, check before
  // retrying — never reached the buyer at all, and a blind retry can charge
  // them twice. The filter reads the code independently of status, so 503
  // carries it exactly as 401 and 409 do; the allowlist was the only gate.
  'QUOTE_CHANGED',
  'IDEMPOTENCY_KEY_CONFLICT',
  'PROVIDER_CHECKOUT_CREATION_UNRESOLVED',
  // The panel's own second-factor pivot, and the only entry here that is not
  // SCREAMING_SNAKE: the label is the wire value the sign-in form compares
  // against, so it is spelled the way the client reads it, not the way the
  // neighbours are spelled. Do not 'tidy' the case.
  //
  // Without it the filter strips the code from the 401 the login endpoint
  // returns when 2FA is on and no code was supplied. The form then never
  // reaches its second step, and every operator who enabled 2FA is locked
  // out of the panel with no way in.
  'totp_required',
  // The same lesson as `totp_required` above, on the path nobody re-read it
  // for. Enrolling a passkey now demands a factor the bearer token does not
  // carry, and the refusal is a 401 — the one status the SPA's axios
  // interceptor also spends on "your session is over". Stripped of its code
  // the two are indistinguishable on the wire, so the operator who opens the
  // enrol dialog is thrown out of a session that was never invalid, and the
  // hardening reads as a bug rather than a prompt.
  //
  // Spelled lowercase for the same reason as its neighbour: the label IS the
  // wire value the SPA compares against. Do not 'tidy' the case.
  'passkey_reauth_required',
  // The same 401, on the enrolment half, and it was MISSING here while sitting
  // in `CODES_CARRYING_REAUTH_FACTOR` below — which is not a smaller version of
  // the same bug, it is the whole bug. `findSafeProductPayload` gates on THIS
  // set and returns `undefined` on a miss, and `extractSafeReauthFactor` takes
  // that payload as its argument. So the missing entry stripped the code AND
  // the factor: `two-factor.service.ts` threw `totp_enroll_reauth_required` +
  // `factor: 'password'`, the wire carried an untyped 401, and
  // `two-factor-page.tsx`'s `readDemandedFactor` found nothing, never raised
  // the password prompt, and NOBODY COULD SWITCH 2FA ON AT ALL.
  //
  // It shipped green because `two-factor-enrollment-reauth.spec.ts` asserts on
  // the thrown exception's own body, which never passes through this filter.
  // The regression test now lives beside this file's spec, at the boundary
  // where the loss actually happened.
  'totp_enroll_reauth_required',
  // EVERY OPERATOR-FACING REFUSAL ON THE PLAN WRITE PATHS, from
  // `plans-admin.validators.ts`. They are here because the panel SPA has to
  // TRANSLATE them and the server cannot: it has no idea which language the
  // operator reads, so it keeps writing English diagnostics and lets the
  // client own the wording.
  //
  // Stripped of the code each of these is an untyped 400, and the only thing
  // the SPA can do with an untyped 400 is print `data.message`. That is how a
  // Russian-language panel answered a plan save with the English sentence
  // 'Replacement and upgrade plans must be active non-trial public plans:
  // cmsxo98e8006r01jgn33gtpbe' — raw cuid included, in the middle of an
  // otherwise translated screen. The sentence stays on the wire beside the
  // code, as the fallback for an older SPA mid-rolling-deploy and for a code a
  // build does not recognise yet.
  //
  // `PLAN_SQUAD_VALIDATION_UNAVAILABLE` is the entry that loses most by being
  // stripped, and the reason it is not folded into its neighbours: it is a 503
  // meaning "we could not ask the panel", not a 400 meaning "this is wrong".
  // Nothing the operator typed is known to be invalid and the next action is to
  // retry once the panel answers — the opposite of what the two squad
  // NOT_FOUND refusals ask for, and indistinguishable from them without a code.
  //
  // Restated as literals rather than imported from
  // `plan-write-refusal-codes.ts`: an allowlist that imports the set it gates
  // admits every future member automatically, which is not an allowlist.
  // `plan-write-refusal-codes.spec.ts` checks the correspondence by name, so a
  // code added there and forgotten here fails a test instead of reaching
  // production with the code silently removed.
  'PLAN_NAME_TAKEN',
  'PLAN_DURATION_DUPLICATE',
  'PLAN_CURRENCY_DUPLICATE',
  'PLAN_TRANSITION_SELF_REFERENCE',
  'PLAN_TRANSITION_REPLACEMENT_REQUIRED',
  'PLAN_TRANSITION_RENEW_MODE_NOT_ARCHIVED',
  'PLAN_TRANSITION_TARGET_NOT_FOUND',
  'PLAN_TRANSITION_TARGET_NOT_ASSIGNABLE',
  'PLAN_TRIAL_CONVERSION_FORBIDDEN',
  'PLAN_TRIAL_ALREADY_EXISTS',
  'PLAN_TRIAL_DURATION_COUNT',
  'PLAN_TRIAL_PRICE_REQUIRED',
  'PLAN_ALLOWED_USERS_NOT_FOUND',
  'PLAN_INTERNAL_SQUADS_NOT_FOUND',
  'PLAN_EXTERNAL_SQUAD_NOT_FOUND',
  'PLAN_SQUAD_VALIDATION_UNAVAILABLE',
  'PLAN_DELETE_REFERENCED',
  // The per-user invite quota, refused at the one place a `ReferralInvite` row
  // is written (`ReferralsService.createInvite`). Here for the same reason as
  // the `PLAN_*` block above: the panel has to TRANSLATE the refusal and the
  // server cannot, so it keeps writing an English diagnostic and lets the
  // client own the wording.
  //
  // What makes it worth a code rather than the bare sentence is that the two
  // AUDIENCES want opposite advice. The subscriber path
  // (`ReferralInviteLimitsService.validateCanCreateInvite`, reached through the
  // bot) says "earn more by qualifying referrals", which is the only thing a
  // subscriber can do. An OPERATOR holding an admin token can simply raise the
  // limit on the Invites tab, and telling them to go earn referrals sends them
  // to a screen that is not theirs. Stripped of the code the panel can only
  // print whichever sentence arrived, in whatever language it was written in.
  //
  // Spelled exactly as the label already embedded in the limits service's own
  // message, so one refusal has one name; see
  // `INVITE_SLOT_LIMIT_REACHED_CODE` in `referrals.service.ts`, whose spec
  // asserts this entry by name.
  'INVITE_SLOT_LIMIT_REACHED',
  // The one 409 on `POST /admin/push/subscribe` that is NOT a refusal of the
  // caller. Here for the same reason as the three stale-panel-link codes above:
  // the route answers 409 for two opposite reasons and a client has to BRANCH
  // on which.
  //
  // Without the code the SPA can only read the lasting one — another admin owns
  // this browser's endpoint — because that is the only one it can name. So a
  // transient race in which the blocking row was deleted mid-request told the
  // operator their own browser was registered to another administrator, left
  // the push toggle off, and hid the one fact that mattered: pressing it again
  // would have worked. `subscribeAdmin` now retries that case itself, bounded,
  // and only a budget spent entirely on it reaches this code — at which point
  // "try again" is still the correct advice and "go find the administrator who
  // holds your browser" is still a dead end.
  //
  // Restated as a literal rather than imported from `WebPushService`, for the
  // reason stated on the `PLAN_*` block: an allowlist that imports the set it
  // gates admits every future member automatically, which is not an allowlist.
  // `admin-push-subscribe-endpoint-race.spec.ts` checks the correspondence by
  // name.
  'PUSH_SUBSCRIBE_ENDPOINT_RACE_UNSETTLED',
]);
/**
 * Codes whose refusal is meaningless without naming the credential it wants.
 * Kept as a set of its own rather than a flag on `SAFE_PRODUCT_CODES` so that
 * adding a product code never silently opens a second field: a code has to
 * appear in BOTH places before any `factor` leaves this filter.
 *
 * Without the passthrough, `passkey_reauth_required` tells the SPA only that
 * something more is wanted. Which factor is not the client's to guess — the
 * server picks it from the ACCOUNT (a TOTP or recovery code when 2FA is on,
 * the current password when it is not) precisely so a hijacked session cannot
 * nominate the weaker one. A client left guessing gets it wrong exactly when
 * its cached 2FA state is stale, which is the only way this refusal is reached
 * at all, and then re-prompts for the same wrong field forever.
 *
 * THE RULE IS "BOTH SETS", AND IT IS A SUBSET RULE, NOT A PAIRING RULE. This
 * set is strictly contained in {@link SAFE_PRODUCT_CODES}: a code listed only
 * here forwards NEITHER field, because `extractSafeReauthFactor` is fed the
 * payload `findSafeProductPayload` returns and that function gates on the
 * product allowlist. `totp_enroll_reauth_required` sat here alone and 2FA could
 * not be turned on. Exported so `admin-safe-exception.filter.spec.ts` enforces
 * the containment by name rather than leaving it to whoever edits next.
 */
export const CODES_CARRYING_REAUTH_FACTOR: ReadonlySet<string> = new Set<string>([
  'passkey_reauth_required',
  // Beginning a TOTP enrolment now demands the current password, for the same
  // reason passkey enrolment does: both mint a credential that outlives the
  // session asking for it. Without the code AND the factor on the wire the SPA
  // gets an untyped 401, cannot raise the prompt, and the operator simply
  // cannot turn 2FA on.
  'totp_enroll_reauth_required',
]);
/**
 * And the values that field may hold. The point of a second allowlist on the
 * value is that the filter still never forwards anything an exception body
 * chose: `factor` is not copied, it is matched against these two and the match
 * is what gets written. An exception carrying `factor: <anything else>` — a
 * path, an id, a stack fragment — leaves nothing behind.
 */
const SAFE_REAUTH_FACTORS = new Set<string>(['totp', 'password'] satisfies SafeReauthFactor[]);
/**
 * Sentences the panel wrote on purpose, and is therefore allowed to say out
 * loud. Matched on EXACT equality against the whole string.
 *
 * The pattern list below exists because exception text is untrusted: a driver
 * error carries the connection string it failed to open, a provider client
 * carries the bearer token it sent. It cannot tell those apart from a sentence
 * a person sat down and wrote for an operator to read, so it scrubbed both --
 * and the sign-in form, whose own refusal is the four words "Invalid login or
 * password", answered a mistyped password with "Request failed". A panel that
 * cannot say "wrong password" reads as unfinished to everyone who installs it.
 *
 * This is the SAME mechanism as `SAFE_PRODUCT_CODES` above, applied to the
 * message channel instead of the code channel -- a short hand-audited list of
 * literals that a body must equal exactly before anything of it survives --
 * and deliberately not a second, looser idea:
 *
 *   - Equality is on the ENTIRE string. Not `startsWith`, not `includes`, not
 *     a trimmed or case-folded form. A message that merely CONTAINS one of
 *     these -- 'Invalid login or password: postgres://admin:pw@db/rezeis' is
 *     the shape a careless `${err}` interpolation produces -- differs from the
 *     entry and meets the unchanged pattern scrub exactly as before.
 *   - Nothing here is interpolated. Every entry is a fixed literal that some
 *     throw site passes verbatim, so there is no position in it where a value
 *     from the environment, the request, or a caught error can appear.
 *   - It gates `message` only. Error LABELS still go through the patterns
 *     untouched (`sanitizeHttpExceptionError`), because that field carries
 *     Nest's status word, never product copy.
 *
 * The alternative was to give these two throw sites an allowlisted `code` the
 * way `totp_required` has one and let the client own the wording. That is the
 * better shape where the client must BRANCH on the refusal; here it does not
 * -- it prints one sentence -- and the code would have to be recognised from
 * the message anyway, since the throw sites are shared by four modules. This
 * costs one allowlist instead of an allowlist plus a wire field.
 *
 * Adding an entry is a claim that the string is a constant somebody wrote for
 * an operator's eyes. Exported so `safe-exception-product-messages.spec.ts`
 * can re-check that claim mechanically: no entry may itself trip a sensitive
 * pattern, and none may carry an interpolation marker.
 */
export const SAFE_PRODUCT_MESSAGES: ReadonlySet<string> = new Set<string>([
  // The sign-in form's own refusal, and the reason this list exists. It is
  // deliberately the SAME sentence for a login that does not exist and for a
  // password that is wrong -- telling those two apart is an enumeration oracle
  // -- so releasing it hands the operator the reason without handing an
  // attacker anything the 401 did not already give them.
  'Invalid login or password',
  // A session cut short by a password change or a revoked passkey: the token
  // is well formed and correctly signed, and its version no longer matches the
  // account. "Request failed" gives the operator nothing to do; the real
  // sentence tells them to sign in again. The word "token" is the only reason
  // it was ever scrubbed -- the sentence names no token and carries none.
  'Admin token is no longer valid',
]);
const SENSITIVE_HTTP_TEXT_PATTERNS = [
  /\b(?:postgres|mysql|mongodb|redis|amqp|http|https):\/\/\S+/iu,
  /\b(?:auth|authorization|bearer|cookie|credential|password|profile|secret|token)\b/iu,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/u,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/iu,
  /\b[0-9a-f]{24,}\b/iu,
  /\b(?:acct|cus|evt|gw|in|pay|pi|pm|price|prod|re|rfnd|seti|si|sub|txn|wh)_[A-Za-z0-9][A-Za-z0-9_-]{3,}\b/iu,
];

/**
 * Keeps HTTP error responses predictable without exposing unexpected exception internals.
 *
 * Intentional HttpExceptions keep their status/message for compatibility with existing API
 * contracts. Unexpected exceptions are reduced to a stable generic 500 response. The filter
 * never includes stack traces, raw query strings, request/response bodies, or headers.
 */
@Catch()
export class AdminSafeExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(AdminSafeExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<Request>();
    const responseBody = this.buildResponseBody(exception, request);

    if (exception instanceof HttpException) {
      this.logger.warn(
        [
          `requestId=${responseBody.requestId ?? 'unknown'}`,
          `status=${responseBody.statusCode}`,
          `path=${responseBody.path}`,
          `errorCode=${responseBody.errorCode}`,
        ].join(' '),
      );
    } else {
      this.logger.error(
        [
          `requestId=${responseBody.requestId ?? 'unknown'}`,
          `status=${responseBody.statusCode}`,
          `path=${responseBody.path}`,
          `errorCode=${responseBody.errorCode}`,
        ].join(' '),
      );
      // Phase E2E: surface the underlying exception name + message + the
      // first few stack frames so server logs aren't a black hole on 500s.
      // We deliberately log to stdout (not into the safe response body)
      // so CI-style aggregation picks it up while clients still see a
      // generic 500.
      const err = exception as { name?: string; message?: string; stack?: string };
      const stackPreview = (err.stack ?? '')
        .split('\n')
        .slice(0, 6)
        .join(' | ');
      this.logger.error(
        `unhandled: ${err?.name ?? 'unknown'}: ${err?.message ?? '(no message)'} :: ${stackPreview}`,
      );
    }

    response.status(responseBody.statusCode).json(responseBody);
  }

  private buildResponseBody(exception: unknown, request: Request): SafeErrorResponse {
    const requestId = resolveResponseRequestId(request.headers['x-request-id']);
    const path = sanitizePath(request.originalUrl ?? request.url);
    const timestamp = new Date().toISOString();

    if (exception instanceof HttpException) {
      const statusCode = exception.getStatus();
      const response = exception.getResponse();
      const message = extractHttpExceptionMessage(response, exception.message, statusCode);
      const error = extractHttpExceptionError(response, statusCode);
      const payload = findSafeProductPayload(response);
      const productCode = payload?.code;
      const factor = extractSafeReauthFactor(payload);
      return {
        timestamp,
        path,
        requestId,
        statusCode,
        message,
        // Prefer the stable product code for BFF branching when present;
        // otherwise keep the generic status-derived code.
        errorCode: productCode ?? mapStatusToErrorCode(statusCode),
        ...(productCode ? { code: productCode } : {}),
        ...(factor ? { factor } : {}),
        ...(error ? { error } : {}),
      };
    }

    return {
      timestamp,
      path,
      requestId,
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: GENERIC_INTERNAL_ERROR_MESSAGE,
      errorCode: GENERIC_INTERNAL_ERROR_CODE,
      error: 'Internal Server Error',
    };
  }
}

function extractHttpExceptionMessage(response: string | object, fallback: string, statusCode: number): string | string[] {
  if (typeof response === 'string') {
    return sanitizeHttpExceptionMessage(response, statusCode);
  }
  if (isRecord(response) && 'message' in response) {
    const message = response.message;
    if (typeof message === 'string') {
      return sanitizeHttpExceptionMessage(message, statusCode);
    }
    if (Array.isArray(message)) {
      const sanitizedMessages = message
        .filter((item): item is string => typeof item === 'string')
        .map((item) => sanitizeHttpExceptionMessage(item, statusCode));
      return sanitizedMessages.length > 0 ? sanitizedMessages : safeHttpMessageForStatus(statusCode);
    }
  }
  return sanitizeHttpExceptionMessage(fallback, statusCode);
}

function extractHttpExceptionError(response: string | object, statusCode: number): string | undefined {
  if (isRecord(response) && typeof response.error === 'string') {
    return sanitizeHttpExceptionError(response.error, statusCode);
  }
  return undefined;
}

/**
 * Locate the intentional part of an HttpException body: the record carrying an
 * allowlisted product `code`. Nested Nest shape `{ message: { code, ... } }` is
 * also accepted.
 *
 * Returns the record rather than just the code so that every other allowlisted
 * field is read off the SAME object. Re-walking the body per field would let a
 * response pair a code taken from one level with a `factor` taken from the
 * other — a shape no thrower produces, and therefore one nobody would notice
 * being assembled here.
 */
function findSafeProductPayload(
  response: string | object,
): { readonly code: string; readonly body: Record<string, unknown> } | undefined {
  if (!isRecord(response)) return undefined;
  const direct = response.code;
  if (typeof direct === 'string' && SAFE_PRODUCT_CODES.has(direct)) {
    return { code: direct, body: response };
  }
  const nested = response.message;
  if (isRecord(nested) && typeof nested.code === 'string' && SAFE_PRODUCT_CODES.has(nested.code)) {
    return { code: nested.code, body: nested };
  }
  return undefined;
}

/**
 * The `factor` passthrough, gated twice: the code must be one that declares it
 * carries a factor, and the value must be one of the two literals. Anything
 * else — including a `factor` riding along on a product code that has no
 * business having one — is dropped exactly as before.
 */
function extractSafeReauthFactor(
  payload: { readonly code: string; readonly body: Record<string, unknown> } | undefined,
): SafeReauthFactor | undefined {
  if (!payload || !CODES_CARRYING_REAUTH_FACTOR.has(payload.code)) return undefined;
  const candidate = payload.body.factor;
  return typeof candidate === 'string' && SAFE_REAUTH_FACTORS.has(candidate)
    ? (candidate as SafeReauthFactor)
    : undefined;
}

function sanitizeHttpExceptionMessage(message: string, statusCode: number): string {
  // Exact, whole-string membership -- see `SAFE_PRODUCT_MESSAGES`. Anything
  // that is not byte for byte one of those literals is untrusted exception
  // text and meets the unchanged pattern scrub on the next line.
  if (SAFE_PRODUCT_MESSAGES.has(message)) {
    return message;
  }
  return containsSensitiveHttpText(message) ? safeHttpMessageForStatus(statusCode) : message;
}

function sanitizeHttpExceptionError(error: string, statusCode: number): string {
  return containsSensitiveHttpText(error) ? safeHttpErrorForStatus(statusCode) : error;
}

function containsSensitiveHttpText(value: string): boolean {
  return SENSITIVE_HTTP_TEXT_PATTERNS.some((pattern) => pattern.test(value));
}

function safeHttpMessageForStatus(statusCode: number): string {
  if (statusCode >= 500) {
    return GENERIC_INTERNAL_ERROR_MESSAGE;
  }
  return 'Request failed';
}

function safeHttpErrorForStatus(statusCode: number): string {
  switch (statusCode) {
    case HttpStatus.BAD_REQUEST:
      return 'Bad Request';
    case HttpStatus.UNAUTHORIZED:
      return 'Unauthorized';
    case HttpStatus.FORBIDDEN:
      return 'Forbidden';
    case HttpStatus.NOT_FOUND:
      return 'Not Found';
    case HttpStatus.CONFLICT:
      return 'Conflict';
    case HttpStatus.TOO_MANY_REQUESTS:
      return 'Too Many Requests';
    default:
      return statusCode >= 500 ? 'Internal Server Error' : 'Error';
  }
}

function mapStatusToErrorCode(statusCode: number): string {
  switch (statusCode) {
    case HttpStatus.BAD_REQUEST:
      return 'BAD_REQUEST';
    case HttpStatus.UNAUTHORIZED:
      return 'UNAUTHORIZED';
    case HttpStatus.FORBIDDEN:
      return 'FORBIDDEN';
    case HttpStatus.NOT_FOUND:
      return 'NOT_FOUND';
    case HttpStatus.CONFLICT:
      return 'CONFLICT';
    case HttpStatus.TOO_MANY_REQUESTS:
      return 'TOO_MANY_REQUESTS';
    default:
      if (statusCode >= 500) {
        return GENERIC_INTERNAL_ERROR_CODE;
      }
      return `HTTP_${statusCode}`;
  }
}

function resolveResponseRequestId(headerValue: string | string[] | undefined): string | null {
  const candidate = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  return isSafeRequestId(candidate) ? candidate : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
