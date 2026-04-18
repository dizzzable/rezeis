import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { AdminUserSearchQueryDto } from '../dto/admin-user-search-query.dto';
import { AdminUserSearchResultInterface } from '../interfaces/admin-user-search-result.interface';
import { AdminUsersService } from '../services/admin-users.service';

/**
 * Exposes JWT-protected user search reads for the admin panel.
 */
@Controller('admin/users')
@UseGuards(AdminJwtAuthGuard)
export class AdminUsersController {
  public constructor(private readonly adminUsersService: AdminUsersService) {}

  /**
   * Returns the aggregated admin search payload for a single user lookup.
   */
  @Get('search')
  public async searchUser(
    @Query() query: AdminUserSearchQueryDto,
  ): Promise<AdminUserSearchResultInterface> {
    return this.adminUsersService.searchUser(query);
  }
}
