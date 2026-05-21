import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentAdmin } from '../../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import {
  ApiTokenCreateResultInterface,
  ApiTokenListItemInterface,
  ApiTokensService,
} from '../services/api-tokens.service';

import { IsString, MaxLength, MinLength } from 'class-validator';

class CreateApiTokenDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  public name!: string;
}

@ApiTags('admin/api-tokens')
@ApiBearerAuth('JWT')
@UseGuards(AdminJwtAuthGuard)
@Controller('admin/api-tokens')
export class AdminApiTokensController {
  public constructor(private readonly apiTokensService: ApiTokensService) {}

  @Get()
  @ApiOperation({ summary: 'List all API tokens (without full token values)' })
  public list(): Promise<readonly ApiTokenListItemInterface[]> {
    return this.apiTokensService.list();
  }

  @Post()
  @ApiOperation({ summary: 'Create a new named API token' })
  public create(
    @Body() dto: CreateApiTokenDto,
    @CurrentAdmin() admin: CurrentAdminInterface,
  ): Promise<ApiTokenCreateResultInterface> {
    return this.apiTokensService.create({
      name: dto.name,
      createdBy: admin.id,
    });
  }

  @Delete(':tokenId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke (delete) an API token' })
  public async delete(@Param('tokenId') tokenId: string): Promise<void> {
    await this.apiTokensService.delete(tokenId);
  }
}
