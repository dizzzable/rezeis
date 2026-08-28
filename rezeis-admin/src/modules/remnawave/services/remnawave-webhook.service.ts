import { Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Inject } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Prisma, SubscriptionStatus } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { remnawaveConfig } from '../../../common/config/remnawave.config';
import { patchSnapshotNumeric } from '../../subscriptions/services/plan-inherited-limits.util';
import { isNumericPanelIdentity } from './panel-user-address';
import {
  EVENT_TYPES,
  SystemEventsService,
  type SystemEventCategory,
  type SystemEventSeverity,
} from '../../../common/services/system-events.service';
import { UserNotificationsService } from '../../notifications/services/user-notifications.service';
import { RemnawaveApiService } from './remnawave-api.service';
import { SubscriptionNoticePayloadService } from './subscription-notice-payload.service';
import { panelTrafficLimitToGb } from '../utils/panel-traffic-limit.util';

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
 * A panel id as it may appear in webhook JSON: decimal digits and nothing else.
 * No sign, no separators, no exponent — the very shape `isNumericPanelIdentity`
 * (`panel-user-address.ts`) uses to tell a stored 3.x id from a 2.x uuid. The
 * identity minted below is later classified by THAT predicate, so a string this
 * one accepted but that one would not (`-5`, `1e3`, `12.0`) would be addressed
 * to a 3.x panel as though it were a uuid.
 */
const DECIMAL_PANEL_ID = /^\d+$/;

/**
 * Coerces a numeric panel id out of untrusted webhook JSON.
 *
 * A number OR a decimal string, because a webhook body is whatever the sender
 * serialized: a 3.x panel sends `id` as a JSON number, but a relay or queue hop
 * that round-trips the body through a string-typed store hands it back quoted,
 * and refusing those would take the identity away again for no reason.
 *
 * The digits-only test is doing the real work here.
 * `Number.parseInt('330f2b38-9c41-…')` answers `330` — a valid-LOOKING id that
 * belongs to a different customer — so a uuid-shaped string in the id slot has
 * to be REFUSED, never parsed. Testing the whole trimmed string first and only
 * then converting makes that impossible; it also rejects `''`, which `Number()`
 * would otherwise turn into `0`, i.e. into somebody's id.
 */
function readNumericPanelId(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!DECIMAL_PANEL_ID.test(trimmed)) return null;
  const parsed = Number(trimmed);
  // Past 2^53 the decimal text and the number stop agreeing, so the id we would
  // mint is not the id the panel sent.
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Reads the panel user's identity out of a webhook payload, in EXACTLY the form
 * `Subscription.remnawaveId` holds it — a 2.x UUID, or a 3.x numeric id in
 * decimal. Every consumer in this file compares the result against that column
 * (`reconcileSubscriptionFromEvent`'s `updateMany`, `resolveLocalUserContext`'s
 * `findFirst`, and through it the first-connection panel read), so a value in
 * any other shape names nobody and each of them silently does nothing.
 *
 * WHICH KEY IS THE IDENTITY depends on the panel era, and the payload itself
 * says which — the same rule, for the same reason, as `parsePanelUserRow` and
 * `parseStrictUser` in `remnawave-api.service.ts`:
 *   • `uuid` present → 2.7.4 / 2.8.x. That is the identity.
 *   • `uuid` ABSENT  → 3.x, which deleted the column outright and re-keyed every
 *                      user on the numeric `id`; no payload from such a panel
 *                      carries a uuid anywhere. The identity is `String(id)`.
 *
 * The test is ABSENCE (`=== undefined`), never emptiness, and collapsing the two
 * costs a customer: a 2.x payload whose `uuid` came back `''` (or null, or a
 * number) is DAMAGED, and falling back to its numeric id there would mint a key
 * that matches no `remnawaveId` stored in that era — turning "we could not read
 * this event" into "this event is about 4821", who is somebody else. Damaged
 * stays unidentified.
 *
 * Before this the read was `str('uuid') ?? str('userUuid')`, which a 3.x payload
 * satisfies neither half of, so the identity was simply never set and all three
 * consumers no-opped with no error and no log — an Activity Feed that filled
 * while nothing reconciled.
 */
/**
 * The `where` that finds the local row a panel event is about.
 *
 * `remnawaveId` alone is not enough, and the gap is the mirror image of the one
 * `panelUserAddress` closes outbound. A profile created on 2.x keeps its uuid in
 * `remnawaveId` after the operator upgrades to 3.x — the panel's migration drops
 * the uuid, we do not — but from then on the panel's events carry only the
 * numeric `id`. Matching on `remnawaveId` alone would miss that row on every
 * event, silently, for the rest of its life.
 *
 * `remnawavePanelId` is the second recorded angle on the SAME identity, so
 * adding it widens the match without loosening it — this is not a fuzzy search.
 * The numeric arm is added only when the identity is entirely digits: without
 * that test `Number.parseInt('330f2b38-…')` yields `330`, a valid-looking id
 * belonging to somebody else.
 */
export function panelIdentityWhere(identity: string): Prisma.SubscriptionWhereInput {
  if (!isNumericPanelIdentity(identity)) return { remnawaveId: identity };
  const panelId = Number.parseInt(identity, 10);
  if (!Number.isSafeInteger(panelId)) return { remnawaveId: identity };
  return { OR: [{ remnawaveId: identity }, { remnawavePanelId: panelId }] };
}

function readWebhookPanelIdentity(payload: Record<string, unknown>): string | null {
  const data =
    payload['data'] !== null && typeof payload['data'] === 'object'
      ? (payload['data'] as Record<string, unknown>)
      : payload;
  // `userUuid` is the legacy spelling and stands in only when `uuid` is not a
  // key at all, so a damaged `uuid` cannot be rescued by it either.
  const uuidSlot = data['uuid'] !== undefined ? data['uuid'] : data['userUuid'];
  if (uuidSlot !== undefined) {
    return typeof uuidSlot === 'string' && uuidSlot.length > 0 ? uuidSlot : null;
  }
  const numericId = readNumericPanelId(data['id']) ?? readNumericPanelId(data['userId']);
  return numericId === null ? null : String(numericId);
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
    /**
     * The two halves of telling a customer their traffic ran out.
     *
     * This service is the ONLY thing that can know it: a traffic limit is
     * reached by usage, not by the clock, so no scheduled pass can notice it
     * — the panel says so and nothing else does.
     */
    private readonly noticePayload: SubscriptionNoticePayloadService,
    private readonly userNotifications: UserNotificationsService,
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
      // Attribution first, and out loud. Everything below keys the local
      // profile off the panel identity, and when that cannot be read they ALL
      // do nothing: reconcile returns, the reverse lookup finds no
      // subscription, the first-connection card omits its traffic counter —
      // three no-ops with no error and no log between them. That silence is
      // precisely what hid a whole panel version (3.x sends no `uuid`, and the
      // extractor only looked for one) until someone noticed by hand. One warn
      // naming the event is what makes the next such gap visible on day one.
      // Emitted once per webhook, here rather than in each consumer, so a
      // damaged payload costs one line and not three.
      if (readWebhookPanelIdentity(payload) === null) {
        this.logger.warn(
          `Remnawave webhook ${eventType}: no panel user identity in the payload ` +
            '(no uuid key, and no usable numeric id) — reconcile and the local user lookup are skipped',
        );
      }
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
   * `getPanelUserUsage` swallows its own errors and answers `null`, an
   * unidentified payload skips the read entirely, and every failure leaves the
   * metadata exactly as it arrived. Cost is one REST read per user per lifetime
   * — the event fires once, by definition.
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
    remnawaveId: string,
  ): Promise<Awaited<ReturnType<RemnawaveApiService['getPanelUserUsage']>>> {
    let timer: NodeJS.Timeout | undefined;
    const read = Promise.resolve()
      .then(() => this.remnawaveApiService.getPanelUserUsage(remnawaveId))
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
    // Whatever `extractEventMetadata` could name the profile by — a 2.x uuid or
    // a 3.x numeric id. `getPanelUserUsage` takes a stored `remnawaveId` and
    // builds the address for the panel's own era, so both forms are routable.
    const remnawaveId =
      typeof metadata['remnawaveId'] === 'string' ? metadata['remnawaveId'] : null;
    if (remnawaveId === null || remnawaveId.length === 0) return metadata;

    const usage = await this.readPanelUsageBounded(remnawaveId);
    if (usage === null) {
      this.logger.warn(
        `First-connection traffic read failed for ${remnawaveId}; card omits the counter`,
      );
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

    // 2.x uuid or 3.x numeric id, whichever this payload's era provides — see
    // `readWebhookPanelIdentity`. This is matched against `remnawaveId` below,
    // so it must be the string that column holds and nothing else.
    const remnawaveId = readWebhookPanelIdentity(payload);
    if (remnawaveId === null) return;

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
    // unlimited). `panelTrafficLimitToGb` is the single rule every writer of
    // this column shares — nearest GB, never below 1 for a positive cap.
    //
    // The mirrored limits are tracked in their own variables as well as in
    // `update`, because they are written into `planSnapshot` too (see below)
    // and `SubscriptionUpdateManyMutationInput` types them as field-operation
    // objects, not as the plain values the snapshot needs.
    let mirroredTrafficLimit: number | null | undefined;
    let mirroredDeviceLimit: number | undefined;

    const trafficLimitBytes = num('trafficLimitBytes');
    if (trafficLimitBytes !== undefined) {
      mirroredTrafficLimit = panelTrafficLimitToGb(trafficLimitBytes);
      update.trafficLimit = mirroredTrafficLimit;
    }

    // Device limit: panel `hwidDeviceLimit` → local `deviceLimit`.
    const deviceLimit = num('hwidDeviceLimit');
    if (deviceLimit !== undefined && deviceLimit >= 0) {
      mirroredDeviceLimit = deviceLimit;
      update.deviceLimit = mirroredDeviceLimit;
    }

    if (Object.keys(update).length === 0) return;

    // ── A panel-side limit change is recorded, but it does not outrank the plan
    //
    // The tension is real and both halves matter. A limit set directly in
    // Remnawave IS a fact about what the customer experiences right now, so we
    // record it — refusing to would leave our row lying about live service.
    // But it is not an INSTRUCTION: rezeis is the authority and the panel
    // mirrors it, so an edit made on the panel side must not silently outrank
    // the plan the customer is paying us for.
    //
    // Both are satisfied by moving `planSnapshot` with the column. That leaves
    // the two in step, which `resolveInheritedPlanLimitUpdate` reads as
    // INHERITED, so the customer's next renewal puts the plan's own limit back
    // and the panel-side drift dies there. Write the column alone and it
    // diverges from the snapshot, reads as a deliberate operator override, and
    // survives every renewal from then on.
    //
    // Only the fields this event actually stated are touched — in the columns
    // and in the baseline alike. A payload that carried no limit must never
    // make us adopt one, and must not cost a snapshot read either: the columns
    // keep going out on the single `updateMany` this mirror has always used,
    // and the baseline pass below is skipped entirely.
    const mirrorsALimit = mirroredTrafficLimit !== undefined || mirroredDeviceLimit !== undefined;
    const where = {
      ...panelIdentityWhere(remnawaveId),
      status: { not: SubscriptionStatus.DELETED },
    };

    // Read BEFORE the write, and only when this event is the one that can
    // produce a notice. The question is whether the subscription CROSSED
    // into LIMITED, and after the update every row reads LIMITED whether it
    // just got there or has been there for a week — Remnawave repeats the
    // event, so notifying on the post-state would notify on every repeat.
    const beforeLimited =
      update.status === SubscriptionStatus.LIMITED
        ? await this.prismaService.subscription.findMany({
            where,
            select: { ...SubscriptionNoticePayloadService.SELECT, userId: true, status: true },
          })
        : [];

    const result = await this.prismaService.subscription.updateMany({ where, data: update });

    // ONE MESSAGE PER CUSTOMER, not one per row.
    //
    // `panelIdentityWhere` matches `remnawaveId` OR `remnawavePanelId`, and
    // `remnawaveId` carries no unique constraint — the schema says so in as
    // many words, and `stale-panel-link.ts` names the duplicate pairs the old
    // importer produced as a live production state. A customer holding two
    // rows for one panel profile would therefore be told twice, by one
    // webhook, that their traffic ran out. The expiry emitters already dedup
    // per user; this one did not.
    const notified = new Set<string>();
    for (const subscription of beforeLimited) {
      if (subscription.status === SubscriptionStatus.LIMITED) continue;
      if (notified.has(subscription.userId)) continue;
      notified.add(subscription.userId);
      await this.notifyTrafficLimited(subscription);
    }

    // Additive second pass, never a replacement for the write above. It exists
    // only to move `planSnapshot` to wherever the columns just landed, and it
    // writes nothing else.
    //
    // KNOWN LIMIT, accepted: this is a read-modify-write on the JSON with no
    // row lock, so two panel events for the same profile arriving together can
    // clobber each other's key. Doing it in one statement means
    // `UPDATE … SET plan_snapshot = plan_snapshot || …`, which needs
    // `panelIdentityWhere`'s predicate restated in raw SQL — a THIRD expression
    // of "which row does this panel identity name", after this one and
    // `panel-user-address.ts`'s plural sibling. A stale limit that the next
    // renewal corrects anyway is the smaller hazard than a divergent identity
    // predicate, which would silently reconcile the wrong customer.
    if (result.count > 0 && mirrorsALimit) {
      const targets = await this.prismaService.subscription.findMany({
        where,
        select: { id: true, planSnapshot: true },
      });
      for (const target of targets) {
        let planSnapshot = target.planSnapshot as unknown;
        if (mirroredTrafficLimit !== undefined) {
          planSnapshot = patchSnapshotNumeric(planSnapshot, 'trafficLimit', mirroredTrafficLimit);
        }
        if (mirroredDeviceLimit !== undefined) {
          planSnapshot = patchSnapshotNumeric(planSnapshot, 'deviceLimit', mirroredDeviceLimit);
        }
        await this.prismaService.subscription.update({
          where: { id: target.id },
          data: { planSnapshot: planSnapshot as Prisma.InputJsonValue },
        });
      }
    }

    if (result.count > 0) {
      this.logger.log(
        `Reconciled ${result.count} subscription(s) from panel event ${normalizedEvent} (remnawaveId=${remnawaveId})`,
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
        where: { ...panelIdentityWhere(remnawaveId), status: { not: SubscriptionStatus.DELETED } },
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

  /**
   * Tells the customer their traffic limit was reached.
   *
   * ── Why this lives here and nowhere else ─────────────────────────────
   *
   * The `limited` template has shipped since the bot-map module landed —
   * editable, toggleable, with its own buttons, wired into the notification
   * target resolver — and nothing ever created one. It could not have: a
   * traffic limit is reached by usage, so there is no clock a scheduled pass
   * could watch. The panel is the only party that knows, and this is where
   * the panel tells us.
   *
   * ── Best-effort, deliberately ────────────────────────────────────────
   *
   * The webhook's job is to reconcile our row with the panel, and that has
   * already happened by the time this runs. A notification that fails must
   * not fail the reconciliation — the customer would then keep a row saying
   * ACTIVE while their access is restricted, which is a worse wrong than a
   * missing message.
   */
  private async notifyTrafficLimited(subscription: {
    readonly id: string;
    readonly userId: string;
    readonly expiresAt: Date | null;
    readonly planSnapshot: unknown;
    readonly trafficLimit: number | null;
    readonly deviceLimit: number;
    readonly remnawaveId: string | null;
    readonly remnawavePanelId: number | null;
    readonly remnawavePanelUsername: string | null;
  }): Promise<void> {
    try {
      const payload = await this.noticePayload.build(subscription, { daysLeft: 0 });
      await this.userNotifications.create({
        userId: subscription.userId,
        type: 'limited',
        payload,
      });
      this.logger.log(`Traffic-limit notice created for subscription ${subscription.id}`);
    } catch (err) {
      this.logger.warn(
        `Traffic-limit notice failed for ${subscription.id}: ${(err as Error).message}`,
      );
    }
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
    // Panel identity, in the shape `Subscription.remnawaveId` holds — on a 3.x
    // panel that is the numeric `id`, because there is no uuid to be had (see
    // `readWebhookPanelIdentity`).
    //
    // Node-scoped events deliberately keep the OLD, uuid-only read. A node row
    // still carries a `uuid` in every supported version (3.2.x `NodesSchema`
    // declares one next to its `id`), so the numeric fallback has nothing to do
    // there — and it must not fire: this key is compared against
    // `Subscription.remnawaveId`, where node `id: 12` and customer `id: 12` are
    // the same string, and a malformed node event would otherwise name a
    // customer chosen by coincidence.
    const isNodeEvent = eventType.toLowerCase().includes('node');
    const identity = isNodeEvent ? uuid ?? null : readWebhookPanelIdentity(payload);
    if (identity !== null) meta['remnawaveId'] = identity;
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
    if (nodeName && isNodeEvent) meta['nodeName'] = nodeName;
    const nodeUuid = str('nodeUuid');
    if (nodeUuid) meta['nodeUuid'] = nodeUuid;
    else if (isNodeEvent && uuid) meta['nodeUuid'] = uuid;
    const countryCode = str('countryCode');
    if (countryCode) meta['countryCode'] = countryCode;
    const address = str('address');
    if (address && isNodeEvent) meta['nodeAddress'] = address;

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
