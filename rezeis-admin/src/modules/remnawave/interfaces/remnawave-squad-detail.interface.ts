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
