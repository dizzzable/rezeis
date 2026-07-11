import { Prisma } from '@prisma/client';

export interface QuestChannelConfig {
  /** Stable Telegram chat reference for getChatMember: numeric id or @username. */
  readonly chatId: string;
  /** Operator-approved public or private Telegram join URL. */
  readonly joinUrl: string;
}

const CHANNEL_ID_RE = /^-100\d{6,20}$/;
const USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;
const PUBLIC_PATH_RE = /^\/([A-Za-z][A-Za-z0-9_]{4,31})\/?$/;
const PRIVATE_INVITE_PATH_RE = /^\/\+([A-Za-z0-9_-]{5,128})\/?$/;

/**
 * Parses the untrusted Quest.params channel configuration into the only two
 * values bot verification needs. A private invite is usable for joining but
 * cannot prove membership by itself, so it still requires a numeric chat id.
 */
export function resolveQuestChannelConfig(value: Prisma.JsonValue): QuestChannelConfig | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const params = value as Record<string, unknown>;
  const channelId = readNumericChannelId(params.channelId);
  const channelLink = readTelegramJoinUrl(params.channelLink);
  const configuredUsername = readUsername(params.channelUsername);
  const linkedUsername = channelLink === null ? null : publicUsernameFromJoinUrl(channelLink);

  // Supplying a malformed username is configuration corruption even if a link
  // would otherwise be sufficient; reject it rather than silently changing the
  // operator's target channel.
  if (typeof params.channelUsername === 'string' && params.channelUsername.trim() !== '' && configuredUsername === null) {
    return null;
  }

  const username = configuredUsername ?? linkedUsername;
  const chatId = channelId ?? (username === null ? null : `@${username}`);
  const joinUrl = channelLink ?? (username === null ? null : `https://t.me/${username}`);
  if (chatId === null || joinUrl === null) return null;

  return { chatId, joinUrl };
}

function readNumericChannelId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return CHANNEL_ID_RE.test(normalized) ? normalized : null;
}

function readUsername(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/^@/, '');
  return USERNAME_RE.test(normalized) ? normalized : null;
}

function readTelegramJoinUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== 'https:' || (host !== 't.me' && host !== 'telegram.me')) return null;
  if (parsed.search !== '' || parsed.hash !== '') return null;
  if (!PUBLIC_PATH_RE.test(parsed.pathname) && !PRIVATE_INVITE_PATH_RE.test(parsed.pathname)) {
    return null;
  }
  return `https://t.me${parsed.pathname}`;
}

function publicUsernameFromJoinUrl(url: string): string | null {
  const path = new URL(url).pathname;
  const match = path.match(PUBLIC_PATH_RE);
  return match?.[1] ?? null;
}
