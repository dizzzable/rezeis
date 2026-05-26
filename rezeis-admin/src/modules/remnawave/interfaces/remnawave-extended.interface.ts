/**
 * Extended interface bag for the redesigned Remnawave page. We keep them in
 * one file because each shape is small and they share the same versioning
 * concerns: shape-tolerant parsers in `remnawave-api.service.ts` mappers
 * are the source of truth — these `interface` declarations are just a
 * documentation surface for the admin SPA.
 */

export interface RemnawaveHealthInterface {
  readonly status?: string;
  readonly message?: string | null;
  readonly uptime?: number;
  readonly db?: { readonly status?: string };
  readonly redis?: { readonly status?: string };
  readonly version?: string;
}

export interface RemnawaveHwidTopUserInterface {
  readonly userUuid: string;
  readonly username: string;
  readonly telegramId: string | null;
  readonly devicesCount: number;
  readonly lastSeenAt: string | null;
}

export interface RemnawaveSubscriptionRequestStatsInterface {
  readonly totalRequests: number;
  readonly uniqueUsers: number;
  readonly perClient: ReadonlyArray<{ readonly clientType: string; readonly count: number }>;
  readonly perDay: ReadonlyArray<{ readonly date: string; readonly count: number }>;
}

export interface RemnawaveSubscriptionRequestEntryInterface {
  readonly id: string;
  readonly userUuid: string | null;
  readonly username: string | null;
  readonly clientType: string | null;
  readonly userAgent: string | null;
  readonly ipAddress: string | null;
  readonly requestedAt: string;
}

export interface RemnawaveInfraProviderInterface {
  readonly uuid: string;
  readonly name: string;
  readonly type: string | null;
  readonly currency: string | null;
  readonly nodesCount: number;
  readonly monthlyCost: number | null;
  readonly createdAt: string;
}

export interface RemnawaveSnippetInterface {
  readonly uuid: string;
  readonly name: string;
  readonly description: string | null;
  readonly type: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RemnawaveSubpageConfigInterface {
  readonly uuid: string;
  readonly name: string;
  readonly title: string | null;
  readonly description: string | null;
  readonly logoUrl: string | null;
  readonly faviconUrl: string | null;
  readonly customCss: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RemnawaveNodePluginInterface {
  readonly uuid: string;
  readonly name: string;
  readonly version: string | null;
  readonly nodeUuid: string | null;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RemnawaveUserResolveQuery {
  readonly telegramId?: string;
  readonly username?: string;
  readonly email?: string;
  readonly subscriptionUuid?: string;
}

export interface RemnawaveUserSummaryInterface {
  readonly uuid: string;
  readonly shortUuid: string | null;
  readonly username: string;
  readonly status: string | null;
  readonly trafficLimitBytes: number | null;
  readonly trafficUsedBytes: number | null;
  readonly hwidDeviceLimit: number | null;
  readonly expireAt: string | null;
  readonly telegramId: string | null;
  readonly email: string | null;
  readonly tag: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly subscriptionUrl: string | null;
}


export interface RemnawaveSubscriptionTemplateInterface {
  readonly uuid: string;
  readonly name: string;
  readonly viewPosition: number;
  readonly templateType: string;
  readonly hasYaml: boolean;
}

export interface RemnawaveSubscriptionSettingsInterface {
  readonly uuid: string;
  readonly profileTitle: string;
  readonly supportLink: string | null;
  readonly profileUpdateInterval: number;
  readonly serveJsonAtBaseSubscription: boolean;
  readonly isProfileWebpageUrlEnabled: boolean;
  readonly isShowCustomRemarks: boolean;
  readonly randomizeHosts: boolean;
  /** Booleans summarising whether the panel exposes the corresponding payload. */
  readonly hasHappAnnounce: boolean;
  readonly hasHappRouting: boolean;
  readonly hasResponseRules: boolean;
  readonly hasCustomRemarks: boolean;
}
