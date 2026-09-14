import type { PrismaService } from '../../common/prisma/prisma.service';
import type { ReiwaRelayJobData } from './reiwa-relay.constants';
import { isCertainlyUnsent } from './reiwa-relay.policy';
import type { NotifyDeliveryResult } from './services/bot-notifier.client';
import { channelPostBroadcastId } from './undelivered-record';

/**
 * Keep the address of a broadcast's operator-channel post.
 *
 * ── Why a generic relay knows this one event ─────────────────────────────────
 *
 * The message id exists for exactly one instant: in the bot's reply to the
 * delivery. Nothing downstream can ask for it afterwards — Telegram has no
 * "what did I post" call — so if it is not written then it is gone, and with
 * it every way to edit or recall that post. Editing a sent broadcast then
 * rewrote every private message and left the public copy showing the original
 * text.
 *
 * ── Why this is a function and not the processor's method ───────────────────
 *
 * Two roads deliver a channel post: a queued job (`ReiwaRelayProcessor`) and
 * the single direct attempt `ReiwaRelayQueueService` makes when Redis refuses
 * the job. Only the first remembered the address, so a post sent while Redis
 * was down stayed unaddressable for good. Both now call this. It lives outside
 * the processor because the producer cannot import that file: it imports
 * `SystemEventsService`, which imports the producer.
 *
 * Recognised by the event id the producer chose, not by inspecting content,
 * and it fails quietly: a broadcast whose id could not be stored simply keeps
 * a channel post that cannot be corrected — the same as before — and must
 * never turn a delivered post into a failed one. Never throws.
 */
export async function rememberRelayedChannelPost(
  prisma: Pick<PrismaService, 'broadcast'>,
  data: ReiwaRelayJobData,
  outcome: NotifyDeliveryResult,
  warn: (message: string) => void,
): Promise<void> {
  const broadcastId = channelPostBroadcastId(data.event, data.metadata ?? {});
  // An `unconfirmed` delivery (an older bot answering 204) carries no id.
  // There is nothing to write, and writing the chat alone would claim an
  // address that cannot be used.
  if (broadcastId === null || outcome.messageId === null) return;
  const chatId = typeof data.metadata?.chatId === 'string' ? data.metadata.chatId : null;
  if (chatId === null) return;
  try {
    await prisma.broadcast.updateMany({
      where: { id: broadcastId },
      data: { channelChatId: chatId, channelMessageId: BigInt(outcome.messageId) },
    });
  } catch (err: unknown) {
    warn(
      `Could not record the channel post id for broadcast ${broadcastId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * A broadcast's channel post that certainly never went up: record that, so the
 * broadcast page stops presenting it as a public copy.
 *
 * ── What the row can say, and what it said ──────────────────────────────────
 *
 * The page reads the post's state off two columns (`channelPostStateOf`,
 * `BroadcastDeliveryService.channelPostAddress`): an address means "up and
 * addressable", a chat with no message id means "there is no post" (a recall
 * clears the id and keeps the chat), and neither — with a channel configured on
 * the broadcast — means "a copy went up that cannot be addressed". A LOST post
 * stored nothing, so it read as the last one: the list offered a recall, and the
 * recall told the operator to delete by hand a post that was never published.
 *
 * So a loss writes the chat alone — "there is no post", which for a post that
 * never went up is simply true. Only for an outcome that certainly left nothing
 * behind (`isCertainlyUnsent`): after a timeout the copy may well be up, and
 * "cannot be addressed, check the channel" stays the honest answer. And only
 * over a row with no message id, so a delivery stored by the other road is
 * never overwritten. Never throws; answers whether it wrote.
 */
export async function rememberLostChannelPost(
  prisma: Pick<PrismaService, 'broadcast'>,
  data: ReiwaRelayJobData,
  outcome: NotifyDeliveryResult,
  warn: (message: string) => void,
): Promise<boolean> {
  const broadcastId = channelPostBroadcastId(data.event, data.metadata ?? {});
  if (broadcastId === null || !isCertainlyUnsent(outcome)) return false;
  const chatId = typeof data.metadata?.chatId === 'string' ? data.metadata.chatId : null;
  if (chatId === null) return false;
  return markChannelPostNeverPublished(prisma, broadcastId, chatId, warn);
}

/**
 * The write behind `rememberLostChannelPost`, for a post the relay never saw at
 * all: a relay that is not configured, or a post that could not be composed.
 * Never throws; answers whether it wrote.
 */
export async function markChannelPostNeverPublished(
  prisma: Pick<PrismaService, 'broadcast'>,
  broadcastId: string,
  chatId: string,
  warn: (message: string) => void,
): Promise<boolean> {
  try {
    await prisma.broadcast.updateMany({
      where: { id: broadcastId, channelMessageId: null },
      data: { channelChatId: chatId },
    });
    return true;
  } catch (err: unknown) {
    warn(
      `Could not record that the channel post of broadcast ${broadcastId} was never published: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}
