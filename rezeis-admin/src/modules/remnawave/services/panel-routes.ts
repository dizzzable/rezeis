/**
 * Every panel route the old adapter builds, in one place, for Remnawave 3.x.
 *
 * WHY THIS FILE EXISTS RATHER THAN INLINE TEMPLATE STRINGS: collecting the
 * paths makes them checkable — `test/remnawave-3x-contract-guard.spec.ts`
 * asserts every USER-SCOPED builder below against the URL builders of every 3.x
 * contract the fleet's panel releases ship, and the whole-panel constants at the
 * top of the table are pinned the same way by
 * `test/remnawave-squad-status-era-decode.spec.ts`. A path that drifts in a
 * future panel release fails a test here instead of failing silently against a
 * live panel.
 *
 * THIS TABLE SERVES `remnawave-api.service.ts`. The three contract-driven
 * clients (`panel-users`, `panel-devices`, `panel-infra`) take their routes from
 * the hand-owned command table in `panel-commands.ts`, which
 * `test/panel-command-conformance.spec.ts` holds to the 3.x contract oracles the
 * same way. One of those commands reaches a panel of any version: the version
 * probe, `GetMetadataCommand`, which `PanelInfraClient.forVersionProbe` sends
 * over the bare transport, because its answer is what identifies a 2.x panel.
 * Every other one goes through `LegacyPanelRefusal` in `panel-transport.ts`,
 * which turns it away once the probe has reported a major below 3 — and lets it
 * out as if to 3.x while the probe has no answer yet. The routes in THIS table
 * meet the SAME refusal, read from the same probe: `remnawave-api.service.ts`
 * refuses before each of its own HTTP sends, and only its two version readers
 * (`getSystemRecap`, `getSystemMetadata`) are exempt.
 *
 * WHY NO VENDOR PACKAGE IS IMPORTED HERE — OR ANYWHERE IN `src/`. This spot has
 * held a claim about the vendor packages several times, and each time the claim
 * drifted out of true while nobody was reading it. So the claim is now a TEST:
 * `test/panel-command-conformance.spec.ts` fails if any file under `src/` imports
 * `@remnawave/*` (by value, by type, dynamically or by `require`), if
 * `package.json` lists one outside `devDependencies`, or if `npm ls --omit=dev`
 * finds one. The contracts are devDependency ORACLES, one per panel release
 * family, named by the panel release and pinned exactly to the contract that
 * release ships (https://docs.rw/sdk/typescript-sdk/) — `@remnawave/contract-panel-3.2.1`
 * through `@remnawave/contract-panel-3.4.4`; no spec reads a 2.x oracle any
 * more, since a 2.x panel is refused on every path. `Dockerfile` stage 1 runs
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
 * schema describes ONE release; the panels this codebase reads span several.
 * See `panel-response-decoders.ts`.
 *
 * The reason THIS file imports nothing is unchanged and still good: its response
 * parsing is deliberately more tolerant than the published contract (see
 * `mapSubscriptionSettings` and the defensive `total` reads), so executing
 * vendor schemas here would turn cosmetic panel drift into an outage.
 *
 * `segment` is always the already-resolved numeric id in decimal, produced by
 * `panelUserAddress` through the adapter. These builders do not decide what it
 * is; a route file that guessed would be a second place an addressing decision
 * lived.
 */

/** `encodeURIComponent`, but a plain numeric id is left alone for readability. */
function seg(value: string): string {
  return /^\d+$/.test(value) ? value : encodeURIComponent(value);
}

export const PANEL_ROUTES = {
  // ── Whole-panel reads ────────────────────────────────────────────────────
  // Constants, not builders, and byte-identical in every contract a panel
  // release ships — pinned against every contract oracle the repository
  // carries in `test/remnawave-squad-status-era-decode.spec.ts`. They came off
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

  /** `GET` one profile, by numeric id. */
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

  /** `POST` — drop one device. Owner goes in the BODY, as `userId`. */
  deleteHwidDevice: '/api/hwid/devices/delete',

  /** `POST` — drop every device. Owner goes in the BODY, as `userId`. */
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
  // `/api/connections/*`, two-phase: the POST starts a job and answers with an
  // id, the GET collects the result.
  //
  // MIND THE COLLISION: start and result are the SAME path with different
  // methods, and the positional segment means different things — the user id on
  // the POST, the JOB id on the GET. They are trivially confusable and, on a
  // small panel, numerically equal (job "2" for user 2), so a mix-up reads as
  // working right up until it doesn't.
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
