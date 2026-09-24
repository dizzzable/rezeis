import { Module } from '@nestjs/common';

import { AuthModule } from '../../auth/auth.module';
import { SettingsModule } from '../../settings/settings.module';
import { AdminAddOnSwitchesController } from './admin-add-on-switches.controller';
import { AddOnSwitchesService } from './add-on-switches.service';

/**
 * The switches of the durable add-on model («Доп. услуги» → «Настройки») and
 * the one service every stage reader asks (`AddOnSwitchesService.flags`).
 *
 * IMPORTED, NOT GLOBAL. Every module that declares a reader of the flags
 * imports this one, and `test/add-on-switches-module-wiring.spec.ts` finds
 * those readers in the tree and holds each declaring module to it. The readers
 * take the service `@Optional()` only so the unit specs can build them by
 * hand; without this import Nest would inject nothing, and the running panel
 * would quietly go back to `.env` and the defaults — the switch on the page
 * doing nothing, which is the one failure this module must not have.
 */
@Module({
  imports: [AuthModule, SettingsModule],
  controllers: [AdminAddOnSwitchesController],
  providers: [AddOnSwitchesService],
  exports: [AddOnSwitchesService],
})
export class AddOnSwitchesModule {}
