import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';

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
// NOT THROTTLED PER ADDRESS. Every call here comes from the cabinet’s
// backend — one address, on behalf of every customer at once — so the global
// 600/minute per-IP limit was 600 requests a minute for the whole customer
// base together, and past it the cabinet stopped working for everybody. The
// argument in full, including why a per-address limit protects nothing on a
// route behind `InternalAdminAuthGuard`, is on
// `src/modules/user-hints/controllers/internal-user-hints.controller.ts`.
@SkipThrottle()
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
