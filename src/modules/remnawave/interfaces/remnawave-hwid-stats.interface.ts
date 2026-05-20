export interface RemnawaveHwidStatsInterface {
  readonly byPlatform: readonly { readonly platform: string; readonly count: number }[];
  readonly byApp?: readonly { readonly app: string; readonly count: number }[];
  readonly stats: {
    readonly totalUniqueDevices: number;
    readonly totalHwidDevices: number;
    readonly averageHwidDevicesPerUser: number;
  };
}
