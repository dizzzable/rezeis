import { UserHintCtaKind, UserHintMode, UserHintTone } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';

/**
 * Cabinet routes an operator may point a hint's button at.
 *
 * ── Why a list and not a free text box ────────────────────────────────────
 *
 * A free-form path is a link that breaks silently the first time a route is
 * renamed: the button still renders, still looks clickable, and lands on the
 * cabinet's catch-all. Nothing fails, nobody is told, and the hint quietly
 * stops doing the one thing it exists for. Choosing from a list makes a
 * removed destination a validation error at authoring time instead.
 *
 * ── Why it is CURATED and not every route ─────────────────────────────────
 *
 * The cabinet has 25 authenticated routes. This holds the dozen that are
 * plausible destinations for "go here next", which is the whole vocabulary a
 * hint needs. The rest are either arrival points nobody is sent to
 * (`/payment-return`), settings sub-pages reachable in one tap from
 * `/settings`, or guest-only pages (`/sign-in`, `/register`) where sending a
 * signed-in customer is nonsense.
 *
 * Keeping it short is also what keeps it honest. This IS a mirror of another
 * repository's router, and mirrors between these two have drifted before; a
 * dozen stable destinations drift far less than a full copy of every path.
 * When one does go missing the cabinet declines to render the button and says
 * so — see the delivery reader — rather than showing a dead one.
 */
export const HINT_ROUTE_TARGETS = [
  '/dashboard',
  '/subscription',
  '/subscription/devices',
  // The cabinet's own connect screen (`App.tsx`, `/subscription/connect`). It
  // is the destination for the two hints raised right after a subscription
  // starts — "you bought it, now put it on your phone" — and it was missing
  // here while two shipped templates pointed at it, so both were refused by
  // `validateCtaTarget` with a message listing every route except the one they
  // wanted. Reachable only while the operator has the connect screen switched
  // on; with it off the cabinet's own guard sends the customer to the external
  // page instead, which is the same place the button meant.
  '/subscription/connect',
  '/plans',
  '/purchase',
  '/renew',
  '/upgrade',
  '/addons',
  '/referrals',
  '/partner',
  '/promo',
  '/support',
  '/settings',
  '/settings/faq',
  '/settings/payment-methods',
  '/settings/transactions',
] as const;

/** Surfaces the cabinet reports for itself. Mirrors its own three-way probe. */
export const HINT_SURFACES = ['tma', 'pwa', 'browser'] as const;
export const HINT_FORM_FACTORS = ['mobile', 'tablet', 'desktop'] as const;

/**
 * Presentation modes the CABINET can actually render today.
 *
 * The enum declares five so that adding one later is a guarded `ALTER TYPE`
 * rather than a schema change. This list is the shorter, truthful one: an
 * operator must not be able to pick a mode that renders as nothing. Widen it
 * in the same commit that teaches the cabinet to draw the new mode, never
 * before.
 */
export const RENDERABLE_HINT_MODES: readonly UserHintMode[] = [UserHintMode.MODAL];

function trimmed(value: unknown): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

export class UpsertUserHintDto {
  /** Stable identifier an operator recognises, e.g. `connect-after-purchase`. */
  @IsString()
  @Transform(({ value }) => trimmed(value))
  @Length(1, 64)
  @Matches(/^[a-z0-9][a-z0-9-]*$/, {
    message: 'key must be lower-case letters, digits and hyphens',
  })
  key!: string;

  @IsString()
  @Transform(({ value }) => trimmed(value))
  @Length(1, 120)
  titleRu!: string;

  @IsString()
  @Transform(({ value }) => trimmed(value))
  @Length(1, 600)
  bodyRu!: string;

  @IsOptional()
  @IsString()
  @Transform(({ value }) => trimmed(value))
  @Length(0, 120)
  titleEn?: string;

  @IsOptional()
  @IsString()
  @Transform(({ value }) => trimmed(value))
  @Length(0, 600)
  bodyEn?: string;

  /**
   * Checked against {@link RENDERABLE_HINT_MODES}, not against the enum. The
   * enum is what the database accepts; this is what the cabinet can draw, and
   * the two are deliberately allowed to differ while a mode is being built.
   */
  @IsOptional()
  @IsEnum(UserHintMode)
  @IsIn(RENDERABLE_HINT_MODES, {
    message: 'mode is not one the cabinet renders yet',
  })
  mode?: UserHintMode;

  @IsOptional()
  @IsEnum(UserHintTone)
  tone?: UserHintTone;

  @IsOptional()
  @IsEnum(UserHintCtaKind)
  ctaKind?: UserHintCtaKind;

  @IsOptional()
  @IsString()
  @Transform(({ value }) => trimmed(value))
  @Length(0, 48)
  ctaLabelRu?: string;

  @IsOptional()
  @IsString()
  @Transform(({ value }) => trimmed(value))
  @Length(0, 48)
  ctaLabelEn?: string;

  /**
   * Validated by KIND in the service, not here: a ROUTE must be one of
   * {@link HINT_ROUTE_TARGETS} and an EXTERNAL must be an absolute https URL.
   * A single decorator cannot express "depends on another field", and encoding
   * it as a permissive regex would accept a route for an external button and
   * vice versa.
   */
  @IsOptional()
  @IsString()
  @Transform(({ value }) => trimmed(value))
  @Length(0, 512)
  ctaTarget?: string;

  /** Empty means every surface — the common case. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @IsIn(HINT_SURFACES, { each: true })
  surfaces?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @IsIn(HINT_FORM_FACTORS, { each: true })
  formFactors?: string[];

  @IsOptional()
  @IsString()
  @Transform(({ value }) => trimmed(value))
  @Length(0, 64)
  groupKey?: string;

  /**
   * One hour to ninety days. The floor stops a hint that can only be seen by
   * somebody already looking; the ceiling stops one that outlives the reason
   * it was raised.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(24 * 90)
  ttlHours?: number;

  @IsOptional()
  @IsBoolean()
  isRepeatable?: boolean;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
