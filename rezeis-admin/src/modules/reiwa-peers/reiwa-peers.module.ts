import { Global, Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { AdminReiwaPeersController } from './admin-reiwa-peers.controller';
import { ReiwaCabinetBehindService } from './reiwa-cabinet-behind.service';
import { ReiwaPeerRegistry } from './reiwa-peer-registry.service';

/**
 * ReiwaPeersModule
 * ────────────────
 * What the panel knows about the Reiwa cabinet connected to it (pair
 * reliability, 26.09.2026): the capability registry (`cabinet-capabilities.ts`),
 * the records the cabinet's poll and heartbeat leave (`ReiwaPeerRegistry`),
 * the operator's view of them (`GET /api/admin/reiwa-peers`) and the card
 * «🧩 Кабинет старше панели» (`ReiwaCabinetBehindService`).
 *
 * GLOBAL, for `ReiwaPeerRegistry`: the controllers that record the cabinet
 * (the settings poll, the version heartbeat) and the gates that ask it (the
 * add-on listing and checkout, «Трафик исчерпан», the update checker) live in
 * five modules, and a module import from each would close cycles through the
 * modules this one is read by. The registry needs only `RawCacheService`,
 * itself global; `AuthModule` brings the admin guard's credentials.
 *
 * Imported once, by `AppModule`.
 */
@Global()
@Module({
  imports: [AuthModule],
  controllers: [AdminReiwaPeersController],
  providers: [ReiwaPeerRegistry, ReiwaCabinetBehindService],
  exports: [ReiwaPeerRegistry],
})
export class ReiwaPeersModule {}
