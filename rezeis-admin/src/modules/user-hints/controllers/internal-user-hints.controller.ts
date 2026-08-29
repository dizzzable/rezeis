import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Length, Matches, MaxLength, MinLength } from 'class-validator';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { buildUserReferenceWhere } from '../../internal-user/utils/user-reference.util';
import {
  UserHintDeliveryService,
  type ResolvedHint,
} from '../services/user-hint-delivery.service';

/**
 * The cabinet's half of the hint system.
 *
 * Three calls: what should I show this person, I have shown it, and here is how
 * it ended. Everything about WHO is resolved from the reference reiwa sends —
 * the same identity plumbing every other internal call uses — and never from a
 * user id supplied in a body the browser could have shaped.
 */
class HintAudienceDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  public readonly userId?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{1,19}$/, { message: 'telegramId must be a positive numeric string' })
  public readonly telegramId?: string;

  @IsOptional()
  @IsIn(['tma', 'pwa', 'browser'])
  public readonly surface?: 'tma' | 'pwa' | 'browser';

  @IsOptional()
  @IsIn(['mobile', 'tablet', 'desktop'])
  public readonly formFactor?: 'mobile' | 'tablet' | 'desktop';

  @IsOptional()
  @IsIn(['ru', 'en'])
  public readonly locale?: 'ru' | 'en';
}

/**
 * Moments the CABINET detects for itself, and may therefore raise.
 *
 * ── Why a closed list, when the identity is already the session's ─────────
 *
 * A client can only ever raise a hint for itself, so this is not an
 * authorisation boundary. It is a naming one: the moment name IS the hint key,
 * so an open list would let a browser queue any hint an operator ever authored
 * — including one meant for a payment failure — out of context and at will.
 *
 * ── Why the moment name is the hint key ───────────────────────────────────
 *
 * No binding table and no second screen. An operator authoring a hint with the
 * key `subscription-ready` has, by that act, put it on the moment; deleting it
 * takes it off. The alternative is a mapping an operator has to maintain
 * separately from the thing it maps, which is one more place for the two to
 * disagree.
 */
const CLIENT_MOMENTS = ['subscription-ready'] as const;

class HintMomentDto extends HintAudienceDto {
  @IsIn(CLIENT_MOMENTS)
  public readonly moment!: (typeof CLIENT_MOMENTS)[number];
}

class HintOutcomeDto extends HintAudienceDto {
  @IsString()
  @Length(1, 64)
  public readonly deliveryId!: string;

  @IsOptional()
  @IsIn(['acted', 'dismissed'])
  public readonly outcome?: 'acted' | 'dismissed';
}

@ApiExcludeController()
@Controller('internal/user-hints')
@UseGuards(InternalAdminAuthGuard)
export class InternalUserHintsController {
  public constructor(
    private readonly deliveries: UserHintDeliveryService,
    private readonly prismaService: PrismaService,
  ) {}

  /**
   * The next hint to show, or `{ hint: null }`.
   *
   * A POST rather than a GET because the audience travels in the body, and
   * because a surface and a form factor in a query string end up in every
   * access log between here and the cabinet. `null` is the overwhelmingly
   * common answer and costs one indexed read.
   */
  @Post('next')
  public async next(@Body() dto: HintAudienceDto): Promise<{ hint: ResolvedHint | null }> {
    const userId = await this.resolveUserId(dto);
    if (userId === null) return { hint: null };
    const hint = await this.deliveries.nextFor({
      userId,
      locale: dto.locale ?? 'ru',
      audience: {
        // NOT DEFAULTED, and this is the whole point of the `string | null`
        // these fields carry. Substituting `browser` here turned "the client
        // did not tell us" into a positive match and showed an "install the
        // app" hint inside the Telegram Mini App — precisely what a surface
        // restriction exists to prevent. The service SKIPS a restricted hint
        // when it cannot tell, and it can only do that if the doubt reaches it.
        //
        // This mattered more than a missing field looks: the cabinet maps any
        // surface it does not recognise to `undefined`, so a newer cabinet
        // reporting a surface this panel has not heard of arrived here as "no
        // answer" and was silently reclassified as a browser.
        surface: dto.surface ?? null,
        formFactor: dto.formFactor ?? null,
      },
    });
    return { hint };
  }

  /**
   * The cabinet noticed something it can see for itself.
   *
   * Some of what a hint should follow is not an event on this side at all: the
   * cabinet polls until a freshly bought subscription's profile is ready, and
   * that instant exists only in the browser. Rather than invent a server event
   * for it, the client says so and the queue does the rest — including "once",
   * which is what stops a refresh raising it again.
   */
  @Post('moment')
  public async moment(@Body() dto: HintMomentDto): Promise<{ raised: boolean }> {
    const userId = await this.resolveUserId(dto);
    if (userId === null) return { raised: false };
    const delivery = await this.deliveries.raise({
      userId,
      hintKey: dto.moment,
      source: `moment:${dto.moment}`,
    });
    return { raised: delivery !== null };
  }

  /** Stamped when it actually reaches the screen, not when it was fetched. */
  @Post('shown')
  public async shown(@Body() dto: HintOutcomeDto): Promise<{ ok: boolean }> {
    const userId = await this.resolveUserId(dto);
    if (userId === null) return { ok: false };
    return { ok: await this.deliveries.markShown(dto.deliveryId, userId) };
  }

  /** How it ended — followed, or closed. Kept apart on purpose. */
  @Post('closed')
  public async closed(@Body() dto: HintOutcomeDto): Promise<{ ok: boolean }> {
    const userId = await this.resolveUserId(dto);
    if (userId === null) return { ok: false };
    return {
      ok: await this.deliveries.close(dto.deliveryId, userId, dto.outcome ?? 'dismissed'),
    };
  }

  /**
   * The account behind the reference reiwa sent.
   *
   * Answers `null` rather than throwing for an unknown reference: a hint is a
   * convenience, and a cabinet whose session has drifted should lose its
   * hints, not its page. Every caller treats `null` as "nothing to show".
   */
  private async resolveUserId(dto: HintAudienceDto): Promise<string | null> {
    const reference = dto.userId ?? dto.telegramId ?? null;
    if (reference === null) return null;
    const user = await this.prismaService.user.findUnique({
      where: buildUserReferenceWhere(reference),
      select: { id: true },
    });
    return user?.id ?? null;
  }
}
