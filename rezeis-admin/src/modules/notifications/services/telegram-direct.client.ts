import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';

import { appConfig } from '../../../common/config/app.config';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { readAdminBotToken, readEnvBotToken } from '../../../common/utils/admin-bot-token.util';
import {
  TELEGRAM_DOCUMENT_TIMEOUT_MS,
  TELEGRAM_MESSAGE_TIMEOUT_MS,
  type TelegramDirectJobData,
} from '../telegram-direct.constants';
import { classifyTelegramResponse, type TelegramDirectResult } from '../telegram-direct.outcome';

/**
 * TelegramDirectClient
 * ════════════════════
 * The panel talking to the Bot API itself. One method per shape, one place
 * that knows the token, and an outcome the caller can act on.
 *
 * The token is resolved HERE, at send time, and never travels in the BullMQ
 * payload. That is not a style preference: a job payload is a Redis value that
 * outlives the send, gets dumped into failed-job inspectors, and is replayed
 * verbatim on every attempt. A bot token in there is a bot token in a place
 * nobody thinks of as a secret store. It also means a rotated token takes
 * effect on the next attempt of an already-queued job rather than being frozen
 * at enqueue.
 */
@Injectable()
export class TelegramDirectClient {
  private readonly logger = new Logger(TelegramDirectClient.name);

  public constructor(
    private readonly prismaService: PrismaService,
    @Optional()
    @Inject(appConfig.KEY)
    private readonly applicationConfiguration?: ConfigType<typeof appConfig>,
  ) {}

  /**
   * The token this panel would send with, or null.
   *
   * Same order and same source as every other Telegram sender in the tree:
   * the panel-managed ciphertext first, `BOT_TOKEN` second.
   */
  public async resolveToken(): Promise<string | null> {
    const settings = await this.prismaService.settings.findFirst({
      orderBy: { updatedAt: 'asc' },
      select: { systemNotifications: true },
    });
    const stored =
      settings === null
        ? null
        : readAdminBotToken(
            settings.systemNotifications,
            this.applicationConfiguration?.cryptKey,
          );
    return stored ?? readEnvBotToken();
  }

  /** Whether the panel can address Telegram at all. Drives the routing choice. */
  public async isEnabled(): Promise<boolean> {
    return (await this.resolveToken()) !== null;
  }

  /**
   * Perform one send. Never throws — every failure comes back as a status the
   * caller can classify. The processor is the thing that decides to retry, and
   * it cannot make that decision from an exception it did not expect.
   */
  public async send(data: TelegramDirectJobData): Promise<TelegramDirectResult> {
    const token = await this.resolveToken();
    if (token === null) {
      return {
        status: 'disabled',
        httpStatus: null,
        detail: null,
        retryAfterSeconds: null,
        migrateToChatId: null,
      };
    }
    return data.kind === 'document'
      ? this.sendDocument(token, data)
      : this.sendMessage(token, data);
  }

  private async sendMessage(
    token: string,
    data: TelegramDirectJobData,
  ): Promise<TelegramDirectResult> {
    const payload: Record<string, unknown> = {
      chat_id: data.chatId,
      text: data.text,
      disable_web_page_preview: true,
    };
    if (data.parseMode !== null) payload.parse_mode = data.parseMode;
    if (data.topicId !== null) payload.message_thread_id = data.topicId;

    return this.call('sendMessage', token, TELEGRAM_MESSAGE_TIMEOUT_MS, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  private async sendDocument(
    token: string,
    data: TelegramDirectJobData,
  ): Promise<TelegramDirectResult> {
    const form = new FormData();
    form.append('chat_id', data.chatId);
    if (data.topicId !== null) form.append('message_thread_id', String(data.topicId));
    // The card is the caption, exactly as the relay path sends it, so the two
    // routes produce the same message rather than two dialects of it.
    if (data.text.length > 0) form.append('caption', data.text);
    if (data.parseMode !== null) form.append('parse_mode', data.parseMode);
    form.append(
      'document',
      new Blob([data.content ?? ''], { type: 'text/plain' }),
      data.filename ?? 'report.txt',
    );

    return this.call('sendDocument', token, TELEGRAM_DOCUMENT_TIMEOUT_MS, {
      method: 'POST',
      body: form,
    });
  }

  /**
   * The one place a request actually leaves. Reads the body even on a failure
   * — that body is where `description`, `retry_after` and `migrate_to_chat_id`
   * live, and discarding it is how a 429 becomes an indistinguishable "400-ish
   * thing" that gets retried straight back into the flood-wait.
   */
  private async call(
    method: string,
    token: string,
    timeoutMs: number,
    init: RequestInit,
  ): Promise<TelegramDirectResult> {
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await response.json().catch(() => null);
      return classifyTelegramResponse({ httpStatus: response.status, body });
    } catch (err: unknown) {
      // Deliberately `name` + `cause.code`, never `message`. The request URL
      // carries the bot token, and `fetch` is entitled to put the URL it was
      // given into an error message — this line goes to stdout, which on this
      // product goes to the operator's log aggregator. `TimeoutError` /
      // `ECONNRESET` say everything an operator needs and cannot carry a
      // secret.
      const detail = describeFetchFailure(err);
      this.logger.warn(`Telegram ${method} did not complete (${detail})`);
      return {
        status: 'failed',
        httpStatus: null,
        detail,
        retryAfterSeconds: null,
        migrateToChatId: null,
      };
    }
  }
}

/**
 * A safe, useful name for a `fetch` that never produced a response.
 *
 * Exported so `test/telegram-direct-token-safety.spec.ts` can hand it errors
 * whose `message` contains a token-bearing URL and assert the token does not
 * survive. That test is the point of the function: the redaction is invisible
 * in every log line it produces correctly, so nothing but an assertion keeps
 * it in place.
 */
export function describeFetchFailure(err: unknown): string {
  if (!(err instanceof Error)) return 'unknown';
  const cause = (err as { cause?: unknown }).cause;
  const code =
    typeof cause === 'object' && cause !== null && typeof (cause as { code?: unknown }).code === 'string'
      ? (cause as { code: string }).code
      : null;
  // Codes are a closed vocabulary of short uppercase tokens. Anything longer
  // or otherwise shaped is not a code and is not repeated.
  const safeCode = code !== null && /^[A-Z0-9_]{1,32}$/.test(code) ? code : null;
  return safeCode === null ? err.name : `${err.name}: ${safeCode}`;
}
