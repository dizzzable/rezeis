import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';

import { appConfig } from '../../../common/config/app.config';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { ChangeAdminPasswordDto } from '../dto/change-password.dto';
import { CurrentAdmin } from '../decorators/current-admin.decorator';
import { PublicLoginAdminDto } from '../dto/public-login-admin.dto';
import { RegisterAdminDto } from '../dto/register-admin.dto';
import { AdminJwtAuthGuard } from '../guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../interfaces/current-admin.interface';
import { AdminAuthService } from '../services/admin-auth.service';
import { extractRequestMetadata } from '../utils/request-metadata.util';
import { Public } from '../../../common/decorators/public.decorator';

interface AuthStatusResponse {
  readonly hasAdmins: boolean;
  /**
   * Operator-configured locales advertised to the SPA so the very first
   * paint can match `REZEIS_DEFAULT_LOCALE` from the deployment `.env`.
   */
  readonly locales: readonly string[];
  readonly defaultLocale: string;
}

interface AuthSessionResponse {
  readonly accessToken: string;
  readonly tokenType: 'Bearer';
  readonly expiresIn: string;
  readonly admin: CurrentAdminInterface;
}

interface AdminMeResponse {
  readonly admin: CurrentAdminInterface;
}

/**
 * Public, unauthenticated admin auth surface used by the admin web UI.
 *
 * - `GET  /admin/auth/status`   — bootstrap discovery: lets the UI choose
 *   between the register-first-admin flow and the regular login flow.
 * - `POST /admin/auth/register` — accepts the first-admin registration
 *   payload only while the admin table is empty.
 * - `POST /admin/auth/login`    — issues a JWT for an existing admin.
 * - `GET  /admin/auth/me`       — JWT-protected current-admin profile.
 */
@ApiTags('admin/auth')
@Controller('admin/auth')
export class AdminAuthController {
  public constructor(
    private readonly adminAuthService: AdminAuthService,
    private readonly prismaService: PrismaService,
    @Inject(appConfig.KEY)
    private readonly appConfiguration: ConfigType<typeof appConfig>,
  ) {}

  @Get('status')
  @Public()
  @ApiOperation({ summary: 'Reports whether at least one admin exists' })
  @ApiOkResponse({ description: 'Bootstrap discovery result' })
  public async getStatus(): Promise<AuthStatusResponse> {
    const adminCount: number = await this.prismaService.adminUser.count();
    return {
      hasAdmins: adminCount > 0,
      locales: this.appConfiguration.locales,
      defaultLocale: this.appConfiguration.defaultLocale,
    };
  }

  @Post('register')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Registers the first DEV admin when the admin table is empty',
  })
  public async register(
    @Body() dto: RegisterAdminDto,
    @Req() request: Request,
  ): Promise<AuthSessionResponse> {
    const requestMetadata = extractRequestMetadata(request);
    await this.adminAuthService.bootstrapFirstAdmin({
      login: dto.username,
      email: dto.email,
      password: dto.password,
      name: dto.name,
      requestMetadata,
    });
    return this.adminAuthService.loginAdmin({
      login: dto.username,
      password: dto.password,
      requestMetadata,
    });
  }

  @Post('login')
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Authenticates an admin and issues a JWT' })
  public async login(
    @Body() dto: PublicLoginAdminDto,
    @Req() request: Request,
  ): Promise<AuthSessionResponse> {
    const requestMetadata = extractRequestMetadata(request);
    try {
      return await this.adminAuthService.loginAdmin({
        login: dto.username,
        password: dto.password,
        totpCode: dto.totpCode ?? null,
        requestMetadata,
      });
    } catch (err) {
      // Surface the structured `totp_required` signal so the UI can pivot
      // to the second-factor screen without showing a generic auth error.
      if (
        err instanceof UnauthorizedException &&
        (err.getResponse() as { message?: string }).message === 'totp_required'
      ) {
        throw new UnauthorizedException({
          statusCode: 401,
          code: 'totp_required',
          message: 'Two-factor authentication required',
        });
      }
      throw err;
    }
  }

  @Get('me')
  @UseGuards(AdminJwtAuthGuard)
  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'Returns the authenticated admin profile' })
  public getMe(@CurrentAdmin() currentAdmin: CurrentAdminInterface): AdminMeResponse {
    return { admin: this.adminAuthService.getMe(currentAdmin) };
  }

  @Post('password')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AdminJwtAuthGuard)
  @ApiBearerAuth('JWT')
  @ApiOperation({
    summary:
      'Rotates the authenticated admin password. Clears `mustChangePassword` and bumps `tokenVersion`.',
  })
  public async changePassword(
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Body() dto: ChangeAdminPasswordDto,
    @Req() request: Request,
  ): Promise<AuthSessionResponse> {
    const requestMetadata = extractRequestMetadata(request);
    return this.adminAuthService.changePassword({
      adminId: currentAdmin.id,
      currentPassword: dto.currentPassword,
      newPassword: dto.newPassword,
      requestMetadata,
    });
  }
}
