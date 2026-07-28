import { Body, Controller, Get, Post, Put, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';

import { CurrentAdmin } from '../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../auth/guards/admin-jwt-auth.guard';
import { InternalAdminAuthGuard } from '../auth/guards/internal-admin-auth.guard';
import { CurrentAdminInterface } from '../auth/interfaces/current-admin.interface';
import { extractRequestMetadata } from '../auth/utils/request-metadata.util';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../rbac/guards/rbac.guard';
import {
  QuoteTariffConstructorDto,
  SaveTariffConstructorDraftDto,
  ToggleTariffConstructorDto,
} from './dto/tariff-constructor.dto';
import {
  AdminTariffConstructorOutput,
  TariffConstructorManifestOutput,
  TariffConstructorQuoteOutput,
  TariffConstructorService,
} from './tariff-constructor.service';

@Controller('admin/tariff-constructors')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
@RequirePermission('plans', 'view')
export class AdminTariffConstructorController {
  public constructor(private readonly service: TariffConstructorService) {}

  @Get()
  public list(): Promise<AdminTariffConstructorOutput[]> {
    return this.service.list();
  }

  @Get('default')
  public get(): Promise<AdminTariffConstructorOutput> {
    return this.service.get();
  }

  @Put('default/draft')
  @RequirePermission('plans', 'create')
  public saveDraft(
    @Body() input: SaveTariffConstructorDraftDto,
    @CurrentAdmin() actor: CurrentAdminInterface,
    @Req() request: Request,
  ): Promise<AdminTariffConstructorOutput> {
    return this.service.saveDraft(input, actor, extractRequestMetadata(request));
  }

  @Post('default/publish')
  @RequirePermission('plans', 'edit')
  public publish(
    @CurrentAdmin() actor: CurrentAdminInterface,
    @Req() request: Request,
  ): Promise<{ revisionId: string; version: number }> {
    return this.service.publish(actor, extractRequestMetadata(request));
  }

  @Put('default/enabled')
  @RequirePermission('plans', 'edit')
  public toggle(
    @Body() input: ToggleTariffConstructorDto,
    @CurrentAdmin() actor: CurrentAdminInterface,
    @Req() request: Request,
  ): Promise<{ enabled: boolean }> {
    return this.service.toggle(input.enabled, actor, extractRequestMetadata(request));
  }
}

@Controller('internal/tariff-constructor')
@UseGuards(InternalAdminAuthGuard)
export class InternalTariffConstructorController {
  public constructor(private readonly service: TariffConstructorService) {}

  @Get('manifest')
  public manifest(): Promise<TariffConstructorManifestOutput> {
    return this.service.manifest();
  }

  @Post('quote')
  public quote(@Body() input: QuoteTariffConstructorDto): Promise<TariffConstructorQuoteOutput> {
    return this.service.quote(input);
  }
}
