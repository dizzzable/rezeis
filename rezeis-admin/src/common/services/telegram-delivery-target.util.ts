/**
 * Pure resolver for the system-events Telegram delivery target.
 *
 * Delivery rules (screen "Доставка в Telegram"):
 *   1. PRIMARY — when delivery is enabled AND a `chatId` is set, send to that
 *      group/channel. Topic = per-category override → default topic → null
 *      (general chat). An optional `events` allow-list filters which event
 *      types are forwarded (empty = all).
 *   2. DEV FALLBACK — when the primary group is NOT configured (disabled or no
 *      `chatId`), every event is delivered to the operator's personal
 *      `devChatId` DM via the SAME bot token (i.e. the reiwa bot), with no
 *      topic routing and no event filter. A bot DM is visible only to that
 *      dev/operator — matching "видны только для dev пользователя".
 *   3. NONE — neither a primary chat nor a dev chat is configured → no Telegram
 *      delivery (the event still persists to the audit log + realtime).
 *
 * Extracted as a pure function so the fallback contract is unit-testable and
 * can't silently regress.
 */
import { isErrorReportEvent } from './error-report.util';

export interface TelegramDeliveryConfigShape {
  readonly enabled: boolean;
  readonly chatId: string | null;
  readonly devChatId: string | null;
  readonly topicMap: Record<string, number | null>;
  readonly defaultTopicId: number | null;
  /**
   * Optional topic that every error report routes to, regardless of category —
   * the events `isErrorReportEvent` names, which is also what decides that the
   * card is an incident card with a `.txt`.
   */
  readonly errorTopicId: number | null;
}

/**
 * Sentinel entry in the operator's `events` allow-list meaning "and everything
 * whose type is not in this list".
 *
 * Two producers pick their event type at RUNTIME and can therefore never be
 * registered, presented or ticked:
 *
 *   * the automations `system_event` action — the operator writes the string
 *     into the rule's action params;
 *   * the reiwa ingest (`POST /api/internal/events`) — `type` is a free
 *     `@IsString()` field on `ReceiveSystemEventDto`.
 *
 * `selected` mode is an exact-match allow-list, so before this sentinel existed
 * neither could be delivered at all — not "delivered untitled", not delivered.
 * A tick-box per type cannot fix that, because the string does not exist until
 * it fires; this is the only form of consent an operator can give in advance.
 *
 * Leading `*` is deliberately outside the event-type grammar
 * (`[a-z][a-z0-9_]*(\.[a-z0-9_]+)+`) so it can never collide with a real type,
 * and its ABSENCE is "off" — no stored selection can acquire it by accident.
 */
export const UNREGISTERED_EVENTS_SENTINEL = '*unregistered';

export interface TelegramEventFilterShape {
  /** `all` = deliver every event; `selected` = only types in `events`. */
  readonly eventsMode: 'all' | 'selected';
  readonly events: readonly string[];
  /**
   * Every event type the operator's page can draw a tick-box for — i.e. the
   * values of `EVENT_TYPES`, which `test/system-event-registry.spec.ts` holds
   * equal to the SPA catalogue in both directions.
   *
   * Required rather than optional: the catch-all below must apply to exactly
   * the types an operator could NOT have ticked, so a caller that forgets to
   * pass this set would silently turn the catch-all into "deliver everything".
   * Omitting it is a compile error instead.
   */
  readonly knownTypes: ReadonlySet<string>;
}

/**
 * Authoritative gate: may this event be delivered to Telegram at all?
 *
 * Applies to EVERY Telegram path (operator group, reiwa relay, AND the dev-DM
 * fallback) — when an event type is not selected it goes nowhere on Telegram,
 * not even the dev bot. The rezeis panel still records every event (audit log
 * + realtime) regardless of this gate.
 *
 * The manual delivery test (`settings.telegram.test`) always passes — it's an
 * explicit operator action, not part of the event firehose.
 *
 * A REGISTERED type is delivered if and only if it was ticked, exactly as
 * before — the catch-all cannot widen it, because the operator was offered a
 * tick-box for it and did not tick it. Only a type outside `knownTypes` can
 * fall through to `UNREGISTERED_EVENTS_SENTINEL`.
 *
 * The one exception is {@link DELIVERED_WITH}: a type split out of another is
 * also delivered to whoever ticked the one it came from.
 */
export function isEventTelegramAllowed(
  eventType: string,
  filter: TelegramEventFilterShape,
): boolean {
  if (eventType === 'settings.telegram.test') return true;
  if (filter.eventsMode !== 'selected') return true;
  if (filter.events.includes(eventType)) return true;
  if ((DELIVERED_WITH.get(eventType) ?? []).some((origin) => filter.events.includes(origin))) return true;
  if (filter.knownTypes.has(eventType)) return false;
  return filter.events.includes(UNREGISTERED_EVENTS_SENTINEL);
}

/**
 * Types split out of another, delivered in `selected` mode to an operator who
 * ticked either. A saved selection never ticks a new type, so without this the
 * split would silence the operators who asked for the cards it used to be.
 *
 * `payment.withheld` was raised as a WARNING `payment.completed` («Платёж
 * получен, нужна проверка») until it got a type of its own, so everyone who
 * ticked `payment.completed` keeps getting it. Its refund was raised as
 * `payment.refunded` or `payment.refund_partial`, so those two keep reaching
 * it too — and whoever follows `payment.withheld` hears how it ended.
 */
export const DELIVERED_WITH: ReadonlyMap<string, readonly string[]> = new Map([
  ['payment.withheld', ['payment.completed']],
  ['payment.withheld_refunded', ['payment.refunded', 'payment.refund_partial', 'payment.withheld']],
]);

/**
 * The forum topic an event's category is mapped to.
 *
 * AUTOMATION — whatever a rule's `system_event` emits — falls back to SYSTEM's
 * topic while it has none of its own: those events were filed under SYSTEM
 * until they got a category of their own, and the screen that maps topics
 * offers no AUTOMATION row, so an operator's forum keeps receiving them where
 * it always did.
 */
function topicFor(
  topicMap: Readonly<Record<string, number | null>>,
  category: string,
): number | null | undefined {
  const own = topicMap[category];
  if (own !== undefined && own !== null) return own;
  return category === 'AUTOMATION' ? topicMap['SYSTEM'] : own;
}

export interface TelegramDeliveryTarget {
  readonly chatId: string;
  readonly topicId: number | null;
  /** `true` when this resolved via the dev-DM fallback (no primary chat). */
  readonly isDevFallback: boolean;
}

export function resolveTelegramDeliveryTarget(
  config: TelegramDeliveryConfigShape,
  event: { readonly type: string; readonly category: string; readonly severity?: string },
): TelegramDeliveryTarget | null {
  const primaryActive = config.enabled && config.chatId !== null;
  if (primaryActive && config.chatId !== null) {
    // Error reports get their own dedicated topic when configured, so they
    // land in one place regardless of which category raised them.
    //
    // The SAME predicate the card renderer uses, not a second opinion on it.
    // This line used to test `severity === 'ERROR'` while the renderer also
    // counted a `*.error` type at WARNING, so `client.error` — always WARNING —
    // arrived as an incident card with its `.txt` in the category topic.
    const errorRoute =
      isErrorReportEvent(event) && config.errorTopicId !== null ? config.errorTopicId : null;
    return {
      chatId: config.chatId,
      topicId: errorRoute ?? topicFor(config.topicMap, event.category) ?? config.defaultTopicId ?? null,
      isDevFallback: false,
    };
  }
  if (config.devChatId !== null) {
    return { chatId: config.devChatId, topicId: null, isDevFallback: true };
  }
  return null;
}
