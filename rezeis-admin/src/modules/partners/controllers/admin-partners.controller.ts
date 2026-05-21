import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';

import { CurrentAdmin } from '../../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { extractRequestMetadata } from '../../auth/utils/request-metadata.util';
import { AdjustPartnerBalanceDto } from '../dto/adjust-partner-balance.dto';
import {
  ListPartnersQueryDto,
  ListPartnerWithdrawalsQueryDto,
} from '../dto/list-partners-query.dto';
import { ProcessPartnerWithdrawalDto } from '../dto/process-partner-withdrawal.dto';
import {
  PartnerInterface,
  PartnerStatsInterface,
  PartnerWithdrawalInterface,
} from '../interfaces/partner.interface';
import { PartnersService } from '../services/partners.service';

@ApiTags('admin/partners')
@ApiBearerAuth('JWT')
@UseGuards(AdminJwtAuthGuard)
@Controller('admin/partners')
export class AdminPartnersController {
  public constructor(private readonly partnersService: PartnersService) {}

  @Get()
  @ApiOperation({ summary: 'List partners' })
  public list(
    @Query() query: ListPartnersQueryDto,
  ): Promise<readonly PartnerInterface[]> {
    return this.partnersService.listPartners(query);
  }

  @Get('stats')
  @ApiOperation({ summary: 'Bounded partner stats snapshot' })
  public getStats(): Promise<PartnerStatsInterface> {
    return this.partnersService.getStats();
  }

  @Get('withdrawals')
  @ApiOperation({ summary: 'List partner withdrawals' })
  public listWithdrawals(
    @Query() query: ListPartnerWithdrawalsQueryDto,
  ): Promise<readonly PartnerWithdrawalInterface[]> {
    return this.partnersService.listWithdrawals(query);
  }

  @Post('withdrawals/:withdrawalId/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve a pending partner withdrawal' })
  public approve(
    @Param('withdrawalId') withdrawalId: string,
    @Body() dto: ProcessPartnerWithdrawalDto,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() request: Request,
  ): Promise<PartnerWithdrawalInterface> {
    return this.partnersService.approveWithdrawal({
      withdrawalId,
      dto,
      currentAdmin,
      requestMetadata: extractRequestMetadata(request),
    });
  }

  @Post('withdrawals/:withdrawalId/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject a pending partner withdrawal (restores balance)' })
  public reject(
    @Param('withdrawalId') withdrawalId: string,
    @Body() dto: ProcessPartnerWithdrawalDto,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() request: Request,
  ): Promise<PartnerWithdrawalInterface> {
    return this.partnersService.rejectWithdrawal({
      withdrawalId,
      dto,
      currentAdmin,
      requestMetadata: extractRequestMetadata(request),
    });
  }

  @Post(':partnerId/toggle')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Toggle partner active/inactive status' })
  public toggle(
    @Param('partnerId') partnerId: string,
  ): Promise<PartnerInterface> {
    return this.partnersService.togglePartnerStatus(partnerId);
  }

  @Post(':partnerId/adjust-balance')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Manually adjust partner balance (positive = credit, negative = debit)' })
  public adjustBalance(
    @Param('partnerId') partnerId: string,
    @Body() dto: AdjustPartnerBalanceDto,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() request: Request,
  ): Promise<PartnerInterface> {
    return this.partnersService.adjustBalance({
      partnerId,
      amount: dto.amount,
      reason: dto.reason ?? null,
      currentAdmin,
      requestMetadata: extractRequestMetadata(request),
    });
  }
}
