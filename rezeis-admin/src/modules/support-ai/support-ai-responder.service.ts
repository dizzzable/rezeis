import { Injectable, Logger } from '@nestjs/common';
import { SupportTicketStatus } from '@prisma/client';
import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

import { PrismaService } from '../../common/prisma/prisma.service';
import { describeFaqForModel, describeTariffsForModel } from '../ai-chat/services/ai-public-tools';
import type { AiConfigSettings } from '../ai-config/interfaces/ai-config.interface';
import { AiConfigService } from '../ai-config/services/ai-config.service';
import { AiInstructionService } from '../ai-config/services/ai-instruction.service';
import { FaqService } from '../faq/services/faq.service';
import { PlanCatalogService } from '../plans/services/plan-catalog.service';
import { SupportAiDispatchService } from '../support-tickets/services/support-ai-dispatch.service';
import { SupportNotificationsService } from '../support-tickets/services/support-notifications.service';
import { SupportTicketsService } from '../support-tickets/services/support-tickets.service';
import {
  SUPPORT_AI_HANDOFF,
  SUPPORT_AI_MAX_REPLIES_PER_TICKET,
  type SupportAiReplyJob,
} from '../support-tickets/support-ai.constants';
import {
  buildSupportAiConversation,
  buildSupportAiSystemPrompt,
  cleanAssistantReply,
  clientLanguage,
  handoffNote,
  SUPPORT_AI_TOOLS,
  TRANSFER_TOOL,
  type TicketTurn,
} from './support-ai-prompt';

/** What one job did. */
export type SupportAiOutcome = 'answered' | 'handed_off' | 'skipped';

/** The messages of a ticket the model is shown, newest last. */
const HISTORY_MESSAGES = 30;

/** Rounds of tool calls before the model must answer in words. */
const MAX_TOOL_ROUNDS = 4;

/** One provider call; a stuck one fails the attempt instead of the worker. */
const MODEL_TIMEOUT_MS = 45_000;

/** The model the old chat fell back to when the operator named none. */
const DEFAULT_MODEL = 'gpt-4o-mini';

/** The narrow part of the OpenAI client this service calls — what a spec replaces. */
export interface SupportAiModelClient {
  readonly chat: {
    readonly completions: {
      create(params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming): Promise<OpenAI.Chat.Completions.ChatCompletion>;
    };
  };
}

interface TicketForAnswer {
  readonly id: string;
  readonly subject: string;
  readonly status: SupportTicketStatus;
  readonly aiActive: boolean;
  /** When the assistant took the thread this time; its reply limit counts from here. */
  readonly aiActiveSince: Date | null;
  readonly user: { readonly id: string; readonly language: string | null } | null;
  /** Oldest first, at most {@link HISTORY_MESSAGES}. */
  readonly messages: ReadonlyArray<TicketTurn & { readonly id: string }>;
}

/**
 * SupportAiResponderService
 * ═════════════════════════
 * The AI assistant answering inside a support ticket — the model half of
 * `SupportAiDispatchService`, run by `SupportAiProcessor`.
 *
 * One job answers one client message. It stands down when that message is no
 * longer the last word (a newer line has its own job; an operator answered),
 * when the thread is closed, or when the assistant no longer leads it.
 *
 * Its reply is an ordinary support reply — ADMIN with `{ "ai": true }` in
 * `metadata` — and the client is notified of it exactly as of an operator's.
 * When the model calls `transfer_to_operator`, its words go to the client and
 * the thread goes to the operators (`SupportAiDispatchService.handOff`).
 *
 * A provider error THROWS: BullMQ retries the job, and after the last attempt
 * `giveUp` hands the thread over with a short line to the client, so a broken
 * key or a provider outage costs an operator's attention, never a client left
 * talking to nobody.
 */
@Injectable()
export class SupportAiResponderService {
  private readonly logger = new Logger(SupportAiResponderService.name);

  public constructor(
    private readonly prisma: PrismaService,
    private readonly aiConfig: AiConfigService,
    private readonly aiInstructions: AiInstructionService,
    private readonly planCatalog: PlanCatalogService,
    private readonly faq: FaqService,
    private readonly tickets: SupportTicketsService,
    private readonly notifications: SupportNotificationsService,
    private readonly dispatch: SupportAiDispatchService,
  ) {}

  /** Answer the client's message of one job. */
  public async answer(job: SupportAiReplyJob): Promise<SupportAiOutcome> {
    const ticket = await this.readTicket(job.ticketId);
    if (ticket === null || !isWaitingOn(ticket, job.messageId)) return 'skipped';
    const lastClientText = ticket.messages[ticket.messages.length - 1]?.content ?? '';
    const language = clientLanguage(lastClientText, ticket.user?.language);

    // Its replies since it took the thread this time — not its replies ever:
    // the hand-over lines and an earlier stint would hand a thread the
    // operator gave back after the limit straight over again.
    const answered = await this.prisma.supportTicketMessage.count({
      where: {
        ticketId: ticket.id,
        authorType: 'ADMIN',
        metadata: { path: ['ai'], equals: true },
        ...(ticket.aiActiveSince !== null ? { createdAt: { gte: ticket.aiActiveSince } } : {}),
      },
    });
    if (answered >= SUPPORT_AI_MAX_REPLIES_PER_TICKET) {
      await this.handOverWithNote(ticket, SUPPORT_AI_HANDOFF.LIMIT, language);
      return 'handed_off';
    }

    const settings = await this.aiConfig.getSettings();
    if (!settings.enabled || settings.apiKey.trim().length === 0) {
      await this.handOverWithNote(ticket, SUPPORT_AI_HANDOFF.OFF, language);
      return 'handed_off';
    }

    const knowledge = await this.aiInstructions.getPublicInstructions().catch((err: unknown) => {
      this.logger.warn(`AI instructions unreadable, answering without them: ${describe(err)}`);
      return [];
    });
    const model = settings.model.trim().length > 0 ? settings.model.trim() : DEFAULT_MODEL;
    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: buildSupportAiSystemPrompt({ persona: settings.systemPrompt, knowledge }) },
      ...buildSupportAiConversation(ticket.subject, ticket.messages),
    ];
    const result = await this.runModel(this.createClient(settings), model, messages);

    // The model took seconds. An operator may have answered, switched the
    // assistant off, or the client written again in that time.
    const fresh = await this.readTicket(job.ticketId);
    if (fresh === null || !isWaitingOn(fresh, job.messageId)) return 'skipped';

    let reply = cleanAssistantReply(result.text);
    if (result.transferReason !== null) {
      if (reply.length === 0) reply = handoffNote(language);
      await this.writeReply(fresh, reply, model);
      await this.dispatch.handOff(fresh.id, result.transferReason.length > 0 ? result.transferReason : 'клиенту нужен оператор');
      return 'handed_off';
    }
    if (reply.length === 0) throw new Error('The model answered with no text');
    // No event of its own: the reply is in the thread, the open «Тикеты» page
    // polls, and the operators are not called while the assistant leads.
    await this.writeReply(fresh, reply, model);
    return 'answered';
  }

  /**
   * Every attempt failed: hand the thread over, with a line to the client so
   * they know a person will answer. Nothing when the job's message is no
   * longer the last word — a newer job, or an operator, owns the thread.
   */
  public async giveUp(job: SupportAiReplyJob): Promise<void> {
    const ticket = await this.readTicket(job.ticketId);
    if (ticket === null || !isWaitingOn(ticket, job.messageId)) return;
    const lastClientText = ticket.messages[ticket.messages.length - 1]?.content ?? '';
    await this.handOverWithNote(ticket, SUPPORT_AI_HANDOFF.ERROR, clientLanguage(lastClientText, ticket.user?.language));
  }

  /**
   * The provider client. Protected so a spec can answer for the model; built
   * per job because the operator can change the key or the address at any
   * moment and the next answer must use the new ones.
   */
  protected createClient(settings: AiConfigSettings): SupportAiModelClient {
    return new OpenAI({
      apiKey: settings.apiKey,
      ...(settings.baseUrl.trim().length > 0 ? { baseURL: settings.baseUrl.trim() } : {}),
      timeout: MODEL_TIMEOUT_MS,
      maxRetries: 1,
    });
  }

  /**
   * The tool loop: the model may look up plans and the FAQ and may call the
   * transfer, then answers in words. After {@link MAX_TOOL_ROUNDS} it is asked
   * once more with no tools, so it always ends in text.
   */
  private async runModel(
    client: SupportAiModelClient,
    model: string,
    messages: ChatCompletionMessageParam[],
  ): Promise<{ readonly text: string; readonly transferReason: string | null }> {
    const conversation = [...messages];
    let transferReason: string | null = null;
    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const response = await client.chat.completions.create({
        model,
        messages: conversation,
        tools: [...SUPPORT_AI_TOOLS],
        tool_choice: 'auto',
        temperature: 0.4,
        max_tokens: 800,
      });
      const choice = response.choices[0];
      if (choice === undefined) throw new Error('No completion choices returned');
      const calls = choice.message.tool_calls ?? [];
      if (calls.length === 0) return { text: choice.message.content ?? '', transferReason };
      conversation.push({ role: 'assistant', content: choice.message.content ?? null, tool_calls: calls });
      for (const call of calls) {
        const args = parseArguments(call.function.arguments);
        if (call.function.name === TRANSFER_TOOL) {
          const reason = typeof args['reason'] === 'string' ? args['reason'].trim().slice(0, 200) : '';
          transferReason = reason;
        }
        conversation.push({ role: 'tool', tool_call_id: call.id, content: await this.runTool(call.function.name, args) });
      }
    }
    const last = await client.chat.completions.create({ model, messages: conversation, temperature: 0.4, max_tokens: 800 });
    return { text: last.choices[0]?.message?.content ?? '', transferReason };
  }

  /** One tool call's answer, as the model reads it. Never throws. */
  private async runTool(name: string, args: Record<string, unknown>): Promise<string> {
    try {
      switch (name) {
        case 'get_tariffs':
          return await describeTariffsForModel(this.planCatalog);
        case 'get_faq':
          return await describeFaqForModel(this.faq, typeof args['locale'] === 'string' ? args['locale'] : undefined);
        case TRANSFER_TOOL:
          return JSON.stringify({
            ok: true,
            note: 'Обращение передаётся оператору. Напиши клиенту одно короткое сообщение об этом.',
          });
        default:
          return JSON.stringify({ error: `Неизвестная функция: ${name}` });
      }
    } catch (err: unknown) {
      this.logger.warn(`AI tool ${name} failed: ${describe(err)}`);
      return JSON.stringify({ error: 'Не удалось получить данные.' });
    }
  }

  /**
   * Store the assistant's reply as a support reply and tell the client the way
   * an operator's reply is told — the cabinet feed, the bot, web push.
   */
  private async writeReply(ticket: TicketForAnswer, content: string, model: string | null): Promise<void> {
    await this.tickets.addMessage({
      ticketId: ticket.id,
      authorType: 'ADMIN',
      authorId: null,
      content,
      metadata: model === null ? { ai: true } : { ai: true, model },
    });
    if (ticket.user !== null) {
      void this.notifications.notifyAdminReply({
        ticketId: ticket.id,
        subject: ticket.subject,
        user: { id: ticket.user.id, language: ticket.user.language },
      });
    }
  }

  /** Hand over for one of the panel's reasons; the client gets one line, once. */
  private async handOverWithNote(ticket: TicketForAnswer, reason: string, language: string): Promise<void> {
    if (!(await this.dispatch.handOff(ticket.id, reason))) return;
    await this.writeReply(ticket, handoffNote(language), null);
    // The line is a support reply, and it moved the ticket to «ждёт ответа
    // клиента»; the thread waits on an operator.
    await this.dispatch.reopenForOperator(ticket.id);
  }

  private async readTicket(ticketId: string): Promise<TicketForAnswer | null> {
    const row = await this.prisma.supportTicket.findUnique({
      where: { id: ticketId },
      select: {
        id: true,
        subject: true,
        status: true,
        aiActive: true,
        aiActiveSince: true,
        user: { select: { id: true, language: true } },
        messages: {
          orderBy: { createdAt: 'desc' },
          take: HISTORY_MESSAGES,
          select: {
            id: true,
            authorType: true,
            content: true,
            metadata: true,
            attachments: { select: { filename: true } },
          },
        },
      },
    });
    if (row === null) return null;
    return {
      id: row.id,
      subject: row.subject,
      status: row.status,
      aiActive: row.aiActive,
      aiActiveSince: row.aiActiveSince,
      user: row.user === null ? null : { id: row.user.id, language: row.user.language ?? null },
      messages: [...row.messages].reverse(),
    };
  }
}

/** The assistant leads an open thread whose last word is this client message. */
function isWaitingOn(ticket: TicketForAnswer, messageId: string): boolean {
  if (!ticket.aiActive || ticket.status === SupportTicketStatus.CLOSED) return false;
  const last = ticket.messages[ticket.messages.length - 1];
  return last !== undefined && last.id === messageId && last.authorType === 'USER';
}

function parseArguments(raw: string | undefined): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw ?? '{}');
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
