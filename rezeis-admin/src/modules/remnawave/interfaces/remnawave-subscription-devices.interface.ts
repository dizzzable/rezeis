export interface RemnawaveSubscriptionDeviceInterface {
  readonly hwid: string;
  readonly deviceName: string | null;
  readonly platform: string | null;
  readonly osVersion: string | null;
  readonly appVersion: string | null;
  readonly userAgent: string | null;
  readonly ipAddress: string | null;
  readonly lastSeenAt: string | null;
  readonly createdAt: string | null;
}

export interface RemnawaveSubscriptionDevicesInterface {
  readonly devices: readonly RemnawaveSubscriptionDeviceInterface[];
  readonly deviceCount: number;
}
