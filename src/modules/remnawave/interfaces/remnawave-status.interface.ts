export interface RemnawaveStatusInterface {
  readonly isConfigured: boolean;
  readonly isReachable: boolean;
  readonly isLoginAllowed: boolean | null;
  readonly isRegisterAllowed: boolean | null;
  readonly authentication: {
    readonly passwordEnabled: boolean;
    readonly passkeyEnabled: boolean;
    readonly oauth2Providers: Readonly<Record<string, boolean>>;
  } | null;
  readonly branding: {
    readonly title: string | null;
    readonly logoUrl: string | null;
  } | null;
}
