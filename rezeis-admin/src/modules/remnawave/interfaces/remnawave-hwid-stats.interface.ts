/**
 * `/api/hwid/devices/stats`, as every vendored Remnawave version sends it.
 *
 * `byApp` moved between versions: 2.7.x sent it at the top level, while 2.8,
 * 3.2, 3.4.2 and 3.4.3 nest one list inside every `byPlatform` entry and send
 * no top-level list at all. Both are declared optional because both are in the
 * field. Nothing should read either one directly — `summariseHwidApps` reads
 * both and never adds them together, and its answer is `apps`.
 */
export interface RemnawaveHwidStatsInterface {
  readonly byPlatform: readonly {
    readonly platform: string;
    readonly count: number;
    /** 2.8 and later. */
    readonly byApp?: readonly { readonly app: string; readonly count: number }[];
  }[];
  /** 2.7.x only. */
  readonly byApp?: readonly { readonly app: string; readonly count: number }[];
  readonly stats: {
    readonly totalUniqueDevices: number;
    readonly totalHwidDevices: number;
    readonly averageHwidDevicesPerUser: number;
  };
  /**
   * Devices per client app, summed across platforms. Added by the panel
   * (`withHwidApps`) on the admin route, NOT sent by Remnawave — and absent on
   * the strict read the fraud detector uses, which has no need of it.
   */
  readonly apps?: readonly { readonly app: string; readonly count: number }[];
}
