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
export interface TelegramDeliveryConfigShape {
  readonly enabled: boolean;
  readonly chatId: string | null;
  readonly devChatId: string | null;
  readonly topicMap: Record<string, number | null>;
  readonly defaultTopicId: number | null;
  /** Optional topic that ALL ERROR-severity events route to, regardless of category. */
  readonly errorTopicId: number | null;
}

export interface TelegramEventFilterShape {
  /** `all` = deliver every event; `selected` = only types in `events`. */
  readonly eventsMode: 'all' | 'selected';
  readonly events: readonly string[];
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
 */
export function isEventTelegramAllowed(
  eventType: string,
  filter: TelegramEventFilterShape,
): boolean {
  if (eventType === 'settings.telegram.test') return true;
  if (filter.eventsMode !== 'selected') return true;
  return filter.events.includes(eventType);
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
    // ERROR severity gets its own dedicated topic when configured, so error
    // logs land in one place regardless of which category raised them.
    const errorRoute =
      event.severity === 'ERROR' && config.errorTopicId !== null ? config.errorTopicId : null;
    return {
      chatId: config.chatId,
      topicId: errorRoute ?? config.topicMap[event.category] ?? config.defaultTopicId ?? null,
      isDevFallback: false,
    };
  }
  if (config.devChatId !== null) {
    return { chatId: config.devChatId, topicId: null, isDevFallback: true };
  }
  return null;
}
