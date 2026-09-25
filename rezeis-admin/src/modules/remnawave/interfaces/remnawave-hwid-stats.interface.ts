/**
 * `/api/hwid/devices/stats`, as Remnawave 3.x sends it.
 *
 * The per-app counts are NESTED: one `byApp` list inside every `byPlatform`
 * entry (3.2, contract 3.4.10, the 3.3.2 and 3.4.3 specs), and no top-level
 * list. Nothing should read them directly — `summariseHwidApps` sums them
 * across platforms, and its answer is `apps`.
 */
export interface RemnawaveHwidStatsInterface {
  readonly byPlatform: readonly {
    readonly platform: string;
    readonly count: number;
    /** This platform's devices, per client app. */
    readonly byApp?: readonly { readonly app: string; readonly count: number }[];
  }[];
  /** A top-level list no supported panel sends; nothing reads it. */
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
