import { Controller, Get, UseGuards } from '@nestjs/common';

import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { RemnawaveStatusInterface } from '../interfaces/remnawave-status.interface';
import { RemnawaveApiService } from '../services/remnawave-api.service';

@Controller('admin/remnawave')
@UseGuards(AdminJwtAuthGuard)
export class AdminRemnawaveController {
  public constructor(private readonly remnawaveApiService: RemnawaveApiService) {}

  @Get('status')
  public async getStatus(): Promise<RemnawaveStatusInterface> {
    return this.remnawaveApiService.getStatus();
  }
}
