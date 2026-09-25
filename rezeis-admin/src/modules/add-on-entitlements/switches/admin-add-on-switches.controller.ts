import { Body, Controller, Get, Patch, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';

import { CurrentAdmin } from '../../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { extractRequestMetadata } from '../../auth/utils/request-metadata.util';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../../rbac/guards/rbac.guard';
import { AddOnSwitchesService, AddOnSwitchesView } from './add-on-switches.service';
import { UpdateAddOnSwitchesDto } from './update-add-on-switches.dto';

/**
 * «Доп. услуги» → «Настройки»: the switches of the durable add-on model, and
 * «Часовой пояс Remnawave» beside them.
 *
 * The permissions are the page's own: `add_ons:view` to see them, as for the
 * catalogue beside them, and `add_ons:edit` to change them — the permission
 * that already edits the add-ons these switches decide the fate of.
 *
 * Its own path rather than `admin/add-ons/settings`: `PATCH admin/add-ons/:id`
 * would take `settings` for an add-on id.
 */
@Controller('admin/add-on-settings')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
@RequirePermission('add_ons', 'view')
export class AdminAddOnSwitchesController {
  public constructor(private readonly addOnSwitches: AddOnSwitchesService) {}

  @Get()
  public view(): Promise<AddOnSwitchesView> {
    return this.addOnSwitches.view();
  }

  @Patch()
  @RequirePermission('add_ons', 'edit')
  public update(
    @Body() dto: UpdateAddOnSwitchesDto,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() request: Request,
  ): Promise<AddOnSwitchesView> {
    return this.addOnSwitches.update({
      currentAdmin,
      requestMetadata: extractRequestMetadata(request),
      changes: {
        ...(dto.durableAccounting === undefined ? {} : { durableAccounting: dto.durableAccounting }),
        ...(dto.deviceCleanupAuto === undefined ? {} : { deviceCleanupAuto: dto.deviceCleanupAuto }),
        ...(dto.trafficResetExpiry === undefined ? {} : { trafficResetExpiry: dto.trafficResetExpiry }),
      },
      confirmOff: dto.confirmOff === true,
      ...(dto.remnawaveTimeZone === undefined ? {} : { remnawaveTimeZone: dto.remnawaveTimeZone }),
    });
  }
}
