import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { ReiwaCacheInvalidatorService } from '../bot-config/services/reiwa-cache-invalidator.service';
import { AdminLegalDocumentsController } from './controllers/admin-legal-documents.controller';
import { InternalLegalDocumentsController } from './controllers/internal-legal-documents.controller';
import { LegalDocumentsService } from './services/legal-documents.service';

/**
 * Legal documents: the user agreement and the public offer.
 *
 * `ReiwaCacheInvalidatorService` is provided here rather than imported from
 * `BotConfigModule` — it is a stateless webhook dispatcher built from env, so a
 * second instance costs nothing. `BotFlowModule` declares its own for the same
 * reason; `LandingConfigModule` imports `BotConfigModule` instead. Declaring it
 * avoids pulling the whole bot editor into the dependency graph of a two-table
 * content module.
 */
@Module({
  imports: [AuthModule],
  controllers: [AdminLegalDocumentsController, InternalLegalDocumentsController],
  providers: [LegalDocumentsService, ReiwaCacheInvalidatorService],
  exports: [LegalDocumentsService],
})
export class LegalDocumentsModule {}
