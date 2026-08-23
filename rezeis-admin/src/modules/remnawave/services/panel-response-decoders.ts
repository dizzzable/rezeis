/**
 * Tolerant decoders for the three panel reads that used to execute the vendor's
 * own zod schemas: `GET /api/internal-squads/`, `GET /api/external-squads/` and
 * `GET /api/auth/status`.
 *
 * WHY THEY EXIST — a live defect, not a tidy-up. `remnawave-api.service.ts`
 * imported `GetExternalSquadsCommand` from `@remnawave/backend-contract@2.7.3`
 * and `safeParse`d live panel responses with it. That schema declares
 * `responseHeaders` REQUIRED on every external-squad row. Panel 3.x renamed the
 * field: 3.3.2 declares `responseHeadersAdd` + `responseHeadersRemove` and no
 * `responseHeaders` at all. So on any 3.x panel the parse failed
 * DETERMINISTICALLY and `getExternalSquadOptions()` threw
 * `ServiceUnavailableException` — every time the panel had at least one
 * external squad. An EMPTY list passed trivially, which is why the outage read
 * as intermittent to operators: it appeared the moment the first squad was
 * created.
 *
 * The asymmetry that pointed at the fix was already in the file:
 * `getExternalSquadDetails()` reads the SAME endpoint and never broke, because
 * it decodes through our own tolerant `mapExternalSquadDetails` instead of the
 * vendor schema. These decoders extend that shape to the option and status
 * reads, which need `{ uuid, name }` and a handful of booleans respectively —
 * nothing that any panel era has ever spelled differently.
 *
 * BOTH ERAS BY CONSTRUCTION. rezeis ships to installations still on 2.x panels
 * and to installations on 3.x, upgrading on their own schedule. These decoders
 * read only fields present and identically spelled in every era, so there is
 * nothing here to narrow. The renamed field is simply never consulted. Pinned
 * per era, against fixtures derived mechanically from the vendor's own OpenAPI
 * documents, by `test/remnawave-squad-status-era-decode.spec.ts`.
 *
 * TOLERANT IS NOT CREDULOUS — the rule this module exists to enforce. Two
 * outcomes wear the same clothes and must never be collapsed:
 *
 *   • a well-formed response carrying an EMPTY list — an answer. Returns empty.
 *   • a response that could NOT BE READ — not an answer. Returns a failure the
 *     caller must handle, never an empty list.
 *
 * Collapsing them is this repository's recurring defect, and the caller that
 * would be misled is concrete: `PlansAdminValidators.assertSquadsAreValid`
 * catches a throw as "the panel could not be asked" and refuses the write, but
 * reads `[]` as "the panel serves no such squad" and answers the operator
 * `External squad not found: <uuid>` — a confident wrong answer about a squad
 * that exists. Hence: unreadable → `{ ok: false }`; empty → `{ ok: true, [] }`.
 */
import { RemnawaveSquadOptionInterface } from '../interfaces/remnawave-squad-option.interface';
import { RemnawaveStatusInterface } from '../interfaces/remnawave-status.interface';

/**
 * The outcome of one tolerant decode.
 *
 * A discriminated union rather than `T | null`, because `null` is exactly the
 * conflation this module refuses: the caller has to be able to tell "read it,
 * it was empty" from "could not read it", and a nullable return gives both the
 * same shape. `reason` is for the operator log — it is never shown to an admin
 * user, whose message stays the unchanged "… are unavailable".
 */
export type PanelReadResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

/** Which list a squad payload is expected to carry. Spelled identically in every era. */
export type PanelSquadListKey = 'internalSquads' | 'externalSquads';

/** The part of {@link RemnawaveStatusInterface} the panel actually answers. */
export interface PanelAuthStatus {
  readonly isLoginAllowed: boolean;
  readonly isRegisterAllowed: boolean;
  readonly authentication: RemnawaveStatusInterface['authentication'];
  readonly branding: RemnawaveStatusInterface['branding'];
}

/**
 * Decodes `GET /api/internal-squads/` or `GET /api/external-squads/` down to the
 * `{ uuid, name }` pairs the plan selectors need.
 *
 * WHAT COUNTS AS UNREADABLE, and why each line of it is drawn where it is:
 *
 *   • the payload, or its `response`, is not an object — we are not looking at
 *     a squad list at all (a proxy error page, an HTML login redirect, `null`).
 *   • `response.<list>` is not an array — same.
 *   • the array is EMPTY and the panel did not also say `total: 0`. Zero rows
 *     tell us nothing by themselves; the panel has to confirm it has none. This
 *     is the same rule `strictGetAllPanelUsers` already applies to the user
 *     list ("`[]` is believed only when the panel itself says `total: 0`"), and
 *     it is not a tightening: the vendor schema this replaces declared `total`
 *     required, so an empty list without a readable count failed there too.
 *   • ANY row cannot be keyed. Dropping it would silently shorten a list the
 *     caller treats as the panel's complete answer — a squad missing from the
 *     selector is an operator assigning subscribers to the wrong squad, with
 *     nothing anywhere saying so. Refusing the whole read is the outcome that
 *     reaches somebody.
 *
 * WHAT IS DELIBERATELY TOLERATED:
 *
 *   • every field beyond `uuid` and `name`, in either spelling, whether the
 *     panel adds, renames or drops it. That is the whole defect above.
 *   • a non-empty list with an absent or unreadable `total`. Rows arrived and
 *     decoded; making the read hinge on a counter we do not use would turn one
 *     cosmetic wire difference into an outage. (Same reasoning, and the same
 *     wording, as the defensive `total` reads elsewhere in the adapter.)
 *   • a row with a usable `uuid` but no usable `name`. The name is a LABEL, not
 *     an identity: refusing the whole panel read over a cosmetic field trades a
 *     silent defect for a loud one, which is not an improvement. It falls back
 *     to the row's own uuid — never `undefined` and never the empty string,
 *     both of which render as a blank, unidentifiable, still-selectable option
 *     in the admin dropdown.
 */
export function decodeSquadOptionList(
  payload: unknown,
  listKey: PanelSquadListKey,
): PanelReadResult<readonly RemnawaveSquadOptionInterface[]> {
  const root = asObject(payload);
  if (root === null) {
    return unreadable(`the ${listKey} payload is ${describe(payload)}, not an object`);
  }
  const envelope = asObject(root.response);
  if (envelope === null) {
    return unreadable(
      `the ${listKey} payload carries no \`response\` object (\`response\` is ${describe(root.response)})`,
    );
  }
  const rows = envelope[listKey];
  if (!Array.isArray(rows)) {
    return unreadable(`\`response.${listKey}\` is ${describe(rows)}, not an array`);
  }
  if (rows.length === 0) {
    const total = envelope.total;
    if (typeof total === 'number' && Number.isFinite(total) && total === 0) {
      return { ok: true, value: [] };
    }
    return unreadable(
      `\`response.${listKey}\` is empty while \`total\` is ${describe(total)} — ` +
        'the panel did not confirm it has none',
    );
  }
  const options: RemnawaveSquadOptionInterface[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = asObject(rows[index]);
    if (row === null) {
      return unreadable(`\`response.${listKey}[${index}]\` is ${describe(rows[index])}, not an object`);
    }
    const uuid = row.uuid;
    if (typeof uuid !== 'string' || uuid.length === 0) {
      return unreadable(
        `\`response.${listKey}[${index}]\` carries no usable \`uuid\` (it is ${describe(uuid)}); ` +
          'refusing to hand back a list one squad short',
      );
    }
    const name = row.name;
    options.push({
      uuid,
      name: typeof name === 'string' && name.trim().length > 0 ? name : uuid,
    });
  }
  return { ok: true, value: options };
}

/**
 * Decodes `GET /api/auth/status`.
 *
 * `isLoginAllowed` and `isRegisterAllowed` are the two questions this endpoint
 * is asked, so they must be READ, not guessed: defaulting an unreadable one to
 * `false` would tell an operator "the panel has login switched off" when the
 * truth is "we could not tell", and the admin SPA renders that as fact. Both
 * are booleans in every era; anything else fails the read.
 *
 * `authentication` and `branding` decorate a login screen. Absent or explicitly
 * `null` means the panel published no such block — a legitimate answer both
 * eras declare — and produces `null`. Present-but-not-an-object is a shape we
 * did not understand and fails the read. Inside a present block, individual
 * sub-fields degrade quietly: a provider map entry that is not a boolean is
 * dropped rather than failing the whole status read, since a future panel
 * adding a richer provider descriptor must not take the login screen down.
 */
export function decodePanelAuthStatus(payload: unknown): PanelReadResult<PanelAuthStatus> {
  const root = asObject(payload);
  if (root === null) {
    return unreadable(`the auth-status payload is ${describe(payload)}, not an object`);
  }
  const response = asObject(root.response);
  if (response === null) {
    return unreadable(
      `the auth-status payload carries no \`response\` object (\`response\` is ${describe(root.response)})`,
    );
  }
  const isLoginAllowed = response.isLoginAllowed;
  if (typeof isLoginAllowed !== 'boolean') {
    return unreadable(`\`response.isLoginAllowed\` is ${describe(isLoginAllowed)}, not a boolean`);
  }
  const isRegisterAllowed = response.isRegisterAllowed;
  if (typeof isRegisterAllowed !== 'boolean') {
    return unreadable(
      `\`response.isRegisterAllowed\` is ${describe(isRegisterAllowed)}, not a boolean`,
    );
  }
  const authentication = decodeAuthentication(response.authentication);
  if (!authentication.ok) return authentication;
  const branding = decodeBranding(response.branding);
  if (!branding.ok) return branding;
  return {
    ok: true,
    value: {
      isLoginAllowed,
      isRegisterAllowed,
      authentication: authentication.value,
      branding: branding.value,
    },
  };
}

function decodeAuthentication(
  raw: unknown,
): PanelReadResult<RemnawaveStatusInterface['authentication']> {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  const authentication = asObject(raw);
  if (authentication === null) {
    return unreadable(
      `\`response.authentication\` is ${describe(raw)}, neither an object nor null`,
    );
  }
  const password = asObject(authentication.password);
  const passkey = asObject(authentication.passkey);
  const oauth2 = asObject(authentication.oauth2);
  const providers = oauth2 === null ? null : asObject(oauth2.providers);
  const oauth2Providers: Record<string, boolean> = {};
  if (providers !== null) {
    for (const [provider, enabled] of Object.entries(providers)) {
      if (typeof enabled === 'boolean') oauth2Providers[provider] = enabled;
    }
  }
  return {
    ok: true,
    value: {
      passwordEnabled: password !== null && password.enabled === true,
      passkeyEnabled: passkey !== null && passkey.enabled === true,
      oauth2Providers,
    },
  };
}

function decodeBranding(raw: unknown): PanelReadResult<RemnawaveStatusInterface['branding']> {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  const branding = asObject(raw);
  if (branding === null) {
    return unreadable(`\`response.branding\` is ${describe(raw)}, neither an object nor null`);
  }
  return {
    ok: true,
    value: {
      title: typeof branding.title === 'string' ? branding.title : null,
      logoUrl: typeof branding.logoUrl === 'string' ? branding.logoUrl : null,
    },
  };
}

/**
 * A plain JSON object, or `null` for anything else.
 *
 * Arrays are rejected on purpose: `typeof [] === 'object'` and every property
 * read off one yields `undefined`, so an array reaching an envelope decoder
 * would present as "an object whose every field is missing" — the exact
 * misreading that turns an unreadable payload into a confident empty answer.
 */
function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Short, log-safe description of an unexpected value.
 *
 * Numbers and booleans print BY VALUE — `total: 5` next to an empty list is the
 * whole diagnosis and "a number" would throw it away. Strings and objects print
 * only their type, because their contents are panel data (names, urls, header
 * values) and this string goes to the operator log.
 */
function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'absent';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `an array of ${value.length}`;
  return `a ${typeof value}`;
}

function unreadable(reason: string): { readonly ok: false; readonly reason: string } {
  return { ok: false, reason };
}
