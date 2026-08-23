/**
 * Every panel route rezeis builds, in one place, for both eras.
 *
 * WHY THIS FILE EXISTS RATHER THAN INLINE TEMPLATE STRINGS: the 2.x and 3.x
 * paths differ only in the identifier they carry, so inline templates put the
 * version decision at seventeen call sites instead of one. Collecting them also
 * makes them checkable — `test/remnawave-3x-contract-guard.spec.ts` asserts every
 * USER-SCOPED builder below against the vendor's own URL builders in
 * `@remnawave/backend-contract@3.2.3`, and the whole-panel constants added at the
 * top of the table are pinned the same way by
 * `test/remnawave-squad-status-era-decode.spec.ts`. A path that drifts in a
 * future panel release fails a test here instead of failing silently against a
 * live panel.
 *
 * WHY THE VENDOR PACKAGE IS NOT IMPORTED HERE. The sentence that used to stand
 * in this spot ("it is a devDependency… production ships nothing extra") was
 * false in both halves, three lines from a counterexample; the sentence that
 * replaced it said so plainly and left the counterexample standing. It is now
 * true, and it is true because the counterexample was removed:
 *
 *   • EVERY `@remnawave/*` contract package is a devDependency — the 2.7 line
 *     (`@remnawave/backend-contract`, 2.7.3), the 2.8 line
 *     (`@remnawave/contract-v28`, 2.8.35) and the 3.x lines
 *     (`@remnawave/contract-v3` 3.2.3, `@remnawave/contract-v34` 3.4.2, the pin
 *     matching panel 3.3.2). None is imported from `src/`. `Dockerfile` stage 1
 *     runs `npm ci --omit=dev`, so none of them ships in the image, and the
 *     AGPL-3.0-only licence they carry stays out of the distributed artefact.
 *   • They remain the CI ORACLE for both eras, executed by the guard specs —
 *     including the URLs immediately below, which
 *     `test/remnawave-squad-status-era-decode.spec.ts` pins against all four
 *     lines' own `*.url` constants. Holding a route to the vendor at BUILD time
 *     is the whole benefit; executing vendor schemas at RUN time was never
 *     a benefit at all.
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
  // Constants, not builders, and byte-identical across 2.7.3 / 2.8.35 / 3.2.3 /
  // 3.4.2 — pinned against all four in
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

  /** `POST` — push one reusable snippet into all config profiles that reference it. */
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
