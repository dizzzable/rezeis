import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { InternalUserService } from '../../internal-user/services/internal-user.service';
import { AdminUserListQueryDto } from '../dto/admin-user-list-query.dto';
import { AdminUserSearchQueryDto } from '../dto/admin-user-search-query.dto';
import {
  AdminUserListItemInterface,
  AdminUserListResultInterface,
} from '../interfaces/admin-user-list-item.interface';
import { AdminUserSearchResultInterface } from '../interfaces/admin-user-search-result.interface';

const DEFAULT_LIST_LIMIT = 50;
const DEFAULT_LIST_OFFSET = 0;

/**
 * Aggregates admin user reads — single-user search delegated to the
 * internal-user service, plus a paginated list optimized for the
 * left-rail picker on the admin Users page.
 */
@Injectable()
export class AdminUsersService {
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly internalUserService: InternalUserService,
  ) {}

  /**
   * Returns the aggregated search payload for a single resolved user.
   */
  public async searchUser(
    query: AdminUserSearchQueryDto,
  ): Promise<AdminUserSearchResultInterface> {
    return this.internalUserService.getSearchResult(query);
  }

  /**
   * Returns a paginated, lightweight list of users for the admin list view.
   */
  public async listUsers(
    query: AdminUserListQueryDto,
  ): Promise<AdminUserListResultInterface> {
    const limit = query.limit ?? DEFAULT_LIST_LIMIT;
    const offset = query.offset ?? DEFAULT_LIST_OFFSET;
    const where = buildUserListWhere(query.search);

    const [rows, total] = await this.prismaService.$transaction([
      this.prismaService.user.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: offset,
        take: limit,
        select: {
          id: true,
          telegramId: true,
          username: true,
          email: true,
          name: true,
          role: true,
          language: true,
          isBlocked: true,
          createdAt: true,
          updatedAt: true,
          lastSeenAt: true,
          webAccount: { select: { login: true } },
        },
      }),
      this.prismaService.user.count({ where }),
    ]);

    const items: AdminUserListItemInterface[] = rows.map((user) => ({
      id: user.id,
      telegramId: user.telegramId === null ? null : user.telegramId.toString(),
      username: user.username,
      email: user.email,
      name: user.name,
      login: user.webAccount?.login ?? null,
      role: user.role,
      language: user.language,
      isBlocked: user.isBlocked,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
      lastSeenAt: user.lastSeenAt?.toISOString() ?? null,
    }));

    return { items, total };
  }
}

/**
 * Builds the `User.findMany` where clause for the admin list endpoint.
 *
 * The search fragment is matched case-insensitively against the obvious
 * lookup columns and the linked `WebAccount.login`. Numeric fragments
 * are also matched against `telegramId` (BigInt) when they fit.
 */
function buildUserListWhere(search: string | undefined): Prisma.UserWhereInput {
  const trimmed = search?.trim();
  if (!trimmed) {
    return {};
  }

  const conditions: Prisma.UserWhereInput[] = [
    { id: { contains: trimmed, mode: 'insensitive' } },
    { username: { contains: trimmed, mode: 'insensitive' } },
    { email: { contains: trimmed, mode: 'insensitive' } },
    { name: { contains: trimmed, mode: 'insensitive' } },
    { referralCode: { contains: trimmed, mode: 'insensitive' } },
    {
      webAccount: {
        is: { login: { contains: trimmed, mode: 'insensitive' } },
      },
    },
  ];

  if (/^\d+$/.test(trimmed)) {
    try {
      const telegramId = BigInt(trimmed);
      conditions.push({ telegramId });
    } catch {
      // Overflow — silently skip the numeric branch.
    }
  }

  return { OR: conditions };
}

