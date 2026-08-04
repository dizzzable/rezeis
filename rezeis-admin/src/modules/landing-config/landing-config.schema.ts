import { z } from 'zod';

/**
 * Landing-config schema — the SECURITY BOUNDARY of the whole feature.
 *
 * The config is pure data: a `type` discriminant + typed props, never HTML or
 * code. The reiwa renderer instantiates only registry components; React
 * auto-escapes text; the one or two rich-text fields are DOMPurify-sanitized on
 * write and render; every URL is allow-listed here.
 *
 * Two validation strengths:
 *  - `landingConfigSchema` — structural (draft save). Shape must be sane so the
 *    admin can't persist broken JSON, but partial translations are allowed
 *    while the operator is still editing.
 *  - `publishStrict(...)` — the publish gate. Every visible string must have a
 *    non-empty value for every configured locale (ru AND en), and every URL is
 *    re-checked against the allow-list.
 */

/** Current landing schema version — bumped when the section catalog evolves. */
export const LANDING_SCHEMA_VERSION = 1;

// ─────────────────────────────────────────────────────────────────────────────
//  Primitives
// ─────────────────────────────────────────────────────────────────────────────

/** `{ ru: '…', en: '…' }` — at least one language key; values may be empty
 *  in a draft (publish-strict enforces completeness). */
export const localizedTextSchema = z
  .record(z.string().regex(/^[a-z]{2}$/), z.string())
  .refine((obj) => Object.keys(obj).length > 0, 'At least one language is required');

export type LocalizedText = z.infer<typeof localizedTextSchema>;

/**
 * URL allow-list: absolute `https://…` or a site-relative `/…` path only.
 * `javascript:`, `vbscript:`, `data:`, `http:` and protocol-relative `//` are
 * rejected — they can never reach a rendered `src`/`href`.
 */
export const safeUrlSchema = z
  .string()
  .trim()
  .refine((value) => {
    if (value.length === 0) return false;
    if (value.startsWith('/') && !value.startsWith('//')) return true;
    return /^https:\/\/[^\s]+$/i.test(value);
  }, 'URL must be https:// or a site-relative /path (no javascript:, data:, http:)');

/**
 * A user-fillable URL that MAY be empty (= "not set yet") while the operator
 * is composing the landing. An empty value is safe: the renderer treats it as
 * absent and drops the affordance (fail-closed). A non-empty value must pass
 * the same allow-list as `safeUrlSchema`. Use this for optional/in-progress
 * URL fields (CTA links, images, logo/footer/social hrefs) so adding a blank
 * item and filling it later doesn't fail draft validation.
 */
export const fillableUrlSchema = z.union([z.literal(''), safeUrlSchema]);

const iconNameSchema = z.enum([
  'shield',
  'lock',
  'zap',
  'globe',
  'server',
  'wifi',
  'eye-off',
  'key',
  'check',
  'star',
  'rocket',
  'users',
  'clock',
  'download',
  'smartphone',
  'gauge',
  'heart',
  'award',
  'refresh',
  'help-circle',
]);

const ctaActionSchema = z.enum(['register', 'login', 'url']);

const ctaSchema = z.object({
  label: localizedTextSchema,
  action: ctaActionSchema,
  url: fillableUrlSchema.optional(),
});

const imageFieldSchema = z.object({
  src: fillableUrlSchema,
  alt: localizedTextSchema,
});

// ─────────────────────────────────────────────────────────────────────────────
//  Section data shapes
// ─────────────────────────────────────────────────────────────────────────────

const heroData = z.object({
  eyebrow: localizedTextSchema.optional(),
  heading: localizedTextSchema,
  subheading: localizedTextSchema.optional(),
  primaryCta: ctaSchema,
  secondaryCta: ctaSchema.optional(),
  media: imageFieldSchema.optional(),
  align: z.enum(['left', 'center']).default('center'),
});

const featuresGridData = z.object({
  heading: localizedTextSchema.optional(),
  columns: z.union([z.literal(2), z.literal(3), z.literal(4)]).default(3),
  items: z
    .array(
      z.object({
        icon: iconNameSchema,
        title: localizedTextSchema,
        body: localizedTextSchema,
      }),
    )
    .max(24),
});

const howItWorksData = z.object({
  heading: localizedTextSchema.optional(),
  steps: z
    .array(
      z.object({
        title: localizedTextSchema,
        body: localizedTextSchema,
        media: imageFieldSchema.optional(),
      }),
    )
    .max(12),
});

const staticPlanSchema = z.object({
  name: localizedTextSchema,
  priceMonthly: z.string(),
  priceYearly: z.string().optional(),
  currency: z.enum(['RUB', 'USD', 'EUR']).default('RUB'),
  features: z.array(localizedTextSchema).max(20),
  cta: ctaSchema,
  highlighted: z.boolean().optional(),
  badge: localizedTextSchema.optional(),
});

const pricingData = z.object({
  source: z.enum(['catalog', 'static']).default('catalog'),
  billingToggle: z.boolean().default(false),
  heading: localizedTextSchema.optional(),
  staticPlans: z.array(staticPlanSchema).max(6).optional(),
});

const faqData = z.object({
  heading: localizedTextSchema.optional(),
  items: z
    .array(
      z.object({
        question: localizedTextSchema,
        // Constrained rich text; DOMPurify-sanitized on write + render.
        answer: localizedTextSchema,
      }),
    )
    .max(40),
});

const testimonialsData = z.object({
  heading: localizedTextSchema.optional(),
  items: z
    .array(
      z.object({
        quote: localizedTextSchema,
        author: localizedTextSchema,
        role: localizedTextSchema.optional(),
        avatar: imageFieldSchema.optional(),
        rating: z.number().int().min(0).max(5).optional(),
      }),
    )
    .max(24),
});

const statsData = z.object({
  heading: localizedTextSchema.optional(),
  items: z
    .array(
      z.object({
        value: z.string(),
        label: localizedTextSchema,
      }),
    )
    .max(8),
});

const trustLogosData = z.object({
  heading: localizedTextSchema.optional(),
  logos: z
    .array(
      z.object({
        image: imageFieldSchema,
        href: fillableUrlSchema.optional(),
      }),
    )
    .max(24),
});

const ctaBannerData = z.object({
  heading: localizedTextSchema,
  body: localizedTextSchema.optional(),
  cta: ctaSchema,
  style: z.enum(['solid', 'gradient', 'outline']).default('gradient'),
});

const footerData = z.object({
  columns: z
    .array(
      z.object({
        title: localizedTextSchema,
        links: z
          .array(z.object({ label: localizedTextSchema, href: fillableUrlSchema }))
          .max(12),
      }),
    )
    .max(6),
  legal: localizedTextSchema.optional(),
  socials: z
    .array(
      z.object({
        platform: z.enum(['telegram', 'x', 'github', 'youtube', 'instagram', 'vk', 'email']),
        href: fillableUrlSchema,
      }),
    )
    .max(10)
    .optional(),
});

// ─────────────────────────────────────────────────────────────────────────────
//  Theme / effect enums (declared before use — sectionBase references
//  LANDING_ANIMATIONS, so these must be hoisted above the section union to
//  avoid a temporal-dead-zone ReferenceError at module load).
// ─────────────────────────────────────────────────────────────────────────────

/** Animated/static background presets — all pure-CSS, no WebGL (pre-login). */
export const LANDING_BACKGROUNDS = [
  'none',
  'gradient',
  'aurora',
  'grid',
  'dots',
  'glow',
  'mesh',
  'noise',
  'blobs',
  'spotlight',
  'network',
] as const;
/**
 * Texture layer drawn ON TOP of the background effect. `noise`, `grid` and
 * `dots` are textures rather than scenes, so as base effects they competed with
 * `aurora`/`mesh` instead of combining with them; as a second axis the same CSS
 * yields roughly fifty combinations.
 */
export const LANDING_BACKGROUND_OVERLAYS = ['none', 'noise', 'grid', 'dots', 'vignette', 'scanline'] as const;

/** Hover feedback on cards / CTA buttons (pointer devices only). */
export const LANDING_CARD_HOVERS = ['none', 'lift', 'glow', 'scale'] as const;
export const LANDING_CTA_STYLES = ['none', 'lift', 'shine'] as const;

/** Section/card surface style — `glass` = liquid-glass (backdrop-blur). */
export const LANDING_SURFACE_STYLES = ['solid', 'glass', 'outline'] as const;
/** Per-section scroll-reveal animation. */
export const LANDING_ANIMATIONS = [
  'none', 'fade', 'fadeUp', 'fadeDown', 'slideLeft', 'slideRight', 'zoom', 'zoomOut', 'blurIn',
] as const;

const hexColor = z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);

// ─────────────────────────────────────────────────────────────────────────────
//  Section discriminated union
// ─────────────────────────────────────────────────────────────────────────────

const sectionBase = {
  id: z.string().min(1),
  visible: z.boolean().default(true),
  /// Optional scroll-reveal animation applied when the section enters view.
  animation: z.enum(LANDING_ANIMATIONS).optional(),
};

export const sectionSchema = z.discriminatedUnion('type', [
  z.object({ ...sectionBase, type: z.literal('hero'), data: heroData }),
  z.object({ ...sectionBase, type: z.literal('featuresGrid'), data: featuresGridData }),
  z.object({ ...sectionBase, type: z.literal('howItWorks'), data: howItWorksData }),
  z.object({ ...sectionBase, type: z.literal('pricing'), data: pricingData }),
  z.object({ ...sectionBase, type: z.literal('faq'), data: faqData }),
  z.object({ ...sectionBase, type: z.literal('testimonials'), data: testimonialsData }),
  z.object({ ...sectionBase, type: z.literal('stats'), data: statsData }),
  z.object({ ...sectionBase, type: z.literal('trustLogos'), data: trustLogosData }),
  z.object({ ...sectionBase, type: z.literal('ctaBanner'), data: ctaBannerData }),
  z.object({ ...sectionBase, type: z.literal('footer'), data: footerData }),
]);

export type LandingSection = z.infer<typeof sectionSchema>;
export const LANDING_SECTION_TYPES = [
  'hero',
  'featuresGrid',
  'howItWorks',
  'pricing',
  'faq',
  'testimonials',
  'stats',
  'trustLogos',
  'ctaBanner',
  'footer',
] as const;

const themeSchema = z.object({
  inherit: z.boolean().default(true),
  colors: z
    .object({
      primary: hexColor.optional(),
      bg: hexColor.optional(),
      fg: hexColor.optional(),
      accent: hexColor.optional(),
    })
    .optional(),
  /**
   * `family` only. A `scale` multiplier used to be declared here and was never
   * implemented in either renderer: section typography is Tailwind `text-*`,
   * which is rem-based and resolves against the document root, so nothing short
   * of a typography rework could honour it. Removing an optional field that no
   * config could ever have depended on needs no migration — Zod strips it from
   * any stored draft that still carries one.
   */
  font: z.object({ family: z.string().optional() }).optional(),
  radius: z.enum(['none', 'sm', 'md', 'lg', 'xl']).optional(),
  /// Background effect rendered behind all sections (CSS-only, reduced-motion aware).
  background: z.enum(LANDING_BACKGROUNDS).optional(),
  /// Up to 4 hex colors driving the background effect (defaults to brand primary).
  backgroundColors: z.array(hexColor).max(4).optional(),
  /// Animate the background (respects prefers-reduced-motion). Default true.
  animateBackground: z.boolean().optional(),
  /// Texture layer over the background effect (independent of the base).
  backgroundOverlay: z.enum(LANDING_BACKGROUND_OVERLAYS).optional(),
  /// Card/section surface treatment applied across the landing.
  surfaceStyle: z.enum(LANDING_SURFACE_STYLES).optional(),
  /// Hover feedback on cards; ignored on touch input.
  cardHover: z.enum(LANDING_CARD_HOVERS).optional(),
  /// Hover feedback on CTA buttons; ignored on touch input.
  ctaStyle: z.enum(LANDING_CTA_STYLES).optional(),
});

export const landingConfigSchema = z.object({
  schemaVersion: z.number().int().min(1),
  enabled: z.boolean().default(false),
  theme: themeSchema,
  locales: z.array(z.string().regex(/^[a-z]{2}$/)).min(1),
  defaultLocale: z.string().regex(/^[a-z]{2}$/),
  meta: z.object({ title: localizedTextSchema, description: localizedTextSchema }),
  ogImage: fillableUrlSchema.optional(),
  sections: z.array(sectionSchema).max(40),
});

export type LandingConfigPayload = z.infer<typeof landingConfigSchema>;

/** Effective public payload — either a full config or the disabled sentinel. */
export type EffectiveLandingPayload = LandingConfigPayload | { enabled: false };

// ─────────────────────────────────────────────────────────────────────────────
//  Publish-strict validation
// ─────────────────────────────────────────────────────────────────────────────

export interface PublishStrictIssue {
  readonly path: string;
  readonly message: string;
}

/**
 * Enforces publish-time completeness: every visible section's every localized
 * string must have a non-empty value for every configured locale. Returns the
 * list of issues (empty = OK). URL safety is already guaranteed by the schema.
 */
export function collectPublishStrictIssues(config: LandingConfigPayload): PublishStrictIssue[] {
  const issues: PublishStrictIssue[] = [];
  const locales = config.locales;

  const checkText = (value: LocalizedText | undefined, path: string): void => {
    if (value === undefined) return;
    // "All-empty" localized field = intentionally unset (an optional field the
    // operator left blank) → skip. Only require completeness once the field is
    // in use (has a non-empty value in at least one configured locale).
    const inUse = locales.some((locale) => (value[locale] ?? '').trim().length > 0);
    if (!inUse) return;
    for (const locale of locales) {
      const text = value[locale];
      if (text === undefined || text.trim().length === 0) {
        issues.push({ path, message: `Missing "${locale}" translation` });
      }
    }
  };

  const walk = (node: unknown, path: string): void => {
    if (node === null || typeof node !== 'object') return;
    if (isLocalizedText(node)) {
      checkText(node as LocalizedText, path);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      walk(child, path.length > 0 ? `${path}.${key}` : key);
    }
  };

  for (const [index, section] of config.sections.entries()) {
    if (!section.visible) continue;
    walk(section.data, `sections[${index}](${section.type})`);
  }
  checkText(config.meta.title, 'meta.title');
  checkText(config.meta.description, 'meta.description');

  return issues;
}

/**
 * A localized-text node is an object whose keys are all 2-letter locale codes.
 * Used to detect leaf strings during the publish-strict walk.
 */
function isLocalizedText(node: object): boolean {
  const keys = Object.keys(node);
  if (keys.length === 0) return false;
  return keys.every((key) => /^[a-z]{2}$/.test(key));
}

/** Coerces a Prisma JSON column value into a plain object (single source of
 *  truth in `common/utils`). Re-exported for existing import sites. */
export { readJsonObject } from '../../common/utils/read-json-object.util';
