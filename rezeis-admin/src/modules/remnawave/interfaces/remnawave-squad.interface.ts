export interface RemnawaveInternalSquadInterface {
  readonly uuid: string;
  readonly name: string;
  readonly viewPosition: number;
  readonly info: { readonly membersCount: number; readonly inboundsCount: number };
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RemnawaveExternalSquadInterface {
  readonly uuid: string;
  readonly name: string;
  readonly viewPosition: number;
  readonly info: { readonly membersCount: number };
  readonly createdAt: string;
  readonly updatedAt: string;
}
