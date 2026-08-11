import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { OlcrtcAdminController } from './olcrtc.admin.controller';
import { OlcrtcAdminService } from './olcrtc-admin.service';
import { OlcrtcLifecycleService } from './olcrtc-lifecycle.service';
import { OlcrtcInternalController } from './olcrtc.internal.controller';
import { OlcrtcProvisioningService } from './olcrtc-provisioning.service';

@Module({
  imports: [AuthModule],
  controllers: [OlcrtcInternalController, OlcrtcAdminController],
  providers: [OlcrtcProvisioningService, OlcrtcLifecycleService, OlcrtcAdminService],
  exports: [OlcrtcProvisioningService, OlcrtcLifecycleService, OlcrtcAdminService],
})
export class OlcrtcModule {}
