/**
 * Reading a Bot API answer honestly
 * ═════════════════════════════════
 * The direct path replaces a relay that returned a rich
 * `NotifyDeliveryResult` the processor could reason about. Sending straight to
 * Telegram means classifying Telegram's own answers instead, and the failure
 * modes are genuinely different from the relay's — a retry is not merely
 * useless for most of them, it is harmful for one (429, where sending again
 * inside the flood-wait extends it).
 *
 * So this file is deliberately not `res.ok ? sent : failed`. Every status
 * below exists because a different thing should happen to it.
 */

/** What became of one attempt. */
export type TelegramDirectStatus =
  /** Telegram accepted it: HTTP 2xx and `ok: true`. */
  | 'sent'
  /** Telegram refused THIS request: 400, 403, 404, 409… */
  | 'rejected'
  /** 429 — accepted in principle, refused right now. Carries `retryAfterSeconds`. */
  | 'flood_wait'
  /** 401 — the token is wrong or revoked. A setting, not a network condition. */
  | 'unauthorized'
  /** 5xx — Telegram is having a bad moment. */
  | 'upstream_error'
  /** `fetch` threw, or the deadline fired. Nothing was heard back. */
  | 'failed'
  /** No token at all. Not a failure — a deployment shape. */
  | 'disabled';

export interface TelegramDirectResult {
  readonly status: TelegramDirectStatus;
  readonly httpStatus: number | null;
  /** Telegram's `description`, clipped. Null when there was no body to read. */
  readonly detail: string | null;
  /** `parameters.retry_after`, seconds. Only ever set on `flood_wait`. */
  readonly retryAfterSeconds: number | null;
  /**
   * `parameters.migrate_to_chat_id`. Telegram sends this once, on the 400 that
   * follows a group being upgraded to a supergroup — the stored chat id is
   * then permanently dead and every later attempt is a plain "chat not found"
   * with no hint at all. Captured here so the operator alert can name the new
   * id instead of leaving them to guess why a chat that works in their client
   * refuses the panel.
   */
  readonly migrateToChatId: string | null;
}

/** Longest `description` kept. Telegram's are short; a hostile one need not be. */
const MAX_DETAIL_LENGTH = 300;

/**
 * Classify a Bot API response body + status into an outcome.
 *
 * `ok` in the body is the authority and the HTTP status is corroboration, not
 * the other way round. Telegram keeps them consistent today; a proxy in front
 * of it need not — and a 200 whose body says `ok: false` is a failure being
 * reported as a success, which is the one direction that must not slip
 * through.
 */
export function classifyTelegramResponse(input: {
  readonly httpStatus: number;
  readonly body: unknown;
}): TelegramDirectResult {
  const body = isRecord(input.body) ? input.body : {};
  const parameters = isRecord(body.parameters) ? body.parameters : {};
  const detail = typeof body.description === 'string' ? clip(body.description) : null;
  const retryAfter =
    typeof parameters.retry_after === 'number' && Number.isFinite(parameters.retry_after)
      ? Math.max(0, Math.trunc(parameters.retry_after))
      : null;
  const migrateTo =
    typeof parameters.migrate_to_chat_id === 'number' &&
    Number.isFinite(parameters.migrate_to_chat_id)
      ? String(parameters.migrate_to_chat_id)
      : null;

  const okFlag = body.ok;
  if (input.httpStatus >= 200 && input.httpStatus < 300 && okFlag !== false) {
    return {
      status: 'sent',
      httpStatus: input.httpStatus,
      detail: null,
      retryAfterSeconds: null,
      migrateToChatId: null,
    };
  }

  const base = { httpStatus: input.httpStatus, detail, migrateToChatId: migrateTo };
  // 429 is checked before the generic 4xx bucket: it is the one refusal that
  // says "later", and treating it as a plain rejection would drop the card on
  // the floor during exactly the burst that produced it.
  if (input.httpStatus === 429 || retryAfter !== null) {
    return { ...base, status: 'flood_wait', retryAfterSeconds: retryAfter };
  }
  if (input.httpStatus === 401) {
    return { ...base, status: 'unauthorized', retryAfterSeconds: null };
  }
  if (input.httpStatus >= 500) {
    return { ...base, status: 'upstream_error', retryAfterSeconds: null };
  }
  return { ...base, status: 'rejected', retryAfterSeconds: null };
}

/**
 * Would another attempt plausibly change the answer?
 *
 *  - `failed` / `upstream_error` → yes. Nothing about the request was refused;
 *    the network or Telegram was briefly unavailable.
 *  - `flood_wait` → yes, but only if the wait fits under the ceiling. Past it
 *    the retry would land far too late to be an alert; see
 *    `TELEGRAM_FLOOD_WAIT_CEILING_SECONDS`.
 *  - `rejected` → no. A 400 is a payload or a chat id Telegram will refuse
 *    identically in fifteen seconds: unparsable HTML entities, a chat the bot
 *    is not in, a `message_thread_id` that does not exist. Retrying buys a
 *    45-second delay on telling the operator, and nothing else.
 *  - `unauthorized` → no, and emphatically. The remedy is to paste a token
 *    into Settings → Bot Token. Three more attempts with the same wrong token
 *    is three more of the same answer.
 *  - `disabled` → no. There is nothing to retry with.
 *  - `sent` → delivered.
 */
export function isRetryableTelegramOutcome(
  outcome: TelegramDirectResult,
  floodWaitCeilingSeconds: number,
): boolean {
  switch (outcome.status) {
    case 'failed':
    case 'upstream_error':
      return true;
    case 'flood_wait':
      // An unparsed `retry_after` (429 with no number) is treated as retryable:
      // the ban is real and typically short, and refusing to retry because
      // Telegram omitted a field would throw away a card for a reason that has
      // nothing to do with the card.
      return (
        outcome.retryAfterSeconds === null || outcome.retryAfterSeconds <= floodWaitCeilingSeconds
      );
    case 'sent':
    case 'rejected':
    case 'unauthorized':
    case 'disabled':
      return false;
    default:
      return false;
  }
}

/**
 * A one-line reason for the operator card, in the operator's language.
 *
 * The raw `description` goes in the metadata; this is the sentence that has to
 * make sense to somebody who has not read the Bot API docs, and it names the
 * remedy wherever there is one. A card that says `rejected (400)` and stops is
 * how an alert becomes something people scroll past.
 */
export function describeTelegramOutcome(outcome: TelegramDirectResult): string {
  switch (outcome.status) {
    case 'unauthorized':
      return 'Telegram отклонил токен бота — проверьте «Настройки» → «Токен бота»';
    case 'flood_wait':
      return outcome.retryAfterSeconds === null
        ? 'Telegram временно ограничил отправку'
        : `Telegram ограничил отправку на ${outcome.retryAfterSeconds} с`;
    case 'rejected':
      if (outcome.migrateToChatId !== null) {
        return `Группа стала супергруппой — новый Chat ID ${outcome.migrateToChatId}, обновите его в «Уведомлениях»`;
      }
      return `Telegram отклонил сообщение: ${outcome.detail ?? 'без описания'}`;
    case 'upstream_error':
      return 'Telegram отвечает ошибкой на своей стороне';
    case 'failed':
      return 'Не удалось связаться с Telegram';
    case 'disabled':
      return 'Токен бота не задан в панели';
    case 'sent':
      return 'Доставлено';
    default:
      return 'Неизвестный результат отправки';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function clip(value: string): string {
  return value.length > MAX_DETAIL_LENGTH ? `${value.slice(0, MAX_DETAIL_LENGTH)}…` : value;
}
