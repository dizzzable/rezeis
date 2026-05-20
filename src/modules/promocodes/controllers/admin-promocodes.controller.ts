import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { CreatePromocodeDto } from '../dto/create-promocode.dto';
import { ListPromocodeActivationsQueryDto } from '../dto/list-promocode-activations-query.dto';
import { UpdatePromocodeDto } from '../dto/update-promocode.dto';
import {
  PromocodeActivationInterface,
  PromocodeInterface,
} from '../interfaces/promocode.interface';
import { PromocodeLifecycleService } from '../services/promocode-lifecycle.service';

interface PromocodeActivationListResponse {
  readonly entries: readonly PromocodeActivationInterface[];
  readonly total: number;
}

@ApiTags('admin/promocodes')
@ApiBearerAuth('JWT')
@UseGuards(AdminJwtAuthGuard)
@Controller('admin/promocodes')
export class AdminPromocodesController {
  public constructor(
    private readonly lifecycleService: PromocodeLifecycleService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List promocodes (newest first)' })
  public list(): Promise<readonly PromocodeInterface[]> {
    return this.lifecycleService.list();
  }

  @Get(':promocodeId')
  @ApiOperation({ summary: 'Get a promocode by id' })
  public getById(@Param('promocodeId') promocodeId: string): Promise<PromocodeInterface> {
    return this.lifecycleService.getById(promocodeId);
  }

  @Post()
  @ApiOperation({ summary: 'Create a promocode' })
  public create(@Body() dto: CreatePromocodeDto): Promise<PromocodeInterface> {
    return this.lifecycleService.create(dto);
  }

  @Patch(':promocodeId')
  @ApiOperation({ summary: 'Patch a promocode' })
  public update(
    @Param('promocodeId') promocodeId: string,
    @Body() dto: UpdatePromocodeDto,
  ): Promise<PromocodeInterface> {
    return this.lifecycleService.update(promocodeId, dto);
  }

  @Delete(':promocodeId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a promocode' })
  public async delete(@Param('promocodeId') promocodeId: string): Promise<void> {
    await this.lifecycleService.delete(promocodeId);
  }

  @Post('generate-code')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Generate a random unique promocode code' })
  public async generateCode(): Promise<{ readonly code: string }> {
    return this.lifecycleService.generateUniqueCode();
  }

  @Get('activations/by-user')
  @ApiOperation({ summary: 'List user activations with pagination' })
  public async listUserActivations(
    @Query() query: ListPromocodeActivationsQueryDto,
  ): Promise<PromocodeActivationListResponse> {
    const limit = query.limit ?? 25;
    const offset = query.offset ?? 0;
    return this.lifecycleService.listUserActivations({
      userId: query.userId,
      limit,
      offset,
    });
  }
}
