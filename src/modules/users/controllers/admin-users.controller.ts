import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { AdminUserListQueryDto } from '../dto/admin-user-list-query.dto';
import { AdminUserSearchQueryDto } from '../dto/admin-user-search-query.dto';
import { AdminUserListResultInterface } from '../interfaces/admin-user-list-item.interface';
import { AdminUserSearchResultInterface } from '../interfaces/admin-user-search-result.interface';
import { AdminUsersService } from '../services/admin-users.service';

/**
 * Exposes JWT-protected user reads for the admin panel.
 *
 * Two routes:
 *   • `GET /admin/users`         — paginated list for the left-rail picker.
 *   • `GET /admin/users/search`  — single-user aggregated lookup.
 */
@Controller('admin/users')
@UseGuards(AdminJwtAuthGuard)
export class AdminUsersController {
  public constructor(private readonly adminUsersService: AdminUsersService) {}

  /**
   * Returns the paginated admin list of users with a free-text search filter.
   */
  @Get()
  public async listUsers(
    @Query() query: AdminUserListQueryDto,
  ): Promise<AdminUserListResultInterface> {
    return this.adminUsersService.listUsers(query);
  }

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
