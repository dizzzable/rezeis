export interface RemnawaveConfigProfileInterface {
  readonly uuid: string;
  readonly name: string;
  readonly viewPosition: number;
  readonly inbounds: readonly {
    readonly uuid: string;
    readonly tag: string;
    readonly type: string;
    readonly network: string | null;
    readonly security: string | null;
    readonly port: number | null;
  }[];
  readonly nodes: readonly {
    readonly uuid: string;
    readonly name: string;
    readonly countryCode: string;
  }[];
  readonly createdAt: string;
  readonly updatedAt: string;
}
