import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { AiConfigService } from './ai-config.service.js';
import { AiInstructionService } from './ai-instruction.service.js';
import { anonymizeTranscript } from '../utils/anonymize.js';

export interface LearnFromTicketsResult {
  readonly scanned: number;
  readonly created: number;
  readonly skipped: number;
}

/**
 * Safe "learn from ticket history" pipeline.
 *
 * For each recently CLOSED ticket it builds a transcript, ANONYMISES it
 * (strips emails, links, card-like numbers, IPs, handles, long tokens), asks
 * the configured LLM to distil a GENERALISED, PII-free Q→A knowledge entry, and
 * stores it as a DRAFT instruction (`isActive: false`). Drafts never reach the
 * assistant until an operator reviews and activates them — so raw user data is
 * never auto-exposed to other users. Idempotent per ticket (slug `learned-<id>`).
 */
@Injectable()
export class AiLearningService {
  private readonly logger = new Logger(AiLearningService.name);
  /** Single-flight guard — one learning run at a time (bounds cost/long requests). */
  private running = false;

  public constructor(
    private readonly prisma: PrismaService,
    private readonly httpService: HttpService,
    private readonly aiConfigService: AiConfigService,
    private readonly aiInstructionService: AiInstructionService,
  ) {}

  public async learnFromTickets(limit = 30): Promise<LearnFromTicketsResult> {
    if (this.running) {
      throw new BadRequestException('AI_LEARNING_ALREADY_RUNNING');
    }
    this.running = true;
    try {
      return await this.run(limit);
    } finally {
      this.running = false;
    }
  }

  private async run(limit: number): Promise<LearnFromTicketsResult> {
    const config = await this.aiConfigService.getSettings();
    if (!config.apiKey || !config.baseUrl) {
      throw new BadRequestException('AI_CONFIG_NOT_CONFIGURED');
    }

    const take = Math.min(Math.max(Math.trunc(limit) || 0, 1), 50);
    const tickets = await this.prisma.supportTicket.findMany({
      where: { status: 'CLOSED' },
      orderBy: { closedAt: 'desc' },
      take,
      select: {
        id: true,
        subject: true,
        messages: {
          orderBy: { createdAt: 'asc' },
          take: 40,
          select: { authorType: true, content: true },
        },
      },
    });

    let created = 0;
    let skipped = 0;
    for (const ticket of tickets) {
      try {
        const slug = `learned-${ticket.id}`;
        const existing = await this.prisma.aiInstruction.findUnique({ where: { slug } });
        if (existing) {
          skipped += 1;
          continue;
        }

        const transcript = anonymizeTranscript(this.buildTranscript(ticket.messages));
        if (transcript.trim().length < 20) {
          skipped += 1;
          continue;
        }

        // The subject is user-authored too — scrub it before it reaches the LLM
        // or the stored draft title.
        const safeSubject = anonymizeTranscript(ticket.subject, 120);
        const entry = await this.summarizeTicket(config, safeSubject, transcript);
        // Strip leading quotes/backticks/asterisks the model may wrap around a
        // bare SKIP before checking the sentinel.
        const cleaned = entry.trim().replace(/^[`"'*\s]+/, '');
        if (cleaned.length === 0 || /^skip\b/i.test(cleaned)) {
          skipped += 1;
          continue;
        }

        await this.aiInstructionService.create({
          title: `Из тикета: ${safeSubject.slice(0, 60)}`,
          slug,
          content: cleaned.slice(0, 4000),
          category: 'learned',
          isActive: false, // DRAFT — operator must review + activate.
        });
        created += 1;
      } catch (error: unknown) {
        // A single bad ticket must not abort the whole run.
        const message = error instanceof Error ? error.message : 'Unknown error';
        this.logger.warn(`learnFromTickets skipped a ticket: ${message}`);
        skipped += 1;
      }
    }

    return { scanned: tickets.length, created, skipped };
  }

  private buildTranscript(
    messages: ReadonlyArray<{ authorType: string; content: string }>,
  ): string {
    // Only USER/ADMIN turns — SYSTEM messages may carry internal notes and are
    // never fed to the LLM.
    return messages
      .filter((m) => m.authorType === 'USER' || m.authorType === 'ADMIN')
      .map((m) => `${m.authorType === 'USER' ? 'Пользователь' : 'Оператор'}: ${m.content}`)
      .join('\n');
  }

  private async summarizeTicket(
    config: { baseUrl: string; apiKey: string; model: string },
    subject: string,
    transcript: string,
  ): Promise<string> {
    const endpoint = `${config.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const system = `Ты формируешь обезличенную запись в базу знаний службы поддержки из УЖЕ РЕШЁННОГО тикета.
ПРАВИЛА:
- Верни краткую обобщённую пару «Вопрос → Ответ», применимую к другим пользователям.
- НИКОГДА не включай: имена, e-mail, id, номера/реквизиты, промокоды, ключи, токены, ссылки, IP, любые персональные данные.
- Если тикет не несёт повторно применимого знания или содержит только частный случай — верни РОВНО «SKIP».
- Пиши по-русски, максимум ~500 символов.`;
    const user = `Тема: ${subject}\n\nДиалог (обезличенный):\n${transcript}\n\nЗапись для базы знаний:`;

    const { data } = await firstValueFrom(
      this.httpService.post(
        endpoint,
        {
          model: config.model || 'gpt-4o-mini',
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          max_tokens: 400,
        },
        {
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 30_000,
        },
      ),
    );

    const choice = (data as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0];
    return choice?.message?.content ?? '';
  }
}
