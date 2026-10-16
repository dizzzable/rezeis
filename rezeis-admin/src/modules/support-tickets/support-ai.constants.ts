/**
 * The AI assistant inside support tickets (16.10.2026).
 *
 * The owner retired the separate AI chat of the cabinet and the bot: clients
 * were confused by two supports. The assistant now answers in the ticket
 * itself, as ordinary support — no «AI» mark on the client's side — and calls
 * a human only when it hands the thread over.
 */

/** BullMQ queue the assistant's answers run on. */
export const SUPPORT_AI_QUEUE = 'support-ai';

/** Job names within {@link SUPPORT_AI_QUEUE}. */
export const SUPPORT_AI_JOBS = {
  /** Answer the client's message `messageId` on ticket `ticketId`. */
  REPLY: 'support-ai.reply',
} as const;

export interface SupportAiReplyJob {
  readonly ticketId: string;
  /** The client's message that asked; the job stands down when a newer one exists. */
  readonly messageId: string;
}

/**
 * How long a job waits before it runs. A client who sends three short lines in
 * a row gets ONE answer to all three: each line queues a job, and every job but
 * the one for the newest line finds a newer message and stands down.
 */
export const SUPPORT_AI_DEBOUNCE_MS = 2_500;

/** Attempts per answer before the assistant gives up and hands the thread over. */
export const SUPPORT_AI_ATTEMPTS = 2;

/** Pause between those attempts. */
export const SUPPORT_AI_RETRY_DELAY_MS = 5_000;

/**
 * The assistant's answers per ticket before it hands the thread to a human.
 * A conversation that long is one it is not resolving, and every answer is
 * paid for with the operator's key.
 */
export const SUPPORT_AI_MAX_REPLIES_PER_TICKET = 12;

/** Why the panel itself handed a thread over (the assistant writes its own reasons). */
export const SUPPORT_AI_HANDOFF = {
  /** The assistant was switched off, or lost its key, under a thread it led. */
  OFF: 'ai_off',
  /** The model failed every attempt. */
  ERROR: 'ai_error',
  /** {@link SUPPORT_AI_MAX_REPLIES_PER_TICKET} reached. */
  LIMIT: 'ai_limit',
} as const;

/** What the operator's card says for each of the panel's own reasons. */
export const SUPPORT_AI_HANDOFF_WORDS: Readonly<Record<string, string>> = {
  [SUPPORT_AI_HANDOFF.OFF]: 'ассистент выключен или остался без ключа',
  [SUPPORT_AI_HANDOFF.ERROR]: 'ассистент не смог ответить: модель недоступна',
  [SUPPORT_AI_HANDOFF.LIMIT]: `ассистент ответил ${SUPPORT_AI_MAX_REPLIES_PER_TICKET} раз и вопрос не закрыт`,
};

/** Longest reason kept on the ticket and printed on the card. */
export const SUPPORT_AI_REASON_MAX_CHARS = 300;
