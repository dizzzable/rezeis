/**
 * A host's squad rule, normalised across panel versions.
 *
 * `ALLOW_ONLY` with an empty list means "served to nobody", and it is read
 * literally rather than as "no restriction" — the friendlier guess would show a
 * host to customers whose operator listed nobody for it. Three facts from
 * Remnawave's own source say so, and they are named here because none of them
 * can be checked from the OpenAPI dumps in `icon/` (a `.refine()` does not
 * survive OpenAPI generation), so the next reader would otherwise have to take
 * this on trust:
 *
 *   • `libs/contract/models/hosts.schema.ts` — `HostInternalSquadsSchema`
 *     carries `.refine((v) => v.mode !== ALLOW_ONLY || v.squads.length > 0)`
 *     with the message "At least one internal squad is required in ALLOW_ONLY
 *     mode", and `commands/hosts/{create,update}.command.ts` both validate
 *     against it. So the row cannot be CREATED through the API.
 *   • the same file's `HostsSchema` — the shape a host is READ back in — has no
 *     such refinement. So the row can still arrive, and pretending it cannot is
 *     how it would arrive unhandled.
 *   • `src/modules/hosts/repositories/hosts.repository.ts` — with no links, the
 *     equality in `findActiveHostsByUserId` (quoted on `internalSquads` below)
 *     is false for every squad. Nobody.
 */
export interface InternalSquadAccessInterface {
  readonly mode: 'exclude' | 'allow-only';
  readonly squads: readonly string[];
}

export interface RemnawaveHostInterface {
  readonly uuid: string;
  readonly viewPosition: number;
  readonly remark: string;
  /**
   * The line the operator writes FOR CUSTOMERS on the host in Remnawave —
   * at most 30 characters, present since Remnawave 2.0.0, and what Happ shows
   * its user. `remark` is the operator's own naming scheme ("Germany 07 D");
   * this is the customer-facing one. Null when the operator left it empty.
   * Optional so every fixture that builds a host by hand keeps compiling.
   */
  readonly serverDescription?: string | null;
  readonly address: string;
  readonly port: number;
  readonly isDisabled: boolean;
  readonly isHidden: boolean;
  readonly securityLayer: string;
  readonly tag: string | null;
  /**
   * 2.8 replaced the single `tag` string with a `tags` array. We normalize to
   * an array for both versions (legacy `tag` → `[tag]`), keeping `tag` as the
   * first element for back-compat.
   */
  readonly tags: readonly string[];
  /**
   * The config profile and inbound this host serves.
   *
   * Remnawave nests BOTH under an `inbound` object on the wire; see the note in
   * `remnawave-host-mapper.ts`, which read them off the top level for as long
   * as this interface existed and therefore always produced two nulls.
   */
  readonly configProfileUuid: string | null;
  readonly configProfileInboundUuid: string | null;
  readonly nodes: readonly string[];
  /**
   * Which of the customer's squads this host is served to.
   *
   * Until 3.4 a host carried `excludedInternalSquads`: the squads it is kept
   * OUT of. 3.4 renamed the field to `internalSquads: { mode, squads }` and
   * added the other direction — `ALLOW_ONLY`, where the listed squads are the
   * ONLY ones served. Both shapes normalise into this one.
   *
   * The test is not ours. It is one equality out of `findActiveHostsByUserId`
   * in Remnawave's `src/modules/hosts/repositories/hosts.repository.ts`, which
   * reads, with the joins elided:
   *
   *     eb2( eb2.exists(<a link between this host and this squad>),
   *          '=',
   *          eb2.parens('hosts.internalSquadsMode', '=', ALLOW_ONLY) )
   *
   * — a squad carries the host when "this squad is listed" EQUALS "the mode is
   * allow-only". Exclusions and an allow list are that one test read in two
   * directions, which is why this is a rule and not two. So "does this
   * customer's squad reach this inbound" is never the whole question.
   *
   * A host that sends neither shape has no restriction at all: Remnawave's
   * `prisma/schema.prisma` declares `internalSquadsMode String @default(
   * "EXCLUDE")`, and with no links the equality above is true for every squad.
   * That is exactly how every panel before 3.4 behaved.
   *
   * Version note: the rename reached the npm contract package in
   * `@remnawave/backend-contract@3.4.3`. The copy this repository pins for the
   * 3.4 line is one patch older and still declares the old field, so the
   * vendored types are NOT the authority here — these dumps are
   * (`icon/Remnawave API v3.4.1.json`, `v3.4.3.json`), and so is the mapper.
   */
  readonly internalSquads: InternalSquadAccessInterface;
  /**
   * The subscription formats the operator kept this host out of — any of
   * `XRAY_JSON`, `XRAY_BASE64`, `MIHOMO`, `STASH`, `CLASH`, `SINGBOX`.
   * Remnawave builds each format without the hosts that name it here, so a
   * host naming all six reaches no app. Empty when the panel does not send
   * the field. Optional so every fixture that builds a host by hand keeps
   * compiling.
   */
  readonly excludeFromSubscriptionTypes?: readonly string[];
}
