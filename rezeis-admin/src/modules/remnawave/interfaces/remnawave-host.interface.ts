export interface RemnawaveHostInterface {
  readonly uuid: string;
  readonly viewPosition: number;
  readonly remark: string;
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
}
