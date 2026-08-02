/**
 * Branding settings shape — strongly-typed view over the
 * `Settings.brandingSettings` JSON column.
 *
 * Every value is optional in the persisted JSON; the interface stays nullable
 * so the reading side can fall back to safe defaults without throwing.
 *
 * The `BgEffect` enum lists the predefined background-effect presets the
 * reiwa SPA knows how to render. Adding a new preset requires updates in
 * three places:
 *   1. `BG_EFFECTS` here,
 *   2. the SPA `BrandingProvider` switch,
 *   3. the admin configurator dropdown.
 */

export const BG_EFFECTS = ['NONE', 'MESH', 'PARTICLES', 'NOISE', 'AURORA'] as const;
export type BgEffect = (typeof BG_EFFECTS)[number];

/**
 * Built-in watermark glyphs that can sit on the subscription card. These map
 * to Lucide icon names the reiwa SPA renders inline (tintable, scalable, no
 * extra assets). `DEFAULT` keeps the canonical Reiwa origami mark; `NONE`
 * hides the watermark entirely. Operators can also supply a fully custom
 * image via `cardLogoUrl` (which takes priority when set).
 *
 * Adding a preset requires updates in three places:
 *   1. `CARD_LOGO_PRESETS` here,
 *   2. the SPA card-watermark renderer (icon map),
 *   3. the admin configurator preset grid.
 */
export const CARD_LOGO_PRESETS = [
  'DEFAULT',
  'NONE',
  'SHIELD',
  'BOLT',
  'GLOBE',
  'ROCKET',
  'GHOST',
  'CROWN',
  'GEM',
  'FLAME',
  'WAVES',
  'MOUNTAIN',
  'ORBIT',
  'HEXAGON',
] as const;
export type CardLogoPreset = (typeof CARD_LOGO_PRESETS)[number];

/**
 * Animated ReactBits effects that can render BEHIND the subscription card.
 * `NONE` keeps the plain gradient. The rest map to lazy-loaded ogl/canvas
 * components in the reiwa SPA (`components/reactbits/registry.ts`). Only the
 * dependency-light effects are exposed (reiwa ships `ogl`, not three.js).
 *
 * Adding an effect requires updates in three places:
 *   1. `CARD_EFFECTS` here,
 *   2. the SPA effect registry + renderer,
 *   3. the admin configurator effect grid.
 */
export const CARD_EFFECTS = [
  'NONE',
  'aurora',
  'threads',
  'softAurora',
  'rippleGrid',
  'radar',
  'plasma',
  'particles',
  'liquidChrome',
  'lineWaves',
  'iridescence',
  'grainient',
  'galaxy',
  'balatro',
  'waves',
  'silk',
  'beams',
  'dither',
  // Paper Shaders (WebGL2, @paper-design/shaders-react). Prefixed `paper*`
  // to avoid colliding with the existing reactbits ids (dither/waves/…).
  'paperMesh',
  'paperWarp',
  'paperGrain',
  'paperDither',
  'paperSwirl',
  'paperMetaballs',
] as const;
export type CardEffect = (typeof CARD_EFFECTS)[number];

/**
 * Foreground strategy for the subscription card itself. `auto` preserves the
 * cabinet's contrast resolver; the remaining choices deliberately keep the
 * operator's decision literal instead of changing it from the card artwork.
 */
export const SUBSCRIPTION_CARD_TEXT_MODES = [
  'auto',
  'light',
  'dark',
  'custom',
] as const;
export type SubscriptionCardTextMode =
  (typeof SUBSCRIPTION_CARD_TEXT_MODES)[number];

/**
 * One global subscription-card text decision. A custom colour is retained
 * only in `custom` mode; all accepted custom values are opaque hex colours so
 * the preview and the Reiwa contrast compositor have one unambiguous result.
 */
export interface SubscriptionCardTextSettings {
  readonly mode: SubscriptionCardTextMode;
  readonly color: string | null;
}

/** A composited glass film above card artwork; independent from the effect itself. */
export interface SubscriptionCardGlassSettings {
  readonly enabled: boolean;
  readonly tint: string;
  readonly opacity: number;
  readonly blurPx: number;
  readonly borderOpacity: number;
}

/**
 * How the menu/section icons in the reiwa cabinet are coloured:
 *   - `default` — each icon keeps its own distinct accent (current look).
 *   - `theme`   — every icon uses the brand `primary` colour.
 *   - `custom`  — each icon uses an operator-picked colour from `iconColors`.
 */
export const ICON_COLOR_MODES = ['default', 'theme', 'custom'] as const;
export type IconColorMode = (typeof ICON_COLOR_MODES)[number];

/**
 * Stable keys for the cabinet's themeable menu/section icons. Used as the keys
 * of the `iconColors` map (custom mode) and to render the per-icon colour
 * pickers in the admin configurator.
 */
export const ICON_KEYS = [
  'privacy',
  'notifications',
  'transactions',
  'promocodes',
  'language',
  'support',
  'faq',
] as const;
export type IconKey = (typeof ICON_KEYS)[number];

export const CARD_EFFECT_SLOT_MODES = ['inherit', 'override'] as const;
export type CardEffectSlotMode = (typeof CARD_EFFECT_SLOT_MODES)[number];

/**
 * A single per-position card-background slot. A slot inherits the global
 * operator effect unless it is explicitly switched to `override`; this keeps
 * theme-generated placeholders from masking later global edits.
 */
export interface CardEffectSlot {
  readonly mode: CardEffectSlotMode;
  readonly cardEffect?: CardEffect;
  readonly cardEffectProps?: Record<string, unknown>;
  readonly cardEffectOpacity?: number;
  /**
   * Optional per-slot static card gradient (CSS background). When set it
   * overrides the global `cardGradient` for the Nth subscription card; when
   * absent the card falls back to the global gradient. Lets additional cards
   * get their own static look, not just their own animated effect.
   */
  readonly cardGradient?: string | null;
}

/**
 * App-background rendering modes (site-wide background behind the cabinet):
 *   - `none`     — plain `bgPrimary` colour (default; current behaviour).
 *   - `gradient` — a static CSS gradient (operator-built / preset / generated).
 *   - `texture`  — a static, tileable SVG pattern tinted over a base colour.
 *   - `effect`   — an animated ReactBits effect (reuses the card-effect registry).
 */
export const APP_BACKGROUND_KINDS = ['none', 'gradient', 'texture', 'effect'] as const;
export type AppBackgroundKind = (typeof APP_BACKGROUND_KINDS)[number];

/**
 * Built-in tileable texture patterns the reiwa SPA can render as a pure-CSS
 * SVG background (cheap, static, no WebGL). Adding a pattern requires updates
 * in three places: this list, the reiwa `buildTextureCss` renderer, and the
 * admin texture picker.
 */
export const APP_BACKGROUND_TEXTURES = [
  'dots',
  'grid',
  'diagonal',
  'cross',
  'waves',
  'carbon',
  'triangles',
  'noise',
] as const;
export type AppBackgroundTexture = (typeof APP_BACKGROUND_TEXTURES)[number];

/** Static tiled-texture configuration for `appBackground.kind === 'texture'`. */
export interface AppBackgroundTextureSettings {
  /** Pattern id ∈ `APP_BACKGROUND_TEXTURES`. */
  readonly pattern: AppBackgroundTexture;
  /** Pattern stroke/fill colour (hex). */
  readonly color: string;
  /** Base colour behind the pattern (hex). */
  readonly background: string;
  /** Tile size in px (8–256). */
  readonly scale: number;
  /** Pattern opacity over the base (0.05–1). */
  readonly opacity: number;
}

/**
 * Site-wide app background — rendered BEHIND the whole cabinet. A `kind`
 * discriminator selects between a plain colour, a static gradient, a static
 * texture, or an animated effect. Reuses the shared card-effect registry for
 * `effect`. Mounted once at the cabinet shell (a single WebGL context max for
 * the animated mode; the static modes cost nothing).
 *
 * Backward-compat: payloads written before `kind` existed carry only
 * `effect`/`props`/`opacity`; the reader infers `kind` from the effect id.
 */
export interface AppBackgroundSettings {
  readonly kind: AppBackgroundKind;
  /** Animated effect (kind === 'effect'). */
  readonly effect: CardEffect;
  readonly props: Record<string, unknown>;
  readonly opacity: number;
  /** Static CSS gradient (kind === 'gradient'). */
  readonly gradient: string;
  /** Static tiled texture (kind === 'texture'). */
  readonly texture: AppBackgroundTextureSettings;
}

/**
 * Per-plan tariff-card visual style (keyed by `planId` in
 * `BrandingSettingsInterface.planCardStyles`). All fields optional — an absent
 * style (or absent map entry) means the reiwa cabinet derives a deterministic
 * auto gradient from the plan id, so unconfigured/archived plans still look
 * distinct from each other.
 *
 * Texture resolution priority: `textureUrl` (operator-uploaded image) wins over
 * `texturePreset` (built-in CSS pattern, reuses `APP_BACKGROUND_TEXTURES`).
 */
export interface PlanCardStyle {
  /** CSS background gradient for the card (reuses the card-gradient controls). */
  readonly gradient?: string | null;
  /** Accent hex for price/name highlights on the card. */
  readonly accent?: string | null;
  /** Built-in texture pattern id ∈ `APP_BACKGROUND_TEXTURES`, overlaid on the gradient. */
  readonly texturePreset?: AppBackgroundTexture | null;
  /** Operator-uploaded texture image URL (`/uploads/branding/...`). Priority over `texturePreset`. */
  readonly textureUrl?: string | null;
  /**
   * Optional per-plan animated background effect. `NONE`/absent = static
   * gradient only — tariff cards do NOT inherit the subscription card's global
   * `cardEffect`. Any other value is a card-effect id the cabinet renders live.
   */
  readonly cardEffect?: CardEffect | null;
  /** Tunable params for the per-plan effect (merged over its defaults). */
  readonly cardEffectProps?: Record<string, unknown>;
  /** Per-plan effect layer opacity (0.05–1). */
  readonly cardEffectOpacity?: number | null;
}

/**
 * Remnawave profile-naming template. Profiles are named
 * `<prefix><separator><login><separator><suffixBase>[<separator>N]`, e.g.
 * `rz_john_sub`, `rz_john_sub_1`. Persisted inside `Settings.brandingSettings`
 * (read by `RemnawaveProfileNamingService`).
 */
export interface ProfileNamingSettings {
  readonly prefix: string;
  readonly separator: string;
  readonly suffixBase: string;
}

/**
 * Cabinet bottom-navigation destinations the operator can surface or hide.
 * `subscriptions` and `settings` are ESSENTIAL — always visible, never
 * hideable (hiding them would strand the user). The `referrals` slot is
 * context-aware in the cabinet (swaps to Partner once partner mode activates).
 *
 * Adding a destination requires updates in three places:
 *   1. `NAV_DESTINATIONS` here,
 *   2. the reiwa `useNavTabs` registry (route + icon + label),
 *   3. the admin "Навигация" configurator list.
 */
export const NAV_DESTINATIONS = [
  'subscriptions',
  'plans',
  'referrals',
  'devices',
  'activity',
  'promo',
  'support',
  'faq',
  'settings',
] as const;
export type NavDestinationId = (typeof NAV_DESTINATIONS)[number];

/** Destinations that must always stay visible in the navigation. */
export const NAV_ESSENTIAL_DESTINATIONS: readonly NavDestinationId[] = [
  'subscriptions',
  'settings',
];

/** Max destinations shown in the bottom nav before it gets too crowded. */
export const NAV_MAX_VISIBLE = 5;

/** One navigation entry: a destination id + whether it shows in the nav bar. */
export interface NavItemSetting {
  readonly id: NavDestinationId;
  readonly visible: boolean;
}

/**
 * Theme-owned cabinet surface tokens. Colours and opacities are kept
 * separate so presets can reuse the same tint at different translucency
 * levels without persisting CSS-only `rgba(...)` strings.
 *
 * These defaults mirror the dark Reiwa UI that shipped before the tokens
 * became configurable, keeping older JSON payloads visually identical.
 */
export interface SurfaceThemeSettings {
  /** Default high-contrast copy and icon colour. */
  readonly foreground: string;
  /** Secondary / helper copy colour. */
  readonly mutedForeground: string;
  /** Base glass surface tint. */
  readonly surface: string;
  /** Elevated glass surface tint. */
  readonly surfaceHigh: string;
  /** Subtle border tint. */
  readonly borderSoft: string;
  /** Emphasised border tint. */
  readonly borderStrong: string;
  /** Base surface alpha (0–1). */
  readonly surfaceOpacity: number;
  /** Elevated surface alpha (0–1). */
  readonly surfaceHighOpacity: number;
  /** Subtle border alpha (0–1). */
  readonly borderSoftOpacity: number;
  /** Emphasised border alpha (0–1). */
  readonly borderStrongOpacity: number;
  /** Backdrop blur radius in px (0–40). */
  readonly glassBlurPx: number;
}

/**
 * Exact cabinet corner geometry. Unlike the legacy Tailwind class, these
 * values preserve angular source concepts without quantisation.
 */
export interface CornerRadiiSettings {
  /** Main cards, sheets and modal surfaces (0–48 px). */
  readonly cardPx: number;
  /** Inputs, buttons and nested items (0–32 px). */
  readonly itemPx: number;
  /** Chips and stadium controls (0–9999 px; 9999 = capsule). */
  readonly pillPx: number;
}

/** One allowed brightness for an operator-selected conceptual WEB Reiwa theme. */
export type BrandingThemeMode = 'light' | 'dark';
/** `fixed` keeps the operator mode; `user-selectable` exposes only light/dark in Reiwa. */
export type BrandingThemeModePolicy = 'fixed' | 'user-selectable';

/**
 * Fully resolved visual representation of the same theme concept. It omits
 * brand identity and the preset id by design: Reiwa users can switch only the
 * brightness of the operator-selected concept, never the concept itself.
 */
export interface BrandingThemeVariant {
  readonly primary: string;
  readonly primaryFg: string;
  readonly bgPrimary: string;
  readonly bgSecondary: string;
  readonly cardGradient: string;
  readonly cardPattern: string | null;
  /**
   * Optional only for variants saved before card-text controls existed.
   * Reiwa falls back to the root policy when this is absent; it must not be
   * eagerly replaced with `auto`, or a later root-level choice is masked.
   */
  readonly subscriptionCardText?: SubscriptionCardTextSettings;
  readonly cardEffect: CardEffect;
  readonly cardEffectProps: Record<string, unknown>;
  readonly cardEffectOpacity: number;
  readonly cardEffectsByIndex: readonly CardEffectSlot[];
  readonly bgEffect: BgEffect;
  readonly appBackground: AppBackgroundSettings;
  readonly borderRadius: string;
  readonly cornerRadii: CornerRadiiSettings;
  readonly fontFamily: string;
  readonly surfaceTheme: SurfaceThemeSettings;
}

export interface BrandingThemeVariants {
  readonly light: BrandingThemeVariant;
  readonly dark: BrandingThemeVariant;
}

export interface BrandingSettingsInterface {
  /**
   * Stable id of the ready-made theme currently applied by WEB Reiwa.
   * `null` means the operator has a custom/legacy theme with no preset
   * identity. The id is informational; all resolved visual tokens are stored
   * alongside it so Reiwa never depends on the admin panel at render time.
   */
  readonly themePresetId: string | null;
  /**
   * Schema/generator version of `themePresetId`. Lets future releases
   * distinguish presets with the same stable id but updated resolved tokens.
   */
  readonly themePresetVersion: number | null;
  /** Whether a Reiwa user may choose a light/dark representation. */
  readonly themeModePolicy: BrandingThemeModePolicy;
  /** Operator-selected actual/default representation. */
  readonly themeDefaultMode: BrandingThemeMode;
  /** Both resolved representations of the selected concept, otherwise `null`. */
  readonly themeVariants: BrandingThemeVariants | null;

  /** Display name shown on the subscription card and headers. */
  readonly brandName: string;
  /**
   * Optional short tagline / subtitle shown under the brand name on the
   * launch splash and the in-app loader (and used as the PWA manifest
   * `description`). `null` = no subtitle.
   */
  readonly tagline: string | null;
  /** Optional logo URL (data: or http(s) or `/uploads/...`). */
  readonly logoUrl: string | null;
  /**
   * Optional square PNG used for PWA install (home-screen icon, splash). Kept
   * separate from `logoUrl` because the header logo may be an SVG /
   * transparent / non-square mark, whereas an install icon must be an opaque
   * square raster. Fallback chain at render: `pwaIconUrl → logoUrl → default`.
   */
  readonly pwaIconUrl: string | null;

  /**
   * Optional square icon for installing the ADMIN PANEL itself as a PWA
   * (distinct from `pwaIconUrl`, which is the reiwa cabinet's install icon).
   * Applied at runtime to the admin `apple-touch-icon` + web manifest.
   */
  readonly adminPwaIconUrl: string | null;

  /** Primary action / accent colour (hex, e.g. `#22c55e`). */
  readonly primary: string;
  /** Foreground colour for primary surfaces (hex). */
  readonly primaryFg: string;
  /** Page background colour (hex). */
  readonly bgPrimary: string;
  /** Surface background colour (hex). */
  readonly bgSecondary: string;

  /** CSS background string for the subscription card. */
  readonly cardGradient: string;
  /** Optional CSS background-image (pattern overlay) for the card. */
  readonly cardPattern: string | null;
  /**
   * Explicit text colour policy for subscription cards. It is intentionally
   * separate from `primaryFg`: primary buttons and card content can require
   * different contrast decisions on an operator-created gradient.
   */
  readonly subscriptionCardText: SubscriptionCardTextSettings;

  /** Optional operator-controlled glass composition above every subscription card. */
  readonly subscriptionCardGlass: SubscriptionCardGlassSettings;

  /**
   * Watermark glyph shown on the subscription card. One of the built-in
   * `CARD_LOGO_PRESETS` keys. `DEFAULT` = Reiwa mark, `NONE` = hidden.
   * Ignored when `cardLogoUrl` is set.
   */
  readonly cardLogo: CardLogoPreset;
  /**
   * Optional custom watermark image (data: URI or http(s) URL). When set it
   * overrides `cardLogo`. Rendered as a faint, low-opacity overlay on the
   * card just like the built-in glyphs.
   */
  readonly cardLogoUrl: string | null;

  /**
   * Animated effect rendered behind the subscription card. `NONE` keeps the
   * plain `cardGradient`. Any other value is a ReactBits effect id the SPA
   * renders as a live WebGL/canvas layer.
   */
  readonly cardEffect: CardEffect;
  /**
   * Per-effect tunable parameters (colors, speed, density…), keyed by the
   * effect's control props. Free-form JSON validated loosely on the backend;
   * the SPA merges it over the effect's defaults.
   */
  readonly cardEffectProps: Record<string, unknown>;
  /** Effect layer opacity behind the card (0.05–1). */
  readonly cardEffectOpacity: number;

  /**
   * Per-position card background effects. The Nth slot styles the Nth
   * subscription card (ordered by subscription creation date) for ALL users:
   * slot 0 → first subscription, slot 1 → second, etc. Subscriptions beyond
   * the configured slots fall back to the global `cardEffect`. Empty array =
   * every card uses the global effect (default).
   */
  readonly cardEffectsByIndex: readonly CardEffectSlot[];

  /** Site-wide background-effect preset. */
  readonly bgEffect: BgEffect;

  /**
   * Site-wide app background (`none` / `gradient` / `texture` / `effect`).
   * `none` → plain `bgPrimary` colour. Takes precedence over the legacy preset
   * `bgEffect` when not `none`. Additive: an older reiwa build that doesn't
   * know this field renders the existing background.
   */
  readonly appBackground: AppBackgroundSettings;

  /**
   * Colouring strategy for the cabinet's menu/section icons.
   * `default` keeps each icon's own accent, `theme` paints them all in the
   * brand primary, `custom` uses per-icon colours from `iconColors`.
   */
  readonly iconColorMode: IconColorMode;
  /**
   * Per-icon hex colours, keyed by `IconKey`. Only consulted when
   * `iconColorMode === 'custom'`; missing keys fall back to the brand primary.
   */
  readonly iconColors: Record<string, string>;

  /** Tailwind-friendly border-radius token (e.g. `rounded-2xl`). */
  readonly borderRadius: string;
  /** Exact, independently editable Reiwa corner radii. */
  readonly cornerRadii: CornerRadiiSettings;
  /** Display font family. */
  readonly fontFamily: string;

  /**
   * Themeable text, glass-surface and border tokens. Stored as a complete
   * normalized block on reads; older rows without it receive the shipped
   * dark defaults.
   */
  readonly surfaceTheme: SurfaceThemeSettings;

  /**
   * Per-plan tariff-card visual styles, keyed by `planId`. Drives the reiwa
   * cabinet `/plans` cards. Absent entry → the cabinet derives a deterministic
   * auto gradient from the plan id. Orphaned ids (plan deleted) are ignored.
   * Empty object = every plan uses the auto style (default).
   */
  readonly planCardStyles: Record<string, PlanCardStyle>;

  /**
   * Cabinet bottom-navigation layout: an ordered list of destinations with a
   * `visible` flag each. Drives which icons appear in the reiwa bottom nav /
   * side nav and in what order. Hidden destinations stay reachable from
   * Settings. Essentials (`subscriptions`, `settings`) are forced visible by
   * the reader. Empty/absent → the cabinet uses its built-in default nav.
   */
  readonly navItems: readonly NavItemSetting[];

  /**
   * Spacing (in pixels) between the reiwa cabinet bottom-navigation buttons.
   * Lets the operator tune how tight/roomy the nav bar feels on web / TMA.
   * Clamped to 0–24 by the reader. Default 2 (matches the shipped look).
   */
  readonly navGap: number;

  /**
   * Remnawave profile-naming template (prefix / separator / suffix base).
   * Read by `RemnawaveProfileNamingService` when provisioning panel profiles.
   */
  readonly profileNaming: ProfileNamingSettings;
}

export const DEFAULT_BRANDING: BrandingSettingsInterface = {
  themePresetId: null,
  themePresetVersion: null,
  themeModePolicy: 'fixed',
  themeDefaultMode: 'dark',
  themeVariants: null,
  brandName: 'Reiwa',
  tagline: null,
  logoUrl: null,
  pwaIconUrl: null,
  adminPwaIconUrl: null,
  primary: '#22c55e',
  primaryFg: '#0a0a0a',
  bgPrimary: '#0a0a0a',
  bgSecondary: '#171717',
  cardGradient: 'linear-gradient(135deg, #064e3b 0%, #22c55e 100%)',
  cardPattern: null,
  subscriptionCardText: {
    mode: 'auto',
    color: null,
  },
  subscriptionCardGlass: {
    enabled: false,
    tint: '#ffffff',
    opacity: 0.14,
    blurPx: 8,
    borderOpacity: 0.18,
  },
  cardLogo: 'DEFAULT',
  cardLogoUrl: null,
  cardEffect: 'aurora',
  cardEffectProps: {},
  cardEffectOpacity: 1,
  cardEffectsByIndex: [],
  bgEffect: 'NONE',
  appBackground: {
    kind: 'none',
    effect: 'NONE',
    props: {},
    opacity: 1,
    gradient: 'linear-gradient(135deg, #0a0a0a 0%, #171717 100%)',
    texture: {
      pattern: 'dots',
      color: '#22c55e',
      background: '#0a0a0a',
      scale: 24,
      opacity: 0.15,
    },
  },
  iconColorMode: 'default',
  iconColors: {},
  borderRadius: 'rounded-2xl',
  cornerRadii: {
    cardPx: 24,
    itemPx: 14,
    pillPx: 9999,
  },
  fontFamily: 'Geist Variable, system-ui, sans-serif',
  surfaceTheme: {
    foreground: '#fafafa',
    mutedForeground: '#a1a1a1',
    surface: '#18181b',
    surfaceHigh: '#27272a',
    borderSoft: '#ffffff',
    borderStrong: '#ffffff',
    surfaceOpacity: 0.7,
    surfaceHighOpacity: 0.8,
    borderSoftOpacity: 0.06,
    borderStrongOpacity: 0.12,
    glassBlurPx: 16,
  },
  planCardStyles: {},
  navItems: [
    { id: 'subscriptions', visible: true },
    { id: 'referrals', visible: true },
    { id: 'settings', visible: true },
    { id: 'plans', visible: false },
    { id: 'devices', visible: false },
    { id: 'activity', visible: false },
    { id: 'promo', visible: false },
    { id: 'support', visible: false },
  ],
  navGap: 2,
  profileNaming: { prefix: 'rz', separator: '_', suffixBase: 'sub' },
};
