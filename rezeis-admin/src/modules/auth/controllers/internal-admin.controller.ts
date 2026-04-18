import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';

import { CurrentInternalRequest } from '../decorators/current-internal-request.decorator';
import { BootstrapAdminDto } from '../dto/bootstrap-admin.dto';
import { InternalAdminAuthGuard } from '../guards/internal-admin-auth.guard';
import { InternalAdminRequest } from '../interfaces/internal-admin-request.interface';
import { CurrentAdminInterface } from '../interfaces/current-admin.interface';
import { AdminAuthService } from '../services/admin-auth.service';
import { InternalAdminService } from '../services/internal-admin.service';

interface InternalAdminTestResponse {
  readonly status: string;
  readonly service: string;
  readonly auth: {
    readonly type: string;
    readonly isAuthorized: boolean;
  };
  readonly request: InternalAdminRequest;
  readonly timestamp: string;
}

interface BootstrapAdminResponse {
  readonly admin: CurrentAdminInterface;
}

/**
 * Exposes protected internal admin endpoints.
 */
@Controller('internal')
export class InternalAdminController {
  public constructor(
    private readonly adminAuthService: AdminAuthService,
    private readonly internalAdminService: InternalAdminService,
  ) {}

  /**
   * Returns a protected internal admin smoke test response.
   */
  @Get('test')
  @UseGuards(InternalAdminAuthGuard)
  public getTest(
    @CurrentInternalRequest() request: InternalAdminRequest,
  ): InternalAdminTestResponse {
    return this.internalAdminService.getTestResponse(request);
  }

  /**
   * Creates the first DEV admin user through the internal bootstrap flow.
   */
  @Post('bootstrap-admin')
  @UseGuards(InternalAdminAuthGuard)
  public async bootstrapAdmin(
    @Body() bootstrapAdminDto: BootstrapAdminDto,
    @CurrentInternalRequest() request: InternalAdminRequest,
  ): Promise<BootstrapAdminResponse> {
    const admin: CurrentAdminInterface = await this.adminAuthService.bootstrapFirstAdmin({
      login: bootstrapAdminDto.login,
      email: bootstrapAdminDto.email,
      password: bootstrapAdminDto.password,
      name: bootstrapAdminDto.name,
      requestMetadata: request,
    });
    return { admin };
  }
}
