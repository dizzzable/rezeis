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
   * Squads this host is deliberately kept out of.
   *
   * A host reaches a squad through its inbound, EXCEPT for the squads listed
   * here -- Remnawave leaves it out of their configs. So "does this customer's
   * squad reach this inbound" is not the whole question; the host may still
   * have opted out of the particular squad that got them there. Empty on any
   * panel version that does not send the field, which means no exclusions and
   * matches how those versions behave.
   */
  readonly excludedInternalSquads: readonly string[];
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
