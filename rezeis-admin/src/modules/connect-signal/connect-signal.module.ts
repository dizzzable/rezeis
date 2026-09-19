import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { RemnawaveModule } from '../remnawave/remnawave.module';
import { InternalConnectHelpController } from './controllers/internal-connect-help.controller';
import { ConnectSignalHealthService } from './services/connect-signal-health.service';
import { ConnectSignalProbeService } from './services/connect-signal-probe.service';

/**
 * «Купил, но не подключился» — the SIGNAL: whether each subscription's VPN
 * profile ever connected, and whether the panel can currently tell.
 *
 * The writers the webhook and the cabinet read use are plain functions
 * (`connect-evidence.util.ts`), called without this module, so the remnawave
 * and internal-user modules never import it and no module cycle can form. Only
 * the probe needs the panel adapter, which is why this module imports
 * `RemnawaveModule` and not the other way round.
 *
 * Exported for the packages that act on the signal: the health for the
 * sender's and the broadcasts' "can we know?" and the probe's `recheck` for
 * the sender's last look before it decides.
 */
@Module({
  imports: [AuthModule, RemnawaveModule],
  controllers: [InternalConnectHelpController],
  providers: [ConnectSignalProbeService, ConnectSignalHealthService],
  exports: [ConnectSignalProbeService, ConnectSignalHealthService],
})
export class ConnectSignalModule {}
