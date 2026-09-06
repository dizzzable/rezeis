/**
 * Full-shape squad rows used by the admin "Remnawave → Squads" tab.
 *
 * Distinct from `RemnawaveSquadOptionInterface` (which is just `{uuid, name}`
 * for plan selectors). The detail variant carries the counters Remnawave's
 * own UI displays so we can mirror it exactly.
 */
export interface RemnawaveInternalSquadDetailInterface {
  readonly uuid: string;
  readonly name: string;
  readonly viewPosition: number;
  readonly membersCount: number;
  readonly inboundsCount: number;
  /**
   * UUIDs of the squad's inbounds — and nothing else from the inbound.
   *
   * This is the join that says which hosts a subscriber can actually reach: a
   * host carries `configProfileInboundUuid`, so a host belongs to a squad when
   * that UUID appears here. Nothing else in the inbound row may be taken; see
   * the note in `remnawave-squad-mappers` for what sits next to it.
   */
  readonly inboundUuids: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RemnawaveExternalSquadDetailInterface {
  readonly uuid: string;
  readonly name: string;
  readonly viewPosition: number;
  readonly membersCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
