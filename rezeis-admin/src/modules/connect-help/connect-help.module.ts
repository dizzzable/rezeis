import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { ConnectSignalModule } from '../connect-signal/connect-signal.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AdminConnectHelpController } from './controllers/admin-connect-help.controller';
import { ConnectHelpSettingsService } from './services/connect-help-settings.service';
import { ConnectHelpStatusService } from './services/connect-help-status.service';
import { ConnectHelpSweepService } from './services/connect-help-sweep.service';

/**
 * «Помощь с подключением» — the ACT on the connection signal: the operator's
 * switches and their card, the worker's sender, and the log of every decision.
 *
 * The signal itself (whether a profile ever connected, and whether the panel
 * can currently tell) is `ConnectSignalModule`'s; this module only reads it —
 * the health for "can we know?", the probe's `recheck` for the last look
 * before deciding. The channels are `NotificationsModule`'s ladder.
 */
@Module({
  imports: [AuthModule, ConnectSignalModule, NotificationsModule],
  controllers: [AdminConnectHelpController],
  providers: [ConnectHelpSettingsService, ConnectHelpStatusService, ConnectHelpSweepService],
})
export class ConnectHelpModule {}
