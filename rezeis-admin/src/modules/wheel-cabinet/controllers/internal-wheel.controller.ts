import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { WheelSpinStatus } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { buildUserReferenceWhere } from '../../internal-user/utils/user-reference.util';
import { WheelSpinService, type SpinResult } from '../../wheel/services/wheel-spin.service';
import { WheelManualPrizeService } from '../../wheel-prizes/services/wheel-manual-prize.service';
import { BuySpinsDto, SpinHistoryDto, SpinRequestDto } from '../dto/spin-request.dto';
import {
  CabinetSpinPage,
  CabinetWheel,
  WheelCabinetService,
} from '../services/wheel-cabinet.service';

/** What the cabinet is told about a spin. Deliberately not the raw result. */
interface CabinetSpinResponse {
  readonly spun: boolean;
  readonly reason?: string;
  readonly spinId?: string;
  /** The sector the wheel stopped on, so the animation can land on it. */
  readonly sectorId?: string | null;
  readonly kind?: string;
  readonly amount?: number;
  readonly status?: WheelSpinStatus;
  readonly prize?: Record<string, unknown> | null;
  readonly spinBalance?: number;
  /** True when this request had already been served and is being replayed. */
  readonly replayed?: boolean;
}

/**
 * The wheel, for the person spinning it. Consumed by reiwa.
 *
 * Auth: `InternalAdminAuthGuard` (api_token) authenticates the reiwa BFF; the
 * end-user identity is proven by reiwa's own session and arrives as `:userRef`.
 * Every read and every spin is scoped to the resolved user, so one person can
 * never spin, buy for, or read the history of another.
 */
@ApiTags('internal/user/wheel')
@UseGuards(InternalAdminAuthGuard)
@Controller('internal/wheel')
export class InternalWheelController {
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly cabinet: WheelCabinetService,
    private readonly wheelSpin: WheelSpinService,
    private readonly manualPrizes: WheelManualPrizeService,
  ) {}

  @Get(':userRef')
  @ApiOperation({ summary: 'The wheel as this person sees it — never its odds' })
  public async view(@Param('userRef') userRef: string): Promise<CabinetWheel> {
    return this.cabinet.view(await this.resolveUserId(userRef));
  }

  @Get(':userRef/history')
  @ApiOperation({ summary: "This person's own spins, with what they won" })
  public async history(
    @Param('userRef') userRef: string,
    @Query() query: SpinHistoryDto,
  ): Promise<CabinetSpinPage> {
    return this.cabinet.history({
      userId: await this.resolveUserId(userRef),
      cursor: query.cursor ?? null,
      limit: query.limit ?? null,
    });
  }

  @Post(':userRef/spin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Spin once' })
  public async spin(
    @Param('userRef') userRef: string,
    @Body() dto: SpinRequestDto,
  ): Promise<CabinetSpinResponse> {
    const userId = await this.resolveUserId(userRef);
    const settings = await this.wheelSpin.readSettings();
    const result = await this.wheelSpin.spin({
      userId,
      idempotencyKey: dto.idempotencyKey,
      settings,
    });

    if (!result.spun) return { spun: false, reason: result.reason };

    // The operator hears about a jackpot in this second rather than at the
    // next sweep. The sweep stays as the backstop: if this fails, or the
    // process dies here, the debt is still recorded and still picked up.
    if (result.status === WheelSpinStatus.PENDING) {
      await this.manualPrizes.openTicket(result.spinId).catch(() => undefined);
    }

    return {
      spun: true,
      spinId: result.spinId,
      sectorId: result.sectorId,
      kind: result.kind,
      amount: result.amount,
      status: result.status,
      prize: await this.readPrize(userId, result),
      spinBalance: result.spinBalanceAfter,
      replayed: result.replayed,
    };
  }

  @Post(':userRef/buy')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Buy spins with points' })
  public async buy(
    @Param('userRef') userRef: string,
    @Body() dto: BuySpinsDto,
  ): Promise<{ readonly spinBalance: number; readonly pointsBalance: number }> {
    return this.cabinet.buySpins({
      userId: await this.resolveUserId(userRef),
      count: dto.count,
      idempotencyKey: dto.idempotencyKey,
    });
  }

  /**
   * What to show on the wheel when it stops.
   *
   * Read back out of the history rather than assembled from the spin result,
   * so the one place that decides what a person may see about a prize — the
   * key value, the minted code, the operator's private note that is NOT
   * passed on — is the same place for the stop screen and for the list.
   */
  private async readPrize(
    userId: string,
    result: Extract<SpinResult, { spun: true }>,
  ): Promise<Record<string, unknown> | null> {
    const page = await this.cabinet.history({ userId, limit: 1 });
    const row = page.items.find((item) => item.spinId === result.spinId);
    return row?.prize ?? null;
  }

  private async resolveUserId(userRef: string): Promise<string> {
    if (userRef.trim() === '') throw new BadRequestException('User reference is required');
    const user = await this.prismaService.user.findUnique({
      where: buildUserReferenceWhere(userRef),
      select: { id: true },
    });
    if (user === null) throw new NotFoundException('User not found');
    return user.id;
  }
}
