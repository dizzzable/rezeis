import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../../rbac/guards/rbac.guard';
import {
  ALL_SECTIONS_LITERAL,
  ConfigExportQueryDto,
  ConfigImportDto,
} from '../dto/config-import.dto';
import {
  ALL_SECTIONS,
  ConfigExportPayloadInterface,
  ConfigExportSection,
  ConfigExportService,
} from '../services/config-export.service';
import { ConfigImportService } from '../services/config-import.service';

const SECTION_SET = new Set<string>(ALL_SECTIONS_LITERAL);

@ApiTags('admin/config')
@ApiBearerAuth('JWT')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
@Controller('admin/config')
export class AdminConfigPortabilityController {
  public constructor(
    private readonly exportService: ConfigExportService,
    private readonly importService: ConfigImportService,
  ) {}

  @Get('sections')
  @RequirePermission('config_portability', 'view')
  @ApiOperation({ summary: 'Lists the canonical export sections' })
  public listSections() {
    return { sections: ALL_SECTIONS };
  }

  @Get('export')
  @RequirePermission('config_portability', 'export')
  @ApiOperation({ summary: 'Returns the JSON export payload for the requested sections' })
  public exportConfig(@Query() query: ConfigExportQueryDto) {
    const sections = normaliseSections(query.sections);
    return this.exportService.exportConfig(sections);
  }

  @Post('import')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('config_portability', 'import')
  @ApiOperation({ summary: 'Imports a previously-exported configuration JSON' })
  public importConfig(@Body() dto: ConfigImportDto) {
    const sections = normaliseSections(dto.sections);
    return this.importService.importConfig({
      payload: dto.payload as unknown as ConfigExportPayloadInterface,
      sections,
      strategy: dto.strategy,
      dryRun: dto.dryRun,
    });
  }
}

function normaliseSections(input?: readonly string[]): readonly ConfigExportSection[] | null {
  if (!input || input.length === 0) return null;
  const filtered = input.filter((value) => SECTION_SET.has(value));
  if (filtered.length === 0) {
    throw new BadRequestException('No valid sections supplied');
  }
  return filtered as readonly ConfigExportSection[];
}
