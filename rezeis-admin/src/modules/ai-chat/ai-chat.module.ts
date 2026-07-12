import { Module } from '@nestjs/common';

import { PrismaModule } from '../../common/prisma/prisma.module';
import { AiChatController } from './controllers/ai-chat.controller';
import { AiChatService } from './services/ai-chat.service';

/**
 * AI Chat module — provides OpenAI-powered conversational support
 * for users via a REST API. Uses the `openai` SDK to stream or
 * respond to user messages with context from the knowledge base.
 *
 * Configuration (all optional, set via .env):
 *   `OPENAI_API_KEY` — API key for the OpenAI-compatible provider.
 *   `OPENAI_API_URL` — Base URL (defaults to https://api.openai.com/v1).
 *   `OPENAI_MODEL`   — Model identifier (defaults to gpt-4o-mini).
 *
 * When `OPENAI_API_KEY` is absent the service degrades gracefully
 * and returns an informative message to the caller.
 */
@Module({
  imports: [PrismaModule],
  controllers: [AiChatController],
  providers: [AiChatService],
  exports: [AiChatService],
})
export class AiChatModule {}
