import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, MaxLength } from 'class-validator';

import { CurrentAdmin } from '../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../auth/interfaces/current-admin.interface';
import { SystemEventsService } from '../../common/services/system-events.service';

class ClientErrorReportDto {
  @IsString()
  @MaxLength(2_000)
  message!: string;

  @IsOptional()
  @IsString()
  @MaxLength(8_000)
  stack?: string;

  @IsIn(['window.error', 'unhandledrejection'])
  source!: 'window.error' | 'unhandledrejection';

  @IsString()
  @MaxLength(2_000)
  url!: string;

  @IsString()
  @MaxLength(512)
  userAgent!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  filename?: string;

  @IsOptional()
  @IsInt()
  lineno?: number;

  @IsOptional()
  @IsInt()
  colno?: number;

  @IsISO8601()
  capturedAt!: string;
}

@ApiTags('admin/client-errors')
@ApiBearerAuth('JWT')
@UseGuards(AdminJwtAuthGuard)
@Controller('admin/client-errors')
export class ClientErrorsController {
  public constructor(private readonly systemEventsService: SystemEventsService) {}

  @Post()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Receives an SPA error report and forwards it to the audit/event bus' })
  public report(
    @Body() dto: ClientErrorReportDto,
    @CurrentAdmin() admin: CurrentAdminInterface,
  ): void {
    // Severity is fixed at WARNING — frontend errors should be visible
    // but rarely require operator action. The bus persists them to
    // audit + ships through the realtime channel.
    this.systemEventsService.warn(
      'client.error',
      'SYSTEM',
      truncate(dto.message, 200),
      {
        source: dto.source,
        url: dto.url,
        userAgent: dto.userAgent,
        filename: dto.filename,
        lineno: dto.lineno,
        colno: dto.colno,
        stack: dto.stack ? truncate(dto.stack, 4_000) : undefined,
        capturedAt: dto.capturedAt,
        adminId: admin.id,
        adminLogin: admin.login,
      },
    );
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
