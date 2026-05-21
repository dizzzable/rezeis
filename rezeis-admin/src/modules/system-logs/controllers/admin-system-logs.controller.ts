import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../../rbac/guards/rbac.guard';
import { SetLogLevelDto, SystemLogsQueryDto } from '../dto/system-logs.dto';
import { SystemLogsService } from '../services/system-logs.service';

@ApiTags('admin/system-logs')
@ApiBearerAuth('JWT')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
@Controller('admin/system-logs')
export class AdminSystemLogsController {
  public constructor(private readonly systemLogsService: SystemLogsService) {}

  @Get()
  @RequirePermission('system_logs', 'view')
  @ApiOperation({ summary: 'Returns recent log lines, supports cursor (`afterId`) for live tailing' })
  public list(@Query() query: SystemLogsQueryDto) {
    return this.systemLogsService.getLogs({
      limit: query.limit,
      afterId: query.afterId,
      level: query.level,
      context: query.context,
      search: query.search,
    });
  }

  @Get('level')
  @RequirePermission('system_logs', 'view')
  @ApiOperation({ summary: 'Returns the current log level' })
  public getLevel() {
    return { level: this.systemLogsService.getLogLevel() };
  }

  @Patch('level')
  @RequirePermission('system_logs', 'edit')
  @ApiOperation({ summary: 'Changes the active log level at runtime' })
  public setLevel(@Body() dto: SetLogLevelDto) {
    this.systemLogsService.setLogLevel(dto.level);
    return { level: this.systemLogsService.getLogLevel() };
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('system_logs', 'delete')
  @ApiOperation({ summary: 'Clears the in-memory log buffer' })
  public clear() {
    this.systemLogsService.clearLogs();
  }
}
