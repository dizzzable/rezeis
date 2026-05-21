export interface RemnawaveNodeInterface {
  readonly uuid: string;
  readonly name: string;
  readonly address: string;
  readonly port: number | null;
  readonly isConnected: boolean;
  readonly isDisabled: boolean;
  readonly isConnecting: boolean;
  readonly isTrafficTrackingActive: boolean;
  readonly trafficResetDay: number | null;
  readonly trafficLimitBytes: number | null;
  readonly trafficUsedBytes: number | null;
  readonly notifyPercent: number | null;
  readonly viewPosition: number;
  readonly countryCode: string;
  readonly consumptionMultiplier: number;
  readonly tags: readonly string[];
  readonly lastStatusChange: string | null;
  readonly lastStatusMessage: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly xrayUptime: number;
  readonly usersOnline: number;
  readonly activeConfigProfileUuid: string | null;
}
