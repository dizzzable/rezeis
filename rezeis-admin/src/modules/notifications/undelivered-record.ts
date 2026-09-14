import { chainDepthMetadata } from '../automations/chain-depth';
import { BROADCAST_CHANNEL_EVENT_PREFIX } from '../broadcast/broadcast.constants';
import type { ReiwaRelayEvent } from './reiwa-relay.constants';
import type { NotifyDeliveryResult } from './services/bot-notifier.client';
import type { TelegramDirectJobData } from './telegram-direct.constants';
import { describeTelegramOutcome, type TelegramDirectResult } from './telegram-direct.outcome';

/**
 * The record of a send nothing will try again
 * ═══════════════════════════════════════════
 * Two roads end in "not delivered, and nothing else is coming": a queued job
 * that ran out of attempts, and the single direct attempt a producer makes
 * when Redis will not take the job at all. They used to leave very different
 * traces. The first wrote a system event — an `AdminAuditLog` row, the realtime
 * card, the operator's Telegram card. The second wrote a `logger.warn` into an
 * in-memory ring buffer that a restart erases, which is exactly the trace the
 * queues were built to replace.
 *
 * So both roads now build their record HERE, and the two cannot drift: the
 * sentence, the metadata keys, the chain-depth hand-back and the signature the
 * operator alert is coalesced on are one function per transport, called by the
 * processor and by the producer alike. Neither road emits the record itself: it
 * hands it to the transport's recorder, which is where one alert per cause is
 * decided (`undelivered-alert-gate.ts`).
 *
 * ── Why the producers get a TOKEN and not `SystemEventsService` ────────────
 *
 * `SystemEventsService` imports both producers (it looks them up through
 * `ModuleRef` and needs the classes as tokens). A producer that imported it
 * back would close a file-level cycle, and in a cycle whichever file loads
 * second sees the other's class as `undefined` — in `design:paramtypes` too,
 * which Nest reads to inject. That fails at boot, not at compile time, and
 * only in some load orders. This file imports neither of them, so a producer
 * that depends on the token cannot take part in a cycle; the modules bind the
 * token to the real emitter, and the modules are imported by nothing that
 * `SystemEventsService` imports.
 */

export interface UndeliveredRecord {
  /** The event's `message` — the sentence on the operator's card. */
  readonly message: string;
  readonly metadata: Record<string, unknown>;
  /**
   * What makes two records the same incident, for the alert gate — see
   * `alertSignature`. Never the recipient. Not emitted.
   */
  readonly signature: string;
}

/** What a recorder did with one record. */
export type UndeliveredRecording =
  /** It went out as the transport's `…_undelivered` system event. */
  | 'alerted'
  /** The same cause alerted inside the cooldown: it was only counted into the next alert. */
  | 'counted'
  /** Nothing could be written. */
  | 'failed';

/**
 * Hands one record to the transport's `…_undelivered` system event — or, when
 * the same cause already alerted within the cooldown, only counts it — and says
 * which. The module-bound recorder never rejects. A recorder that answers
 * nothing (a double with no gate behind it) is taken to have alerted: see
 * `recordingOf`.
 */
export type UndeliveredRecorder = (
  record: UndeliveredRecord,
) => UndeliveredRecording | void | Promise<UndeliveredRecording | void>;

/** A recorder's answer, with "said nothing" read as the emit it stands for. */
export function recordingOf(answer: UndeliveredRecording | void): UndeliveredRecording {
  return answer ?? 'alerted';
}

/** Bound by `ReiwaRelayModule` to a coalesced `reiwa.relay_undelivered` emit. */
export const RELAY_UNDELIVERED_RECORDER = Symbol('RELAY_UNDELIVERED_RECORDER');

/** Bound by `TelegramDirectModule` to a coalesced `telegram.direct_undelivered` emit. */
export const TELEGRAM_DIRECT_UNDELIVERED_RECORDER = Symbol('TELEGRAM_DIRECT_UNDELIVERED_RECORDER');

interface AttemptTally {
  /** Attempts made, including the one that just ended. */
  readonly attemptsMade: number;
  /** Attempts the road allowed: the job's `attempts`, or 1 for the direct fallback. */
  readonly attempts: number;
  /**
   * Why the job never reached the queue — present only on the producer's
   * direct fallback. It is the one fact that tells an operator this was a
   * Redis (or job-options) problem and not a delivery one, and for a while it
   * would have read "Custom Id cannot contain :" on every card.
   */
  readonly enqueueError?: string;
}

/**
 * The broadcast whose operator-channel post this relay is, or `null`.
 *
 * Recognised by the key the broadcast producer mints (`broadcast-channel:<id>`),
 * the same way `rememberRelayedChannelPost` recognises it, and only on the one
 * event that carries it.
 */
export function channelPostBroadcastId(event: string, metadata: Record<string, unknown>): string | null {
  if (event !== 'reiwa.channel.broadcast') return null;
  const eventId = stringOf(metadata['eventId']);
  if (eventId === null || !eventId.startsWith(BROADCAST_CHANNEL_EVENT_PREFIX)) return null;
  const broadcastId = eventId.slice(BROADCAST_CHANNEL_EVENT_PREFIX.length);
  return broadcastId.length > 0 ? broadcastId : null;
}

export function buildRelayUndeliveredRecord(input: AttemptTally & {
  readonly event: ReiwaRelayEvent;
  readonly metadata: Record<string, unknown>;
  readonly outcome: NotifyDeliveryResult;
}): UndeliveredRecord {
  const eventId = stringOf(input.metadata['eventId']);
  const chatId = stringOf(input.metadata['chatId']);
  const topicId = topicIdOf(input.metadata['topicThreadId']);
  const broadcastId = channelPostBroadcastId(input.event, input.metadata);
  const sourceEventType = stringOf(input.metadata['sourceEventType']) ?? systemEventTypeOfKey(eventId);
  const notificationType = stringOf(input.metadata['notificationType']);
  return {
    message:
      `Reiwa relay did not deliver ${input.event} (${input.outcome.status})` +
      (broadcastId === null ? '' : ` — the channel post of broadcast ${broadcastId}`),
    metadata: {
      relayEvent: input.event,
      relayStatus: input.outcome.status,
      httpStatus: input.outcome.httpStatus,
      detail: input.outcome.detail,
      attemptsMade: input.attemptsMade,
      attempts: input.attempts,
      ...(eventId !== null ? { relayEventId: eventId } : {}),
      ...(broadcastId !== null ? { broadcastId } : {}),
      // Where it was going, when it was going to an operator's chat — the
      // signature already tells two chats apart, so the card has to be able to
      // say which one this was.
      ...(chatId !== null ? { chatId } : {}),
      ...(topicId !== null ? { topicId } : {}),
      ...(sourceEventType !== null ? { sourceEventType } : {}),
      ...(notificationType !== null ? { notificationType } : {}),
      ...(input.enqueueError === undefined ? {} : { enqueueError: input.enqueueError }),
      // THE HOP COUNT, CARRIED THROUGH.
      //
      // This event is emitted from scratch, and building it without the count
      // reset the automation loop guard once per relay generation: an action
      // emits a stamped event, that event queues a relay job, the job
      // exhausts, and the record put a fresh depth-zero event back on the bus.
      // A rule bound to it — "tell me on Telegram when the relay breaks" —
      // then re-armed itself for ever, four laps at a time, while the cabinet
      // was down. `relaySystemEvent` copies the depth onto the job precisely so
      // this can hand it back.
      ...chainDepthMetadata(input.metadata),
    },
    signature: alertSignature({
      transport: 'reiwa-relay',
      route: input.event,
      sourceEventType,
      notificationType,
      status: input.outcome.status,
      httpStatus: input.outcome.httpStatus,
      detail: input.outcome.detail,
      chatId,
      topicId,
      // A broadcast's channel post is its own incident, whatever else failed
      // the same way: one operator action, one post, and an operator who needs
      // to hear about THIS one. Coalesced with another broadcast's post to the
      // same chat, the second loss produced no card that named it.
      incident: broadcastId === null ? null : eventId,
    }),
  };
}

/**
 * `describeTelegramOutcome` supplies the sentence; the metadata carries the raw
 * evidence. The two most valuable cases are the ones a bare status code would
 * hide: a 401 means the token in Settings is wrong, and a 400 with
 * `migrate_to_chat_id` means the group became a supergroup and the stored Chat
 * ID is now permanently dead — Telegram says so exactly once, on that first
 * 400, and never again.
 *
 * The automation hop count comes back from the JOB, for the reason the relay
 * record gives above. A rule "tell me on Telegram when the panel cannot send a
 * card" otherwise re-armed on every generation: its own `notify_telegram` card
 * is queued here, refused for the same reason (a revoked token refuses every
 * card at once, and immediately), and this record put a depth-zero event back on
 * the bus. `SystemEventsService` has to stamp the depth onto the job for this to
 * have anything to hand back — see `TelegramDirectJobData.automationChainDepth`.
 */
export function buildTelegramDirectUndeliveredRecord(input: AttemptTally & {
  readonly data: TelegramDirectJobData;
  readonly outcome: TelegramDirectResult;
}): UndeliveredRecord {
  const topicId = topicIdOf(input.data.topicId);
  const notificationType = stringOf(input.data.notificationType);
  return {
    message: `Панель не доставила карточку в Telegram: ${describeTelegramOutcome(input.outcome)}`,
    metadata: {
      sourceEventType: input.data.sourceEventType,
      ...(notificationType !== null ? { notificationType } : {}),
      sendKind: input.data.kind,
      chatId: input.data.chatId,
      ...(topicId !== null ? { topicId } : {}),
      telegramStatus: input.outcome.status,
      httpStatus: input.outcome.httpStatus,
      detail: input.outcome.detail,
      ...(input.outcome.retryAfterSeconds === null
        ? {}
        : { retryAfterSeconds: input.outcome.retryAfterSeconds }),
      ...(input.outcome.migrateToChatId === null
        ? {}
        : { migrateToChatId: input.outcome.migrateToChatId }),
      attemptsMade: input.attemptsMade,
      attempts: input.attempts,
      ...(input.enqueueError === undefined ? {} : { enqueueError: input.enqueueError }),
      ...chainDepthMetadata(input.data),
    },
    signature: alertSignature({
      transport: 'telegram-direct',
      route: input.data.kind,
      sourceEventType: input.data.sourceEventType,
      notificationType,
      status: input.outcome.status,
      httpStatus: input.outcome.httpStatus,
      detail: input.outcome.detail,
      chatId: input.data.chatId,
      topicId,
      incident: null,
    }),
  };
}

/** What an alert that stands for repeats adds to the relay record's sentence. */
export function describeRelayRepeats(repeats: number): string {
  return `; ${repeats} more like it since the previous alert`;
}

/** The same, in the language of the Telegram record's sentence. */
export function describeTelegramDirectRepeats(repeats: number): string {
  return `; таких же с прошлого оповещения: ${repeats}`;
}

/** Longest reason text a signature keeps. The records' own `detail` is not clipped by this. */
const SIGNATURE_DETAIL_LIMIT = 300;

/**
 * One incident's name, built from what failed and why — never from whom it hit.
 *
 *  - transport, and the route: the relay event, or the direct send's kind;
 *  - what was being sent: the system event a card is for (`sourceEventType`)
 *    and the notification template (`notificationType`) where the metadata
 *    names them. Two templates Telegram refuses with the same words are two
 *    templates to fix, and so are two event cards;
 *  - the outcome, its HTTP status, and the reason;
 *  - where it was going when that is an operator's: the chat, and the forum
 *    topic in it. Every such destination is configured once, and two of them
 *    failing — two deleted topics answer the same "message thread not found" —
 *    are two things to fix. A subscriber message has no such component: its
 *    recipient is exactly what must not split the signature;
 *  - `incident`, for the one relay that is never coalesced with another: a
 *    broadcast's channel post. Its signature is its own event id and nothing
 *    else, so it never shares a card with another post — and every record of
 *    the SAME post (its fallback's miss, then the job that landed late and
 *    failed differently) shares one, which is what "one card per lost post"
 *    means.
 *
 * The reason text is normalised before it counts: case and whitespace go, and
 * every run of digits becomes `#`. Telegram's refusals quote positions and
 * waits — "can't parse entities: … at byte offset 57", "retry after 35" — and a
 * notification rendered with each subscriber's name moves that offset from one
 * recipient to the next, so the raw text would split one broken template into
 * as many "causes" as there are name lengths. Only the reason: a 401 and a 422,
 * or two chat ids, stay apart.
 */
function alertSignature(parts: {
  readonly transport: 'reiwa-relay' | 'telegram-direct';
  readonly route: string;
  readonly sourceEventType: string | null;
  readonly notificationType: string | null;
  readonly status: string;
  readonly httpStatus: number | null;
  readonly detail: string | null;
  readonly chatId: string | null;
  readonly topicId: number | null;
  readonly incident: string | null;
}): string {
  if (parts.incident !== null) {
    return JSON.stringify([parts.transport, parts.route, 'incident', parts.incident]);
  }
  const reason = (parts.detail ?? '')
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SIGNATURE_DETAIL_LIMIT);
  return JSON.stringify([
    parts.transport,
    parts.route,
    parts.sourceEventType,
    parts.notificationType,
    parts.status,
    parts.httpStatus,
    reason,
    parts.chatId,
    parts.topicId,
    parts.incident,
  ]);
}

/**
 * The system event type a `sysevt:` relay key was minted for, or `null`.
 *
 * The panel's own cards reach the relay without their type in the metadata —
 * the key is the only place it survives — and the key has one shape
 * (`SystemEventsService`'s `buildRelayEventId`, pinned by
 * `test/undelivered-alert-gate.spec.ts`): `sysevt:<type>:<ISO time>:<route>-<16 hex>`.
 * The type may itself contain `:`, so it is read as everything between the
 * prefix and an ISO timestamp followed by the route suffix. A key in any other
 * shape yields `null`, and the signature is merely coarser for it.
 */
function systemEventTypeOfKey(eventId: string | null): string | null {
  if (eventId === null) return null;
  const match = /^sysevt:(.+):\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z:[a-z-]+-[0-9a-f]{16}$/.exec(
    eventId,
  );
  return match === null ? null : (match[1] as string);
}

function stringOf(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function topicIdOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}
