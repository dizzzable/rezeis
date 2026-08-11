export interface OlcrtcSubscriptionPayload {
  readonly enabled: boolean;
  readonly eligible: boolean;
  readonly status: 'DISABLED' | 'NO_ACTIVE_SUBSCRIPTION' | 'UNAVAILABLE' | 'READY';
  readonly reason?: string;
  readonly subscription: {
    readonly sessionId: string;
    readonly subscriptionId: string;
    readonly profileId: string;
    readonly provider: string;
    readonly transport: string;
    readonly url: string;
    readonly refreshSeconds: number;
    readonly expiresAt: string | null;
  } | null;
}
