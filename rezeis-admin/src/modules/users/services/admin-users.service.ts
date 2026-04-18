import { Injectable } from '@nestjs/common';

import { InternalUserService } from '../../internal-user/services/internal-user.service';
import { AdminUserSearchQueryDto } from '../dto/admin-user-search-query.dto';
import { AdminUserSearchResultInterface } from '../interfaces/admin-user-search-result.interface';

/**
 * Aggregates admin user search reads from the internal-user business logic.
 */
@Injectable()
export class AdminUsersService {
  public constructor(private readonly internalUserService: InternalUserService) {}

  /**
   * Returns the aggregated search payload for a single resolved user.
   */
  public async searchUser(
    query: AdminUserSearchQueryDto,
  ): Promise<AdminUserSearchResultInterface> {
    return this.internalUserService.getSearchResult(query);
  }
}
