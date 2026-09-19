import { Module } from '@nestjs/common';

import { ConnectSignalModule } from '../connect-signal/connect-signal.module';
import { ConnectAudienceService } from './services/connect-audience.service';

/**
 * «Купил, но не подключился» — the AUDIENCE: who, as people, for the broadcast
 * filter «Подключение VPN» and the hint audiences.
 *
 * Imports the signal module for its health only; the definitions it composes
 * (`connect-signal/connect-sql.ts`) are plain SQL fragments and need no module.
 * Nothing the signal module imports reaches back here, so no cycle can form.
 */
@Module({
  imports: [ConnectSignalModule],
  providers: [ConnectAudienceService],
  exports: [ConnectAudienceService],
})
export class ConnectAudienceModule {}
