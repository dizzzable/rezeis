import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';

import { CurrentAdmin } from './decorators/current-admin.decorator';
import { LoginAdminDto } from './dto/login-admin.dto';
import { AdminJwtAuthGuard } from './guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from './interfaces/current-admin.interface';
import { AdminAuthService } from './services/admin-auth.service';
import { extractRequestMetadata } from './utils/request-metadata.util';

interface LoginAdminResponse {
  readonly accessToken: string;
  readonly tokenType: 'Bearer';
  readonly expiresIn: string;
  readonly admin: CurrentAdminInterface;
}

interface MeResponse {
  readonly admin: CurrentAdminInterface;
}

/**
 * Exposes admin authentication endpoints.
 */
@Controller('auth')
export class AuthController {
  public constructor(private readonly adminAuthService: AdminAuthService) {}

  /**
   * Authenticates an admin user and issues an access token.
   */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  public async login(
    @Body() loginAdminDto: LoginAdminDto,
    @Req() request: Request,
  ): Promise<LoginAdminResponse> {
    return this.adminAuthService.loginAdmin({
      login: loginAdminDto.login,
      password: loginAdminDto.password,
      requestMetadata: extractRequestMetadata(request),
    });
  }

  /**
   * Returns the authenticated admin profile.
   */
  @Get('me')
  @UseGuards(AdminJwtAuthGuard)
  public getMe(@CurrentAdmin() currentAdmin: CurrentAdminInterface): MeResponse {
    return {
      admin: this.adminAuthService.getMe(currentAdmin),
    };
  }
}
