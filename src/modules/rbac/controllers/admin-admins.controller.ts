import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Prisma, UserRole } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { CurrentAdmin } from '../../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { PasswordHashService } from '../../auth/services/password-hash.service';
import { loginPolicy } from '../../auth/utils/login-policy.util';
import { RequirePermission } from '../decorators/require-permission.decorator';
import { RbacGuard } from '../guards/rbac.guard';

/**
 * Admin user CRUD endpoints. The `admins` RBAC resource gates each verb.
 * Self-targeted destructive operations (deactivate / delete the currently
 * authenticated admin) are blocked at the controller level so an operator
 * cannot accidentally lock themselves out of the panel.
 */

const ROLE_VALUES = ['DEV', 'ADMIN'] as const;
type AssignableRole = (typeof ROLE_VALUES)[number];

class CreateAdminDto {
  @IsString()
  @MinLength(loginPolicy.minLength)
  @MaxLength(loginPolicy.maxLength)
  @Matches(loginPolicy.pattern, {
    message: 'Login may only contain letters, digits, dots, dashes, and underscores',
  })
  public readonly username!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  public readonly password!: string;

  @IsEnum(ROLE_VALUES)
  public readonly role!: AssignableRole;

  @IsOptional()
  @IsString()
  @Length(0, 120)
  public readonly name?: string;
}

class UpdateAdminDto {
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  public readonly password?: string;

  @IsOptional()
  @IsEnum(ROLE_VALUES)
  public readonly role?: AssignableRole;

  @IsOptional()
  @IsBoolean()
  public readonly isActive?: boolean;

  @IsOptional()
  @IsString()
  @Length(0, 120)
  public readonly name?: string;
}

interface AdminListItem {
  readonly id: string;
  readonly username: string;
  readonly name: string | null;
  readonly role: UserRole;
  readonly isActive: boolean;
  readonly lastLoginAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const adminProjection = Prisma.validator<Prisma.AdminUserSelect>()({
  id: true,
  login: true,
  name: true,
  role: true,
  isActive: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
});

type AdminProjection = Prisma.AdminUserGetPayload<{ select: typeof adminProjection }>;

function toApi(admin: AdminProjection): AdminListItem {
  return {
    id: admin.id,
    username: admin.login,
    name: admin.name,
    role: admin.role,
    isActive: admin.isActive,
    lastLoginAt: admin.lastLoginAt?.toISOString() ?? null,
    createdAt: admin.createdAt.toISOString(),
    updatedAt: admin.updatedAt.toISOString(),
  };
}

@ApiTags('admin/admins')
@ApiBearerAuth('JWT')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
@Controller('admin/admins')
export class AdminAdminsController {
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly passwordHashService: PasswordHashService,
  ) {}

  @Get()
  @RequirePermission('admins', 'view')
  @ApiOperation({ summary: 'List all admin user accounts' })
  public async list(): Promise<readonly AdminListItem[]> {
    const records = await this.prismaService.adminUser.findMany({
      orderBy: [{ createdAt: 'desc' }],
      select: adminProjection,
    });
    return records.map(toApi);
  }

  @Post()
  @RequirePermission('admins', 'create')
  @ApiOperation({ summary: 'Create a new admin account' })
  public async create(@Body() dto: CreateAdminDto): Promise<AdminListItem> {
    const sanitizedLogin = loginPolicy.sanitizeLogin(dto.username);
    if (!loginPolicy.isValidLogin(sanitizedLogin)) {
      throw new BadRequestException('Invalid login');
    }
    const normalizedLogin = loginPolicy.normalizeLogin(sanitizedLogin);

    const existing = await this.prismaService.adminUser.findUnique({
      where: { loginNormalized: normalizedLogin },
      select: { id: true },
    });
    if (existing !== null) {
      throw new ConflictException('Admin with this login already exists');
    }

    const passwordHash = await this.passwordHashService.hashPassword({
      plainTextPassword: dto.password,
    });

    const created = await this.prismaService.adminUser.create({
      data: {
        login: sanitizedLogin,
        loginNormalized: normalizedLogin,
        passwordHash,
        role: dto.role,
        name: dto.name?.trim() || null,
        isActive: true,
        passwordChangedAt: new Date(),
      },
      select: adminProjection,
    });
    return toApi(created);
  }

  @Patch(':adminId')
  @RequirePermission('admins', 'edit')
  @ApiOperation({ summary: 'Update an admin account' })
  public async update(
    @Param('adminId') adminId: string,
    @Body() dto: UpdateAdminDto,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
  ): Promise<AdminListItem> {
    const target = await this.prismaService.adminUser.findUnique({
      where: { id: adminId },
      select: { id: true, role: true },
    });
    if (target === null) {
      throw new NotFoundException('Admin not found');
    }

    if (dto.isActive === false && currentAdmin.id === adminId) {
      throw new ForbiddenException('You cannot deactivate your own account');
    }

    const data: Prisma.AdminUserUpdateInput = {};

    if (typeof dto.role !== 'undefined') {
      data.role = dto.role;
    }
    if (typeof dto.isActive === 'boolean') {
      data.isActive = dto.isActive;
    }
    if (typeof dto.name !== 'undefined') {
      data.name = dto.name.trim().length > 0 ? dto.name.trim() : null;
    }
    if (typeof dto.password === 'string' && dto.password.length > 0) {
      data.passwordHash = await this.passwordHashService.hashPassword({
        plainTextPassword: dto.password,
      });
      data.passwordChangedAt = new Date();
      // Bump tokenVersion to invalidate any active session of this admin.
      data.tokenVersion = { increment: 1 };
    }

    if (Object.keys(data).length === 0) {
      throw new BadRequestException('No fields to update');
    }

    const updated = await this.prismaService.adminUser.update({
      where: { id: adminId },
      data,
      select: adminProjection,
    });
    return toApi(updated);
  }

  @Delete(':adminId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('admins', 'delete')
  @ApiOperation({ summary: 'Delete (revoke) an admin account' })
  public async delete(
    @Param('adminId') adminId: string,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
  ): Promise<void> {
    if (currentAdmin.id === adminId) {
      throw new ForbiddenException('You cannot delete your own account');
    }
    const target = await this.prismaService.adminUser.findUnique({
      where: { id: adminId },
      select: { id: true },
    });
    if (target === null) {
      throw new NotFoundException('Admin not found');
    }
    await this.prismaService.adminUser.delete({ where: { id: adminId } });
  }
}
