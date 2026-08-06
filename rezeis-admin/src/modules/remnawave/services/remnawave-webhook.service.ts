import { Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Inject } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Prisma, SubscriptionStatus } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { remnawaveConfig } from '../../../common/config/remnawave.config';
import {
  EVENT_TYPES,
  SystemEventsService,
  type SystemEventCategory,
  type SystemEventSeverity,
} from '../../../common/services/system-events.service';
import { RemnawaveApiService } from './remnawave-api.service';

/**
 * How long a first-connection card may hold the webhook open waiting for the
 * panel's traffic counter. See `readPanelUsageBounded` for why this is not the
 * shared 45-second outbound timeout.
 */
const PANEL_USAGE_READ_TIMEOUT_MS = 3_000;

/**
 * Curated map of Remnawave panel webhook event names → forwarded system events.
 *
 * Only names present here are turned into Telegram cards (audit log + realtime
 * too). Everything else (e.g. the chatty `user.online`, or our own
 * `user.created`/`updated`/`deleted` which we already emit ourselves) is stored
 * in the activity feed only — keeping the firehose quiet by default.
 *
 * Keys are the lowercased panel event name. Both the dotted (`node.offline`)
 * and underscore (`node_offline`) spellings are normalized to the dotted form
 * before lookup, so either wire format matches.
 */
const REMNAWAVE_WEBHOOK_EVENT_MAP: Record<
  string,
  { readonly type: string; readonly category: SystemEventCategory; readonly severity: SystemEventSeverity }
> = {
  // User lifecycle
  'user.first_connected': { type: EVENT_TYPES.REMNAWAVE_USER_FIRST_CONNECTED, category: 'REMNAWAVE', severity: 'INFO' },
  'user.expired': { type: EVENT_TYPES.REMNAWAVE_USER_EXPIRED, category: 'REMNAWAVE', severity: 'WARNING' },
  'user.limited': { type: EVENT_TYPES.REMNAWAVE_USER_LIMITED, category: 'REMNAWAVE', severity: 'WARNING' },
  'user.enabled': { type: EVENT_TYPES.REMNAWAVE_USER_ENABLED, category: 'REMNAWAVE', severity: 'INFO' },
  'user.disabled': { type: EVENT_TYPES.REMNAWAVE_USER_DISABLED, category: 'REMNAWAVE', severity: 'WARNING' },
  'user.traffic_reset': { type: EVENT_TYPES.REMNAWAVE_USER_TRAFFIC_RESET, category: 'REMNAWAVE', severity: 'INFO' },
  // Expiry warnings. ONE build serves both supported panel versions, so both
  // spellings have to be here:
  //   * 2.7.4 raises one of four discrete names. Three are mapped below; the
  //     fourth, `user.expired_24_hours_ago`, is deliberately NOT mapped —
  //     `user.expired` has already produced a card by then and a second one a
  //     day later is duplicate noise. That predates this map and stays as is.
  //   * 2.8.0 REMOVED all four from `RemnawaveWebhookUserEventsDto.event` and
  //     replaced them with a single `user.expiration`, moving the
  //     distinguishing number into the envelope's `meta.expiration`
  //     (see `extractEventMetadata`). Without the key below, an expire-soon
  //     event on a 2.8.0 panel produced no audit entry, no realtime card, no
  //     Telegram message and no outbound webhook.
  'user.expires_in_24_hours': { type: EVENT_TYPES.REMNAWAVE_USER_EXPIRE_SOON, category: 'REMNAWAVE', severity: 'INFO' },
  'user.expires_in_48_hours': { type: EVENT_TYPES.REMNAWAVE_USER_EXPIRE_SOON, category: 'REMNAWAVE', severity: 'INFO' },
  'user.expires_in_72_hours': { type: EVENT_TYPES.REMNAWAVE_USER_EXPIRE_SOON, category: 'REMNAWAVE', severity: 'INFO' },
  'user.expiration': { type: EVENT_TYPES.REMNAWAVE_USER_EXPIRE_SOON, category: 'REMNAWAVE', severity: 'INFO' },
  // NOT in either version's `event` enum — no Remnawave panel raises this.
  // Kept purely as a defensive alias for relays/proxies that normalize the
  // name themselves: an unused key costs one property lookup, whereas deleting
  // it would silently drop such events for zero benefit. Do not read it as
  // evidence that some panel sends it.
  'user.expire_soon': { type: EVENT_TYPES.REMNAWAVE_USER_EXPIRE_SOON, category: 'REMNAWAVE', severity: 'INFO' },
  'user.bandwidth_usage_threshold_reached': { type: EVENT_TYPES.REMNAWAVE_BANDWIDTH_THRESHOLD, category: 'REMNAWAVE', severity: 'WARNING' },
  // Node / infrastructure
  'node.connection_lost': { type: EVENT_TYPES.NODE_CONNECTION_LOST, category: 'NODE', severity: 'WARNING' },
  'node.offline': { type: EVENT_TYPES.NODE_CONNECTION_LOST, category: 'NODE', severity: 'WARNING' },
  'node.connection_restored': { type: EVENT_TYPES.NODE_CONNECTION_RESTORED, category: 'NODE', severity: 'INFO' },
  'node.online': { type: EVENT_TYPES.NODE_CONNECTION_RESTORED, category: 'NODE', severity: 'INFO' },
  'node.created': { type: EVENT_TYPES.NODE_CREATED, category: 'NODE', severity: 'INFO' },
  'node.modified': { type: EVENT_TYPES.NODE_MODIFIED, category: 'NODE', severity: 'INFO' },
  'node.enabled': { type: EVENT_TYPES.NODE_ENABLED, category: 'NODE', severity: 'INFO' },
  'node.disabled': { type: EVENT_TYPES.NODE_DISABLED, category: 'NODE', severity: 'WARNING' },
  'node.traffic_notify': { type: EVENT_TYPES.NODE_TRAFFIC_NOTIFY, category: 'NODE', severity: 'WARNING' },
  // Service
  'service.panel_started': { type: EVENT_TYPES.REMNAWAVE_PANEL_STARTED, category: 'NODE', severity: 'INFO' },
};

/**
 * Maps a Remnawave panel user `status` string onto the local
 * `SubscriptionStatus` enum. Unknown / absent statuses yield `undefined`
 * (the caller then keeps the existing status or derives it from the event).
 * `DELETED` is local-only and never set from the panel.
 */
interface LocalUserContext {
  readonly user: { readonly id: string; readonly telegramId: bigint | null; readonly name: string; readonly username: string | null };
  readonly subscription: {
    readonly id: string;
    readonly status: SubscriptionStatus;
    readonly trafficLimit: number | null;
    readonly deviceLimit: number;
    readonly expiresAt: Date | null;
  } | null;
}

const PANEL_STATUS_MAP: Readonly<Record<string, SubscriptionStatus>> = {
  ACTIVE: SubscriptionStatus.ACTIVE,
  DISABLED: SubscriptionStatus.DISABLED,
  LIMITED: SubscriptionStatus.LIMITED,
  EXPIRED: SubscriptionStatus.EXPIRED,
};

/** Derive the subscription status from a user-lifecycle event name. */
function statusFromEventName(normalizedEvent: string): SubscriptionStatus | undefined {
  switch (normalizedEvent) {
    case 'user.expired':
      return SubscriptionStatus.EXPIRED;
    case 'user.limited':
      return SubscriptionStatus.LIMITED;
    case 'user.disabled':
      return SubscriptionStatus.DISABLED;
    case 'user.enabled':
      return SubscriptionStatus.ACTIVE;
    default:
      return undefined;
  }
}

/** Normalizes a panel event name to the lowercased dotted form used as a map key. */
function normalizeRemnawaveEventName(eventType: string): string {
  const lower = eventType.trim().toLowerCase();
  // Convert a leading `prefix_rest` to `prefix.rest` only when there's no dot
  // yet (some senders use `USER_EXPIRED` instead of `user.expired`).
  if (!lower.includes('.') && lower.includes('_')) {
    const idx = lower.indexOf('_');
    return `${lower.slice(0, idx)}.${lower.slice(idx + 1)}`;
  }
  return lower;
}

/**
 * Placeholder stored in place of any payload field that is not on the
 * allow-list below. We keep the key and drop the value (rather than deleting
 * the key) on purpose: an operator reading the Activity Feed then SEES that
 * the panel sent something we refused to store, which is the only cheap signal
 * that `WEBHOOK_PAYLOAD_ALLOWED_KEYS` has fallen behind the panel version.
 */
const REDACTED_VALUE = '[redacted]';

/**
 * Recursion guard for `redactToAllowedKeys`. Real panel payloads bottom out
 * around depth 5 (`data.node.system.stats.interface.rxTotal`); anything deeper
 * is malformed or hostile, so it is redacted rather than walked.
 */
const MAX_PAYLOAD_DEPTH = 12;

/**
 * Keys that MAY be persisted into `RemnawaveWebhookEvent.payload`.
 *
 * THE RULE. That column is not a private log: `getRecentEvents` ships the
 * stored payload verbatim to `GET /admin/remnawave/metrics/activity-feed`, so
 * whatever is in it is also in a browser response body, in devtools, and in
 * any HAR file an operator mails to support. Three classes of data must
 * therefore NEVER reach it:
 *
 *   1. Anything that authenticates a customer to the proxy — `vlessUuid`,
 *      `trojanPassword`, `ssPassword`, the device-binding `hwid`.
 *   2. Anything that IS a ready-made access path — `subscriptionUrl` and the
 *      `shortUuid` it is built from (the panel hands the full config, keys
 *      included, to whoever holds either), plus panel/provider secrets:
 *      `password` (the admin's, on service login-attempt events), `apiToken`,
 *      `proxyUrl`, `loginUrl`, `rawInbound` (Reality / TLS private material).
 *   3. Anything that records where a customer was or what they reached — their
 *      real `ip` / `requestIp` / xray `source`, and the traffic `destination`
 *      / `originalTarget` / `routeTarget`. We sell a VPN; that is precisely
 *      the record we must not be holding.
 *
 * This is an ALLOW-list, not a deny-list, and that is the whole point. A
 * deny-list cannot strip a credential field Remnawave has not shipped yet, so
 * every panel upgrade would silently start leaking until a human noticed.
 * Here the default for an unknown key is `REDACTED_VALUE`: a new field is
 * withheld until someone adds it below — which is the code review where the
 * question "is this a secret?" actually gets asked. Adding a name here is a
 * security decision, not a formality.
 *
 * Matching is by key NAME at ANY depth, because the same user object arrives
 * at `data` (user events), at `data.user` (hwid-device and torrent-blocker
 * events) and would arrive one level deeper again the moment the panel nests
 * it further.
 *
 * Derived by walking every `RemnawaveWebhook*Dto` schema in the Remnawave API
 * v3.2.1 OpenAPI document (7 schemas, 132 distinct property names) and keeping
 * only the names below.
 */
const WEBHOOK_PAYLOAD_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  // Envelope. `type` is also the controller's event-name fallback.
  'scope', 'event', 'type', 'timestamp', 'data', 'meta',
  'notConnectedAfterHours', 'expiration',

  // Panel identity. `id` (3.x numeric), `uuid` (2.x) and the legacy
  // `userUuid` are what `reconcileSubscriptionFromEvent` matches
  // `Subscription.remnawaveId` on — strip them and reconciliation silently
  // stops. `vlessUuid` is deliberately NOT one of them: despite the name it
  // is the customer's VLESS credential, not an identifier. Never relax this
  // into a substring match on "uuid".
  'id', 'uuid', 'userUuid', 'userId', 'user', 'username', 'telegramId', 'email',
  'description', 'tag', 'externalSquadUuid', 'activeInternalSquads',

  // Subscription runtime state — read by `reconcileSubscriptionFromEvent`
  // and `extractEventMetadata`.
  'status', 'expireAt', 'trafficLimitBytes', 'trafficLimitStrategy',
  'hwidDeviceLimit', 'lastTriggeredThreshold', 'subRevokedAt',
  'lastTrafficResetAt', 'createdAt', 'updatedAt', 'processedAt',
  'userTraffic', 'usedTrafficBytes', 'usedTraffic', 'lifetimeUsedTrafficBytes',
  'onlineAt', 'firstConnectedAt', 'lastConnectedNodeUuid',

  // Node / infrastructure.
  'node', 'name', 'nodeName', 'nodeUuid', 'address', 'port', 'countryCode',
  'note', 'tags', 'isConnected', 'isDisabled', 'isConnecting',
  'isTrafficTrackingActive', 'lastStatusChange', 'lastStatusMessage',
  'trafficResetDay', 'trafficUsedBytes', 'notifyPercent', 'viewPosition',
  'consumptionMultiplier', 'nodeConsumptionMultiplier', 'usersOnline',
  'xrayUptime', 'versions', 'xray', 'activePluginUuid',
  'providerUuid', 'provider', 'providerName', 'faviconLink', 'nextBillingAt',
  'configProfile', 'activeConfigProfileUuid', 'activeInbounds', 'profileUuid',
  'network', 'security',
  'system', 'info', 'stats', 'arch', 'cpus', 'cpuModel', 'memoryTotal',
  'hostname', 'release', 'version', 'memoryFree', 'memoryUsed', 'uptime',
  'loadAvg', 'interface', 'rxBytesPerSec', 'txBytesPerSec', 'rxTotal', 'txTotal',

  // Service scope. `loginAttempt` is kept as a container so a failed panel
  // login still shows up in the feed — its `password`, `ip` and `userAgent`
  // are absent from this list and get redacted inside it.
  'panelVersion', 'subpageConfig', 'action', 'loginAttempt',

  // Torrent-blocker enforcement record: what we did and to which panel user,
  // without the customer's IP or the destination they were reaching.
  'report', 'actionReport', 'blocked', 'blockDuration', 'willUnblockAt',
  'xrayReport', 'level', 'protocol', 'inboundTag', 'inboundName', 'outboundTag',
  'ts', 'hwidUserDevice',
]);

/**
 * Returns a deep copy of `value` in which every object key absent from
 * `WEBHOOK_PAYLOAD_ALLOWED_KEYS` is replaced by `REDACTED_VALUE`. A rejected
 * key's subtree is never walked, so an unknown container cannot smuggle a
 * credential through one of its children.
 *
 * Purely non-mutating, and that is load-bearing: `handleEvent` sanitizes
 * BEFORE it reconciles the subscription and extracts card metadata, and both
 * of those read the RAW payload — mutating the input here would blank the
 * fields they need.
 */
function redactToAllowedKeys(value: unknown, depth = 0): unknown {
  if (Array.isArray(value)) {
    // Array entries carry no key of their own; they inherit the decision
    // already taken for the array's key.
    return depth >= MAX_PAYLOAD_DEPTH
      ? REDACTED_VALUE
      : value.map((entry) => redactToAllowedKeys(entry, depth + 1));
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (depth >= MAX_PAYLOAD_DEPTH) {
    return REDACTED_VALUE;
  }
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    result[key] = WEBHOOK_PAYLOAD_ALLOWED_KEYS.has(key)
      ? redactToAllowedKeys(entry, depth + 1)
      : REDACTED_VALUE;
  }
  return result;
}

/**
 * Handles incoming webhook events from the Remnawave panel.
 *
 * Events are stored in `RemnawaveWebhookEvent` for the Activity Feed
 * on the dashboard. The service validates HMAC-SHA256 signatures when
 * a webhook secret is configured. Curated event types are additionally
 * forwarded to the system-event bus so they reach Telegram cards.
 *
 * Known event types from Remnawave panel:
 *   - user.created, user.updated, user.deleted, user.limited, user.expired
 *   - node.created, node.offline, node.online
 *   - subscription.expired
 */
@Injectable()
export class RemnawaveWebhookService {
  private readonly logger = new Logger(RemnawaveWebhookService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    @Inject(remnawaveConfig.KEY)
    private readonly configuration: ConfigType<typeof remnawaveConfig>,
    private readonly systemEvents: SystemEventsService,
    // Same module, already a provider — no new wiring, no cycle. Used by
    // exactly one path: filling the traffic counter a first-connection payload
    // does not carry (see `enrichConnectionTraffic`).
    private readonly remnawaveApiService: RemnawaveApiService,
  ) {}

  /**
   * Validates the webhook signature (HMAC-SHA256).
   *
   * Fail-closed: a missing `REMNAWAVE_WEBHOOK_SECRET` rejects every request in
   * production, so an unconfigured deployment can never accept unsigned,
   * spoofable webhooks (which drive audit-log / realtime cards and can revive
   * subscriptions). Only a NON-production runtime keeps the permissive
   * "accept all" behaviour, and even then it emits a loud warning so the gap is
   * obvious. The comparison uses `timingSafeEqual` to avoid leaking the
   * expected digest through response-timing side channels.
   */
  public validateSignature(rawBody: string, signature: string | undefined): boolean {
    const secret = this.configuration.webhookSecret;
    if (!secret) {
      if (process.env.NODE_ENV === 'production') {
        // Fail closed: never accept unsigned webhooks in production.
        this.logger.error(
          'Remnawave webhook rejected: REMNAWAVE_WEBHOOK_SECRET is not configured. ' +
            'Set it to the panel\'s WEBHOOK_SECRET_HEADER value — unsigned webhooks are refused in production.',
        );
        return false;
      }
      // Non-production only: accept all so local dev works without a secret.
      this.logger.warn(
        'Remnawave webhook signature check DISABLED: no REMNAWAVE_WEBHOOK_SECRET configured (non-production). ' +
          'All webhook payloads are accepted — do NOT run production this way.',
      );
      return true;
    }
    if (!signature) {
      return false;
    }
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    return timingSafeEqualHex(signature, expected);
  }

  /**
   * Logs a rejected webhook so operators can tell, from the logs, WHY the
   * Activity Feed stays empty: either no signature header arrived (panel not
   * configured / wrong URL) or the secret mismatches (`REMNAWAVE_WEBHOOK_SECRET`
   * ≠ the panel's `WEBHOOK_SECRET_HEADER`).
   */
  public logRejectedSignature(hadSignature: boolean, sourceIp: string | null): void {
    this.logger.warn(
      hadSignature
        ? `Remnawave webhook rejected: signature mismatch (check REMNAWAVE_WEBHOOK_SECRET matches the panel's WEBHOOK_SECRET_HEADER). sourceIp=${sourceIp ?? 'unknown'}`
        : `Remnawave webhook rejected: missing X-Remnawave-Signature header (a webhook secret is configured but the panel sent none). sourceIp=${sourceIp ?? 'unknown'}`,
    );
  }

  /**
   * Processes and stores an incoming webhook event.
   */
  public async handleEvent(
    eventType: string,
    payload: Record<string, unknown>,
    sourceIp: string | null,
  ): Promise<void> {
    // Sanitize payload — remove any sensitive fields
    const sanitized = this.sanitizePayload(payload);

    await this.prismaService.remnawaveWebhookEvent.create({
      data: {
        eventType,
        payload: JSON.parse(JSON.stringify(sanitized)),
        sourceIp,
        isProcessed: false,
      },
    });

    this.logger.log(`Webhook event received: ${eventType}`);

    const normalized = normalizeRemnawaveEventName(eventType);

    // Inbound reconciliation (Remnawave → rezeis): a manual operator edit in
    // the panel (status / expiry / traffic / device limits) raises a user-
    // scoped webhook. Mirror those runtime fields onto the local Subscription
    // so the bot greeting + web/TMA cabinet (which read the DB snapshot) show
    // the change immediately. Best-effort — a reconcile failure must never
    // drop the webhook (Activity Feed + cards still proceed).
    //
    // Echo-safe: this writes ONLY to the local DB and never enqueues a
    // profile-sync push (those are enqueued by subscription mutation services,
    // not by a DB write), so there is no panel↔rezeis loop. Panel is the
    // source of truth for runtime state; rezeis still owns commercial fields
    // (plan snapshot, price, isTrial), which this never touches.
    if (normalized.startsWith('user.')) {
      try {
        await this.reconcileSubscriptionFromEvent(normalized, payload);
      } catch (err: unknown) {
        this.logger.warn(
          `Subscription reconcile failed for ${eventType}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    // Forward curated events to the system-event bus (audit log + realtime +
    // Telegram cards). Unmapped/noisy events are stored only — no Telegram
    // spam. Best-effort: emit() is fire-and-forget and never throws.
    const hasTrafficUsage = normalized.startsWith('user.') && this.hasPositiveTrafficUsage(payload);
    let userContext: LocalUserContext | null = null;
    if (hasTrafficUsage || normalized === 'user.first_connected') {
      try {
        userContext = await this.resolveLocalUserContext(payload);
      } catch (err: unknown) {
        this.logger.warn(
          `Local user lookup failed for ${eventType}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (hasTrafficUsage && userContext !== null) {
      try {
        await this.emitFirstTrafficUsage(eventType, payload, userContext);
      } catch (err: unknown) {
        this.logger.warn(
          `First traffic usage handling failed for ${eventType}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const mapped = REMNAWAVE_WEBHOOK_EVENT_MAP[normalized];
    if (mapped) {
      let metadata = this.extractEventMetadata(eventType, payload);
      if (normalized === 'user.first_connected') {
        metadata = this.enrichUserMetadata(metadata, userContext);
        metadata = await this.enrichConnectionTraffic(metadata);
      }
      this.systemEvents.emit({
        type: mapped.type,
        category: mapped.category,
        severity: mapped.severity,
        message: `Remnawave: ${eventType}`,
        metadata,
      });
    }
  }

  /**
   * Puts the traffic counter on a first-connection card.
   *
   * The card's traffic line is the one that answers the question an operator
   * actually has when a connection lands — is this customer using the service
   * or merely pointed at it — and on `user.first_connected` it was missing:
   * the formatter gates that line on `usedTrafficBytes`, and no counter reached
   * the metadata, so the card showed the profile and said nothing about usage.
   *
   * Deliberately conditional rather than an unconditional read, which makes it
   * correct without having to settle what a given panel version puts in this
   * particular payload: when the webhook carried a counter that number wins —
   * it is contemporaneous with the event, while a REST read races it — and the
   * panel is asked only when there is nothing to show otherwise.
   *
   * Best-effort throughout, because a card is not worth failing a webhook over:
   * `getPanelUserUsage` swallows its own errors and answers `null`, a missing
   * uuid skips the read entirely, and every failure leaves the metadata exactly
   * as it arrived. Cost is one REST read per user per lifetime — the event
   * fires once, by definition.
   *
   * The limit is taken too, but only to fill a gap: without it the line renders
   * as a bare figure with nothing to compare against.
   */
  /**
   * `getPanelUserUsage` under a deadline of its own.
   *
   * `handleEvent` is awaited inside the webhook request (see
   * `AdminRemnawaveController`), so anything slow in here holds the panel's
   * HTTP connection open — and the shared outbound timeout is 45 seconds, which
   * is long enough for Remnawave to give up and redeliver the event. That would
   * trade a decorative traffic line for duplicated webhooks, which is a bad
   * trade at any price.
   *
   * Three seconds because this competes with nothing: the panel is answering
   * from the same host that just called us, so a healthy read is milliseconds,
   * and a read that is not healthy has already told us what we need to know.
   * Losing the race costs the traffic line and nothing else.
   */
  private async readPanelUsageBounded(
    uuid: string,
  ): Promise<Awaited<ReturnType<RemnawaveApiService['getPanelUserUsage']>>> {
    let timer: NodeJS.Timeout | undefined;
    const read = Promise.resolve()
      .then(() => this.remnawaveApiService.getPanelUserUsage(uuid))
      .catch(() => null);
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), PANEL_USAGE_READ_TIMEOUT_MS);
    });
    try {
      return await Promise.race([read, deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async enrichConnectionTraffic(
    metadata: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (typeof metadata['usedTrafficBytes'] === 'number') return metadata;
    const uuid = typeof metadata['remnawaveId'] === 'string' ? metadata['remnawaveId'] : null;
    if (uuid === null || uuid.length === 0) return metadata;

    const usage = await this.readPanelUsageBounded(uuid);
    if (usage === null) {
      this.logger.warn(`First-connection traffic read failed for ${uuid}; card omits the counter`);
      return metadata;
    }
    if (usage.usedTrafficBytes === null) return metadata;

    const enriched = { ...metadata };
    // Zero is a value, not an absence: «0 Б / 100 ГБ» is precisely the answer
    // «connected, nothing used yet», and it is the common case for this event.
    enriched['usedTrafficBytes'] = usage.usedTrafficBytes;
    if (enriched['trafficLimitBytes'] === undefined && usage.trafficLimitBytes !== null) {
      enriched['trafficLimitBytes'] = usage.trafficLimitBytes;
    }
    return enriched;
  }

  /**
   * Reconcile the local `Subscription` snapshot from a user-scoped panel
   * event. Pulls the panel's canonical runtime fields out of the webhook
   * payload (`data`, 2.x) and overlays them onto every non-deleted
   * subscription whose `remnawaveId` matches. Partial: only fields present
   * in the payload are written; status falls back to the event name.
   */
  private async reconcileSubscriptionFromEvent(
    normalizedEvent: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const data =
      payload['data'] !== null && typeof payload['data'] === 'object'
        ? (payload['data'] as Record<string, unknown>)
        : payload;
    const str = (key: string): string | undefined => {
      const v = data[key];
      return typeof v === 'string' && v.length > 0 ? v : undefined;
    };
    const num = (key: string): number | undefined => {
      const v = data[key];
      return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
    };

    const uuid = str('uuid') ?? str('userUuid');
    if (uuid === undefined) return;

    const update: Prisma.SubscriptionUpdateManyMutationInput = {};

    // Status: the panel's canonical `status` wins; otherwise derive it from
    // the event name (user.expired/limited/disabled/enabled).
    const panelStatus = str('status');
    const status =
      (panelStatus !== undefined
        ? PANEL_STATUS_MAP[panelStatus.trim().toUpperCase()]
        : undefined) ?? statusFromEventName(normalizedEvent);
    if (status !== undefined) update.status = status;

    // Expiry: ISO string → Date.
    const expireAt = str('expireAt');
    if (expireAt !== undefined) {
      const parsed = new Date(expireAt);
      if (!Number.isNaN(parsed.getTime())) update.expiresAt = parsed;
    }

    // Traffic limit: panel is bytes (0 = unlimited); local is GB (null =
    // unlimited). Round to the nearest GB, never below 1 for a positive cap.
    const trafficLimitBytes = num('trafficLimitBytes');
    if (trafficLimitBytes !== undefined) {
      update.trafficLimit =
        trafficLimitBytes <= 0 ? null : Math.max(1, Math.round(trafficLimitBytes / 1024 ** 3));
    }

    // Device limit: panel `hwidDeviceLimit` → local `deviceLimit`.
    const deviceLimit = num('hwidDeviceLimit');
    if (deviceLimit !== undefined && deviceLimit >= 0) update.deviceLimit = deviceLimit;

    if (Object.keys(update).length === 0) return;

    const result = await this.prismaService.subscription.updateMany({
      where: { remnawaveId: uuid, status: { not: SubscriptionStatus.DELETED } },
      data: update,
    });
    if (result.count > 0) {
      this.logger.log(
        `Reconciled ${result.count} subscription(s) from panel event ${normalizedEvent} (uuid=${uuid})`,
      );
    }
  }


  /**
   * Coerces panel traffic counters (bytes) from number | numeric string | bigint
   * into a finite JS number. Mirrors remnawave-api.service coerceTrafficNumber so
   * JSON-stringified webhooks still trigger first-traffic cards.
   */
  private coerceTrafficNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'bigint') {
      // Only accept values that fit safely in Number (panel counters are far below).
      if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
        return null;
      }
      return Number(value);
    }
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value.trim());
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  /**
   * Reads the panel's *used* traffic counter (bytes) out of a webhook `data`
   * object — NESTED SHAPE FIRST.
   *
   * `RemnawaveWebhookUserEventsDto.data` declares no top-level
   * `usedTrafficBytes` in EITHER supported version: 2.7.4 and 2.8.0 both put
   * the counter inside the required `userTraffic` container, as
   * `data.userTraffic.usedTrafficBytes`. Probing only the flat spelling
   * therefore read `undefined` out of every real payload and silently
   * disabled both consumers of this value — `User.firstTrafficAt` (nothing
   * else writes that column) was never claimed, and `meta.usedTrafficBytes`
   * was never set, so the card formatter's `typeof … === 'number'` gate
   * dropped the traffic line from every Remnawave card, including
   * `user.bandwidth_usage_threshold_reached`, whose entire purpose is
   * reporting consumption.
   *
   * Probe order mirrors the REST reader
   * (`RemnawaveApiService.getPanelUserUsage`) rather than inventing a second
   * convention. The flat spellings are kept as a trailing fallback —
   * they match nothing either spec sends, but they cost nothing and keep any
   * relayed/flattened payload working.
   */
  private readUsedTrafficBytes(data: Record<string, unknown>): number | null {
    const nested = data['userTraffic'];
    if (nested !== null && typeof nested === 'object') {
      const parsed = this.coerceTrafficNumber(
        (nested as Record<string, unknown>)['usedTrafficBytes'],
      );
      if (parsed !== null) return parsed;
    }
    return (
      this.coerceTrafficNumber(data['usedTrafficBytes']) ??
      this.coerceTrafficNumber(data['usedTraffic'])
    );
  }

  /** Returns whether a user webhook reports a positive traffic consumption value. */
  private hasPositiveTrafficUsage(payload: Record<string, unknown>): boolean {
    const data =
      payload['data'] !== null && typeof payload['data'] === 'object'
        ? (payload['data'] as Record<string, unknown>)
        : payload;
    const usedTraffic = this.readUsedTrafficBytes(data);
    return usedTraffic !== null && usedTraffic > 0;
  }

  private async resolveLocalUserContext(payload: Record<string, unknown>): Promise<LocalUserContext | null> {
    const metadata = this.extractEventMetadata('user.context', payload);
    const remnawaveId = typeof metadata['remnawaveId'] === 'string' ? metadata['remnawaveId'] : null;
    const telegramId = typeof metadata['telegramId'] === 'string' ? metadata['telegramId'] : null;

    if (remnawaveId !== null) {
      const subscription = await this.prismaService.subscription.findFirst({
        where: { remnawaveId, status: { not: SubscriptionStatus.DELETED } },
        orderBy: { updatedAt: 'desc' },
        select: {
          id: true,
          status: true,
          trafficLimit: true,
          deviceLimit: true,
          expiresAt: true,
          user: { select: { id: true, telegramId: true, name: true, username: true } },
        },
      });
      if (subscription !== null) return { user: subscription.user, subscription };
    }

    if (telegramId === null || !/^\d+$/.test(telegramId)) return null;
    const user = await this.prismaService.user.findUnique({
      where: { telegramId: BigInt(telegramId) },
      select: { id: true, telegramId: true, name: true, username: true },
    });
    return user === null ? null : { user, subscription: null };
  }

  private async emitFirstTrafficUsage(
    eventType: string,
    payload: Record<string, unknown>,
    context: LocalUserContext,
  ): Promise<void> {
    const claimed = await this.prismaService.user.updateMany({
      where: { id: context.user.id, firstTrafficAt: null },
      data: { firstTrafficAt: new Date() },
    });
    if (claimed.count !== 1) return;

    this.systemEvents.info(
      EVENT_TYPES.USER_FIRST_TRAFFIC,
      'USER',
      'User started using traffic',
      this.enrichUserMetadata(this.extractEventMetadata(eventType, payload), context),
    );
  }

  private enrichUserMetadata(
    metadata: Record<string, unknown>,
    context: LocalUserContext | null,
  ): Record<string, unknown> {
    if (context === null) return metadata;

    const enriched = { ...metadata };
    enriched['userId'] = context.user.id;
    if (context.user.telegramId !== null) enriched['telegramId'] = context.user.telegramId.toString();
    if (context.user.name) enriched['userName'] = context.user.name;
    if (context.user.username) enriched['username'] = context.user.username;

    if (context.subscription !== null) {
      enriched['subscriptionId'] = context.subscription.id;
      enriched['status'] = context.subscription.status;
      enriched['deviceLimit'] = context.subscription.deviceLimit;
      if (context.subscription.expiresAt !== null) enriched['expireAt'] = context.subscription.expiresAt.toISOString();
      if (enriched['trafficLimitBytes'] === undefined && context.subscription.trafficLimit !== null) {
        enriched['trafficLimitBytes'] = context.subscription.trafficLimit * 1024 ** 3;
      }
    }
    return enriched;
  }

  /**
   * Maps a raw Remnawave webhook payload onto the card metadata keys the
   * formatter understands. Reads from `payload.data` (2.x) with a flat
   * fallback, plus the envelope `payload.meta`. Only documented,
   * non-sensitive fields are surfaced.
   */
  private extractEventMetadata(
    eventType: string,
    payload: Record<string, unknown>,
  ): Record<string, unknown> {
    const data =
      payload['data'] !== null && typeof payload['data'] === 'object'
        ? (payload['data'] as Record<string, unknown>)
        : payload;
    const str = (key: string): string | undefined => {
      const v = data[key];
      return typeof v === 'string' && v.length > 0 ? v : undefined;
    };
    const num = (key: string): number | undefined => {
      const v = data[key];
      return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
    };

    const meta: Record<string, unknown> = { remnawaveEvent: eventType, source: 'REMNAWAVE_WEBHOOK' };

    // User-scoped fields
    const username = str('username');
    if (username) meta['remnawaveUsername'] = username;
    const uuid = str('uuid') ?? str('userUuid');
    if (uuid) meta['remnawaveId'] = uuid;
    const telegramId = str('telegramId') ?? (num('telegramId') !== undefined ? String(num('telegramId')) : undefined);
    if (telegramId) meta['telegramId'] = telegramId;
    const expireAt = str('expireAt');
    if (expireAt) meta['expireAt'] = expireAt;
    const trafficLimit =
      this.coerceTrafficNumber(data['trafficLimitBytes']) ?? num('trafficLimitBytes') ?? null;
    if (trafficLimit !== null) meta['trafficLimitBytes'] = trafficLimit;
    const usedTraffic = this.readUsedTrafficBytes(data);
    if (usedTraffic !== null) meta['usedTrafficBytes'] = usedTraffic;

    // Envelope `meta` — the ONLY part of the payload outside `data` that
    // carries card detail, and the only reason this method looks at the root.
    //
    // 2.8.0 collapsed 2.7.4's four expiry-warning event names into a single
    // `user.expiration` and moved the distinguishing number out of the event
    // name into `meta.expiration` (`number | null`). Mapping the name alone
    // would therefore drop the one field that says WHICH warning fired. The
    // event still renders usefully without it — `data.expireAt` is required in
    // both versions and already feeds the card's expiry line — so this is
    // added detail, not the whole card.
    //
    // Surfaced under a prefixed key without a unit in the name: neither spec
    // documents what the number counts, so naming it `…Hours` would be a
    // guess. 2.7.4's `meta` has no `expiration` property at all, which makes
    // this read a no-op on that version. Read-only, like the rest of this
    // method — the raw payload must stay untouched for the reconcile path.
    const envelopeMeta = payload['meta'];
    if (envelopeMeta !== null && typeof envelopeMeta === 'object' && !Array.isArray(envelopeMeta)) {
      const expiration = (envelopeMeta as Record<string, unknown>)['expiration'];
      if (typeof expiration === 'number' && Number.isFinite(expiration)) {
        meta['remnawaveExpiration'] = expiration;
      }
    }

    // Node-scoped fields
    const nodeName = str('name') ?? str('nodeName');
    if (nodeName && eventType.toLowerCase().includes('node')) meta['nodeName'] = nodeName;
    const nodeUuid = str('nodeUuid');
    if (nodeUuid) meta['nodeUuid'] = nodeUuid;
    else if (eventType.toLowerCase().includes('node') && uuid) meta['nodeUuid'] = uuid;
    const countryCode = str('countryCode');
    if (countryCode) meta['countryCode'] = countryCode;
    const address = str('address');
    if (address && eventType.toLowerCase().includes('node')) meta['nodeAddress'] = address;

    return meta;
  }

  /**
   * Returns recent webhook events for the Activity Feed.
   */
  public async getRecentEvents(limit = 50): Promise<WebhookEventSummary[]> {
    const events = await this.prismaService.remnawaveWebhookEvent.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        eventType: true,
        payload: true,
        createdAt: true,
        isProcessed: true,
      },
    });

    return events.map((e) => ({
      id: e.id,
      eventType: e.eventType,
      payload: e.payload as Record<string, unknown>,
      createdAt: e.createdAt.toISOString(),
      isProcessed: e.isProcessed,
    }));
  }

  /**
   * Removes sensitive fields from webhook payloads before storage.
   *
   * Allow-list based and applied at EVERY depth — `WEBHOOK_PAYLOAD_ALLOWED_KEYS`
   * carries the rule and the reasoning, read it before adding a field.
   *
   * The previous version deleted four hard-coded ROOT keys, which stripped
   * nothing whatsoever: Remnawave nests the user object under `data` (and
   * under `data.user` for hwid-device and torrent-blocker events), so every
   * credential sat one or two levels below the keys being deleted and went
   * into the column, and out to the Activity Feed, in plaintext.
   */
  private sanitizePayload(payload: Record<string, unknown>): Record<string, unknown> {
    return redactToAllowedKeys(payload) as Record<string, unknown>;
  }
}

export interface WebhookEventSummary {
  readonly id: string;
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
  readonly isProcessed: boolean;
}

/**
 * Constant-time comparison of two hex-encoded digests. Falls back to a plain
 * (still constant-time) `false` when the candidate is not a same-length hex
 * string, so a malformed signature header can't throw or leak length via an
 * exception path.
 */
function timingSafeEqualHex(candidate: string, expected: string): boolean {
  if (candidate.length !== expected.length) {
    return false;
  }
  let candidateBuf: Buffer;
  let expectedBuf: Buffer;
  try {
    candidateBuf = Buffer.from(candidate, 'hex');
    expectedBuf = Buffer.from(expected, 'hex');
  } catch {
    return false;
  }
  if (candidateBuf.length !== expectedBuf.length || candidateBuf.length === 0) {
    return false;
  }
  return timingSafeEqual(candidateBuf, expectedBuf);
}
