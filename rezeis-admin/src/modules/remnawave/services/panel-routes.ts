/**
 * Every panel route rezeis builds, in one place, for both eras.
 *
 * WHY THIS FILE EXISTS RATHER THAN INLINE TEMPLATE STRINGS: the 2.x and 3.x
 * paths differ only in the identifier they carry, so inline templates put the
 * version decision at seventeen call sites instead of one. Collecting them also
 * makes them checkable — `test/remnawave-3x-contract-guard.spec.ts` asserts every
 * USER-SCOPED builder below against the URL builders of every contract the
 * fleet's panel releases ship, and the whole-panel constants at the top of the
 * table are pinned the same way by `test/remnawave-squad-status-era-decode.spec.ts`.
 * A path that drifts in a future panel release fails a test here instead of
 * failing silently against a live panel.
 *
 * THIS TABLE SERVES `remnawave-api.service.ts`. The three contract-driven
 * clients (`panel-users`, `panel-devices`, `panel-infra`) take their routes from
 * the hand-owned command table in `panel-commands.ts`, which
 * `test/panel-command-conformance.spec.ts` holds to every era the same way.
 *
 * WHY NO VENDOR PACKAGE IS IMPORTED HERE — OR ANYWHERE IN `src/`. This spot has
 * held a claim about the vendor packages several times, and each time the claim
 * drifted out of true while nobody was reading it. So the claim is now a TEST:
 * `test/panel-command-conformance.spec.ts` fails if any file under `src/` imports
 * `@remnawave/*` (by value, by type, dynamically or by `require`), if
 * `package.json` lists one outside `devDependencies`, or if `npm ls --omit=dev`
 * finds one. The contracts are devDependency ORACLES, one per panel release
 * family, named by the panel release and pinned exactly to the contract that
 * release ships (https://docs.rw/sdk/typescript-sdk/) — `@remnawave/contract-panel-2.7`
 * through `@remnawave/contract-panel-3.4.4`. `Dockerfile` stage 1 runs
 * `npm ci --omit=dev`, so none of them, and none of their AGPL-3.0-only
 * licences, reaches the image. Holding a route to the vendor at BUILD time is
 * the whole benefit; executing vendor schemas at RUN time never was one.
 *
 * WHAT EXECUTING THEM AT RUNTIME ACTUALLY COST, since "we could just parse with
 * the official schema" is a reasonable-sounding idea and will be proposed again:
 * `remnawave-api.service.ts` used to `safeParse` external-squad responses with
 * 2.7.3's `GetExternalSquadsCommand`, which requires a `responseHeaders` field
 * that panel 3.x renamed. Every 3.x install with at least one external squad
 * got `ServiceUnavailableException` from a perfectly healthy panel. A vendor
 * schema describes ONE era; this codebase serves every era its operators are
 * still running. See `panel-response-decoders.ts`.
 *
 * The reason THIS file imports nothing is unchanged and still good: its response
 * parsing is deliberately more tolerant than the published contract (see
 * `mapSubscriptionSettings` and the defensive `total` reads), so executing
 * vendor schemas here would turn cosmetic panel drift into an outage.
 *
 * `segment` is always the already-resolved identifier — a 2.x UUID or a 3.x
 * numeric id in decimal — produced by `panelUserAddress`. These builders do not
 * decide which one it is; that is not their job and a route file that guessed
 * would be the second place a version decision lived.
 */

/** `encodeURIComponent`, but a plain numeric id is left alone for readability. */
function seg(value: string): string {
  return /^\d+$/.test(value) ? value : encodeURIComponent(value);
}

export const PANEL_ROUTES = {
  // ── Whole-panel reads ────────────────────────────────────────────────────
  // Constants, not builders, and byte-identical in every contract a panel
  // release ships, 2.7.2 through 3.4.15 — pinned against all seven in
  // `test/remnawave-squad-status-era-decode.spec.ts`. They came off
  // `GetStatusCommand.url` / `GetInternalSquadsCommand.url` /
  // `GetExternalSquadsCommand.url` when those imports left the runtime.
  //
  // THE TRAILING SLASHES ARE THE VENDOR'S, not a typo and not decoration: the
  // squad commands publish `/api/internal-squads/` and `/api/external-squads/`
  // with it, and that is the path rezeis has always sent. Do not "tidy" it.

  /** `GET` — whether the panel accepts logins, plus its login-screen branding. */
  authStatus: '/api/auth/status',

  /** `GET` — every internal squad. */
  internalSquads: '/api/internal-squads/',

  /** `GET` — every external squad. */
  externalSquads: '/api/external-squads/',

  // ── User-scoped ──────────────────────────────────────────────────────────

  /** `GET` one profile. 2.x: by uuid. 3.x: by numeric id. Same shape either way. */
  user: (segment: string): string => `/api/users/${seg(segment)}`,

  /** `DELETE` one profile. 3.x answers `204` with an empty body. */
  deleteUser: (segment: string): string => `/api/users/${seg(segment)}`,

  /** `POST` — zero the traffic counter. */
  resetUserTraffic: (segment: string): string => `/api/users/${seg(segment)}/actions/reset-traffic`,

  /** `POST` — rotate the subscription link. */
  revokeUserSubscription: (segment: string): string => `/api/users/${seg(segment)}/actions/revoke`,

  /** `GET` — the profile's request log. */
  userSubscriptionRequestHistory: (segment: string): string =>
    `/api/users/${seg(segment)}/subscription-request-history`,

  /** `GET` — devices registered to one profile. */
  userHwidDevices: (segment: string): string => `/api/hwid/devices/${seg(segment)}`,

  /** `POST` — drop one device. Owner goes in the BODY, keyed per version. */
  deleteHwidDevice: '/api/hwid/devices/delete',

  /** `POST` — drop every device. Owner goes in the BODY, keyed per version. */
  deleteAllHwidDevices: '/api/hwid/devices/delete-all',

  /** `GET`/`POST` — the whole-panel user list and the profile write. */
  users: '/api/users',

  /**
   * `POST` — push one reusable snippet into all config profiles that reference it.
   * No caller today, and not served by panel 3.2.0–3.2.1: contract 3.2.0 has no
   * such command (measured in `remnawave-3x-contract-guard.spec.ts`).
   */
  snippetSync: '/api/snippets/actions/sync',

  /** `POST` — map any one of id / shortUuid / username onto the others. */
  resolveUser: '/api/users/resolve',

  /** `GET` — lookup by name. Survives on every supported version. */
  userByUsername: (username: string): string =>
    `/api/users/by-username/${encodeURIComponent(username)}`,

  /** `GET` — lookup by subscription short uuid. Survives on every version. */
  userByShortUuid: (shortUuid: string): string =>
    `/api/users/by-short-uuid/${encodeURIComponent(shortUuid)}`,

  // ── Live connections ─────────────────────────────────────────────────────
  // 2.x served these under `/api/ip-control/*`; 3.x deleted that family outright
  // and replaced it with `/api/connections/*`. Both are two-phase: the POST
  // starts a job and answers with an id, the GET collects the result.
  //
  // MIND THE COLLISION: start and result are the SAME path with different
  // methods, and the positional segment means different things — the user id on
  // the POST, the JOB id on the GET. They are trivially confusable and, on a
  // small panel, numerically equal (job "2" for user 2), so a mix-up reads as
  // working right up until it doesn't.
  ipControlUserStart: (segment: string): string => `/api/ip-control/fetch-ips/${seg(segment)}`,
  ipControlUserResult: (jobId: string): string =>
    `/api/ip-control/fetch-ips/result/${encodeURIComponent(jobId)}`,
  ipControlNodeStart: (nodeUuid: string): string =>
    `/api/ip-control/fetch-users-ips/${encodeURIComponent(nodeUuid)}`,
  ipControlNodeResult: (jobId: string): string =>
    `/api/ip-control/fetch-users-ips/result/${encodeURIComponent(jobId)}`,
  ipControlDrop: '/api/ip-control/drop-connections',

  connectionsByUserStart: (segment: string): string => `/api/connections/by-user/${seg(segment)}`,
  connectionsByUserResult: (jobId: string): string =>
    `/api/connections/by-user/${encodeURIComponent(jobId)}`,
  connectionsByNodeStart: (nodeUuid: string): string =>
    `/api/connections/by-node/${encodeURIComponent(nodeUuid)}`,
  connectionsByNodeResult: (jobId: string): string =>
    `/api/connections/by-node/${encodeURIComponent(jobId)}`,
  connectionsDrop: '/api/connections/drop',
} as const;

/**
 * Remnawave's own "no such user" codes, restated so the adapter does not carry
 * bare string literals. Pinned against the vendor package by the guard spec:
 *   A025 `USER_NOT_FOUND`                      — "User not found"
 *   A063 `GET_USER_BY_UNIQUE_FIELDS_NOT_FOUND` — "User with specified params not found"
 * Which one arrives depends on the ENDPOINT, not on the meaning, so both have
 * to count. See `isPanelUserNotFound`.
 */
export const PANEL_USER_NOT_FOUND_ERROR_CODES = ['A025', 'A063'] as const;
