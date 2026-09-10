import { Body, Controller, Headers, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import {
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { buildUserReferenceWhere } from '../../internal-user/utils/user-reference.util';
import {
  MODES_THIS_PANEL_KNOWS,
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
 * The header a cabinet declares its drawable pop-up modes in.
 *
 * NOT a body field, and the difference is the whole reason this pair can be
 * deployed in either order. Bodies are validated by the global pipe with
 * `forbidNonWhitelisted`, so a panel whose DTO has not learned a field does not
 * ignore it — it answers 400. A cabinet upgraded before its panel would have
 * had every single hint request rejected, and the cabinet's route swallows that
 * into `{ hint: null }` at debug level: no hints for anybody, and nothing
 * anywhere saying why. An unknown header is simply not read.
 */
export const HINT_MODES_HEADER = 'x-reiwa-hint-modes';

/**
 * The modes out of that header, or `null` when it did not say.
 *
 * `null` is a distinct value for the same reason `surface` is: the service
 * resolves silence to what EVERY cabinet can draw, and a guess would turn "it
 * did not say" into a claim that it can draw something it may not — which costs
 * a destroyed delivery rather than a missed one.
 *
 * Unknown names are kept rather than refused; the service intersects them away
 * against this panel's own enum (`drawableModesForQuery`). Refusing here would
 * make an older panel answer 400 to a newer cabinet that claims one more mode,
 * which is the failure this header exists to avoid.
 */
export function parseDrawableModes(header: string | undefined): string[] | null {
  if (typeof header !== 'string') return null;
  const named = [
    ...new Set(
      header
        .split(',')
        .map((mode) => mode.trim().toUpperCase())
        .filter((mode) => mode.length > 0 && mode.length <= 32),
    ),
  ];
  // KNOWN NAMES FIRST, then the rest, then the cap.
  //
  // The cap was 8 and truncated in WIRE ORDER, so a cabinet that listed nine
  // modes with MODAL last lost modals entirely — its own declaration served it
  // worse than silence would have. Ordering by what this panel can actually act
  // on means the cap can only ever discard names the service was going to drop
  // anyway, which makes the bound free.
  //
  // The unknown ones are still carried, deliberately: they cost nothing here,
  // they are what a newer cabinet is telling us, and refusing them in this
  // function is what would make an older panel answer 400 to a newer cabinet —
  // the failure this header exists to avoid.
  const known = named.filter((mode) => MODES_THIS_PANEL_KNOWS.includes(mode));
  const rest = named.filter((mode) => !MODES_THIS_PANEL_KNOWS.includes(mode));
  // Bounded, because it arrives from the network: a header with ten thousand
  // comma-separated names must not become a ten-thousand-item list.
  const modes = [...known, ...rest].slice(0, 32);
  return modes.length === 0 ? null : modes;
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
  public async next(
    @Body() dto: HintAudienceDto,
    @Headers(HINT_MODES_HEADER) modesHeader?: string,
  ): Promise<{ hint: ResolvedHint | null }> {
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
        // Same reasoning one more time, for the mode: a cabinet that says
        // nothing gets what every cabinet has always been able to draw.
        //
        // A HEADER, not a body field, and that is what makes the pair safe to
        // deploy in either order. The body is validated with
        // `forbidNonWhitelisted`, so a panel whose DTO has not learned a field
        // answers 400 to every request carrying it — a newer cabinet would have
        // had every hint request rejected and shown nobody anything. An unknown
        // header is simply not read.
        modes: parseDrawableModes(modesHeader),
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
