import { Module } from '@nestjs/common';

import { AiConfigModule } from '../ai-config/ai-config.module';
import { FaqModule } from '../faq/faq.module';
import { PlansModule } from '../plans/plans.module';
import { SupportTicketsModule } from '../support-tickets/support-tickets.module';
import { SupportAiProcessor } from './support-ai.processor';
import { SupportAiResponderService } from './support-ai-responder.service';

/**
 * The AI assistant answering inside support tickets — the model and its
 * worker. Whether it leads a thread, the queue and the hand-over live in
 * `SupportTicketsModule` (`SupportAiDispatchService`); this module depends on
 * that one and never the other way round, because the plan catalogue its
 * `get_tariffs` tool reads pulls in a module graph the support module must
 * stay out of.
 *
 * The `support-ai` queue is registered there; the worker finds it by name
 * across the application.
 */
@Module({
  imports: [SupportTicketsModule, AiConfigModule, FaqModule, PlansModule],
  providers: [SupportAiResponderService, SupportAiProcessor],
})
export class SupportAiModule {}
