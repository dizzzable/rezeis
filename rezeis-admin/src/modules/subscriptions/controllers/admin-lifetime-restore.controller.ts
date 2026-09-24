import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsNotEmpty,
  IsString,
  MaxLength,
} from 'class-validator';
import { Request } from 'express';

import { CurrentAdmin } from '../../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { extractRequestMetadata } from '../../auth/utils/request-metadata.util';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../../rbac/guards/rbac.guard';
import {
  LIFETIME_RESTORE_MAX_IDS,
  LifetimeCensusResponse,
  LifetimeRestoreResponse,
  LifetimeRestoreService,
} from '../services/lifetime-restore.service';

/**
 * `POST` body: the subscriptions the operator pressed «Вернуть бессрочность»
 * for — 1 to {@link LIFETIME_RESTORE_MAX_IDS} distinct ids. Anything else is a
 * 400 from the global `ValidationPipe`, before a single row is locked. The ids
 * are bounded in length too: a subscription id is a cuid, and a megabyte of
 * text has no business reaching a `WHERE`.
 */
export class LifetimeRestoreBodyDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(LIFETIME_RESTORE_MAX_IDS)
  @ArrayUnique()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(64, { each: true })
  public readonly subscriptionIds!: string[];
}

/**
 * «Подписки» → «Инструменты» → «Бессрочные подписки с датой».
 *
 * `GET` lists the subscriptions sold without an end date that carry one now
 * (DELETED ones never); `POST` restores the ones the operator chose, each on its
 * own — see `LifetimeRestoreService`. Both are `subscriptions:edit`: the list
 * exists only to be acted on, and the action moves dates, statuses, add-ons and
 * a Remnawave profile.
 */
@Controller('admin/subscriptions/lifetime-restore')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
export class AdminLifetimeRestoreController {
  public constructor(private readonly lifetimeRestoreService: LifetimeRestoreService) {}

  @Get()
  @RequirePermission('subscriptions', 'edit')
  public census(): Promise<LifetimeCensusResponse> {
    return this.lifetimeRestoreService.census();
  }

  /**
   * 200 with one result per id, in the order given — a refusal or a failure of
   * one id is an outcome in its row, never an error for the whole request.
   * The audit row is written per restored subscription, inside its own
   * transaction, with this request's address and client.
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  @RequirePermission('subscriptions', 'edit')
  public restore(
    @Body() body: LifetimeRestoreBodyDto,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ): Promise<LifetimeRestoreResponse> {
    return this.lifetimeRestoreService.restore(body.subscriptionIds, admin, extractRequestMetadata(req));
  }
}
