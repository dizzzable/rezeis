export interface RemnawaveSubscriptionSettingsInterface {
  readonly uuid: string;
  readonly profileTitle: string;
  readonly supportLink: string;
  readonly profileUpdateInterval: number;
  readonly isProfileWebpageUrlEnabled: boolean;
  readonly serveJsonAtBaseSubscription: boolean;
  readonly isShowCustomRemarks: boolean;
  readonly randomizeHosts: boolean;
  readonly happAnnounce: string | null;
  readonly happRouting: string | null;
  readonly updatedAt: string;
}
