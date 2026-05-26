/**
 * Mappers for the "extended" Remnawave surface (live, costs, catalog, users
 * search, subscription history). All of them are defensive: they accept
 * `unknown`, never throw, and fall back to empty/zero values when fields
 * are missing — different Remnawave versions ship subtly different shapes
 * across the same endpoints.
 */
import {
  RemnawaveHwidTopUserInterface,
  RemnawaveInfraProviderInterface,
  RemnawaveNodePluginInterface,
  RemnawaveSnippetInterface,
  RemnawaveSubpageConfigInterface,
  RemnawaveSubscriptionRequestEntryInterface,
  RemnawaveUserSummaryInterface,
} from '../interfaces/remnawave-extended.interface';

export function mapHwidTopUser(raw: unknown): RemnawaveHwidTopUserInterface {
  const r = (raw ?? {}) as Record<string, unknown>;
  // 2.7.x ships `{ userUuid, id, username, devicesCount }` flat at the row
  // level, no nested `user` block. We still tolerate the older nested shape.
  const user = (r['user'] ?? r) as Record<string, unknown>;
  return {
    userUuid: toString(r['userUuid'] ?? user['uuid']),
    username: toString(r['username'] ?? user['username']),
    telegramId: toNullableString(r['telegramId'] ?? user['telegramId']),
    devicesCount: toNumber(r['devicesCount'] ?? r['count'] ?? r['hwidDevicesCount']),
    lastSeenAt: toNullableString(r['lastSeenAt'] ?? r['lastUsedAt'] ?? user['lastSeenAt']),
  };
}

export function mapSubscriptionRequestEntry(raw: unknown): RemnawaveSubscriptionRequestEntryInterface {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    // `id` ships as a number on 2.7.x — stringify so the UI key stays consistent.
    id: toString(r['id'] ?? r['uuid']),
    userUuid: toNullableString(r['userUuid'] ?? (r['user'] as Record<string, unknown> | undefined)?.['uuid']),
    username: toNullableString(r['username'] ?? (r['user'] as Record<string, unknown> | undefined)?.['username']),
    clientType: toNullableString(r['clientType']),
    userAgent: toNullableString(r['userAgent']),
    // 2.7.x: `requestIp`. 2.8+: `ipAddress`. Either is accepted.
    ipAddress: toNullableString(r['ipAddress'] ?? r['ip'] ?? r['requestIp']),
    // 2.7.x: `requestAt`. 2.8+: `requestedAt`. Either is accepted.
    requestedAt: toString(r['requestedAt'] ?? r['requestAt'] ?? r['createdAt']),
  };
}

export function mapInfraProvider(raw: unknown): RemnawaveInfraProviderInterface {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    uuid: toString(r['uuid']),
    name: toString(r['name']),
    type: toNullableString(r['type']),
    currency: toNullableString(r['currency']),
    nodesCount: toNumber(r['nodesCount'] ?? (r['nodes'] as unknown[] | undefined)?.length),
    monthlyCost: toNullableNumber(r['monthlyCost']),
    createdAt: toString(r['createdAt']),
  };
}

export function mapSnippet(raw: unknown): RemnawaveSnippetInterface {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    uuid: toString(r['uuid']),
    name: toString(r['name']),
    description: toNullableString(r['description']),
    type: toNullableString(r['type']),
    createdAt: toString(r['createdAt']),
    updatedAt: toString(r['updatedAt']),
  };
}

export function mapSubpageConfig(raw: unknown): RemnawaveSubpageConfigInterface {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    uuid: toString(r['uuid']),
    name: toString(r['name']),
    title: toNullableString(r['title']),
    description: toNullableString(r['description']),
    logoUrl: toNullableString(r['logoUrl']),
    faviconUrl: toNullableString(r['faviconUrl']),
    customCss: toNullableString(r['customCss']),
    createdAt: toString(r['createdAt']),
    updatedAt: toString(r['updatedAt']),
  };
}

export function mapNodePlugin(raw: unknown): RemnawaveNodePluginInterface {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    uuid: toString(r['uuid']),
    name: toString(r['name']),
    version: toNullableString(r['version']),
    nodeUuid: toNullableString(r['nodeUuid']),
    enabled: Boolean(r['enabled']),
    createdAt: toString(r['createdAt']),
    updatedAt: toString(r['updatedAt']),
  };
}

export function mapUserSummary(raw: unknown): RemnawaveUserSummaryInterface {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    uuid: toString(r['uuid']),
    shortUuid: toNullableString(r['shortUuid']),
    username: toString(r['username']),
    status: toNullableString(r['status']),
    trafficLimitBytes: toNullableNumber(r['trafficLimitBytes']),
    trafficUsedBytes: toNullableNumber(r['trafficUsedBytes']),
    hwidDeviceLimit: toNullableNumber(r['hwidDeviceLimit']),
    expireAt: toNullableString(r['expireAt']),
    telegramId: toNullableString(r['telegramId']),
    email: toNullableString(r['email']),
    tag: toNullableString(r['tag']),
    createdAt: toNullableString(r['createdAt']),
    updatedAt: toNullableString(r['updatedAt']),
    subscriptionUrl: toNullableString(r['subscriptionUrl']),
  };
}

function toString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function toNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function toNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toNullableNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}


export function mapSubscriptionTemplate(raw: unknown): {
  readonly uuid: string;
  readonly name: string;
  readonly viewPosition: number;
  readonly templateType: string;
  readonly hasYaml: boolean;
} {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    uuid: toString(r['uuid']),
    name: toString(r['name']),
    viewPosition: toNumber(r['viewPosition']),
    templateType: toString(r['templateType']),
    hasYaml: typeof r['encodedTemplateYaml'] === 'string' && (r['encodedTemplateYaml'] as string).length > 0,
  };
}

/**
 * Subscription settings come back from Remnawave as a hefty mixed payload.
 * We surface only the fields safe to display in the admin UI:
 *   • toggles + display strings,
 *   • boolean "is configured" flags for response rules / Happ-specific
 *     payloads (those carry raw config blobs we don't want to leak through
 *     the admin SPA).
 */
export function mapSubscriptionSettings(raw: unknown): {
  readonly uuid: string;
  readonly profileTitle: string;
  readonly supportLink: string | null;
  readonly profileUpdateInterval: number;
  readonly serveJsonAtBaseSubscription: boolean;
  readonly isProfileWebpageUrlEnabled: boolean;
  readonly isShowCustomRemarks: boolean;
  readonly randomizeHosts: boolean;
  readonly hasHappAnnounce: boolean;
  readonly hasHappRouting: boolean;
  readonly hasResponseRules: boolean;
  readonly hasCustomRemarks: boolean;
} {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    uuid: toString(r['uuid']),
    profileTitle: toString(r['profileTitle']),
    supportLink: toNullableString(r['supportLink']),
    profileUpdateInterval: toNumber(r['profileUpdateInterval']),
    serveJsonAtBaseSubscription: Boolean(r['serveJsonAtBaseSubscription']),
    isProfileWebpageUrlEnabled: Boolean(r['isProfileWebpageUrlEnabled']),
    isShowCustomRemarks: Boolean(r['isShowCustomRemarks']),
    randomizeHosts: Boolean(r['randomizeHosts']),
    hasHappAnnounce: typeof r['happAnnounce'] === 'string' && (r['happAnnounce'] as string).length > 0,
    hasHappRouting: typeof r['happRouting'] === 'string' && (r['happRouting'] as string).length > 0,
    hasResponseRules:
      typeof r['responseRules'] === 'object' && r['responseRules'] !== null,
    hasCustomRemarks:
      typeof r['customRemarks'] === 'object' && r['customRemarks'] !== null,
  };
}
