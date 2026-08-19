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
 * Animated effects that can render BEHIND the subscription card. `NONE` keeps
 * the plain gradient; the rest map to lazy-loaded components in both front
 * ends.
 *
 * This list exists to validate what the admin API accepts. It is not the source
 * of truth for what an effect IS — that is
 * `web/src/features/branding/card-effect-catalog.ts`, which also carries each
 * effect's controls, palette and renderer, and from which the panel's form
 * schema and preview are derived. `test/card-effect-catalog-contract.spec.ts`
 * holds the two together; adding an effect to the catalog without adding it
 * here fails that test rather than surfacing as a save the panel's own picker
 * caused the API to refuse.
 *
 * The cabinet keeps its own catalog and deliberately does NOT validate against
 * a copy of this list, so that a panel released ahead of it cannot freeze a
 * live configuration. See `isEffectId` in reiwa's public-config guard.
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
  // Originkit — see web/src/features/branding/card-effect-catalog.ts.
  'snowfall',
  'stardust',
  'asciiRain',
  'asciiFlame',
  'characterWaves',
  'blinkingSquares',
  'lineRipple',
  'pulseLines',
  'textWave',
  'pixelCard',
  'glitterWrap',
  'chromaticWaves',
  'dotMatrix',
  'pixelTetris',
  'risingLines',
  'starBurst',
  'particleTunnel',
  'floatingIcons',
  'snakeGrid',
  'gridHole',
  'waveArcs',
  'reactiveGrid',
  'reactiveLines',
  'prismGrid',
  'thunderstrike',
  'blackhole',
  'cosmicOrb',
  'tornado',
  'cube',
  'wordGlobe',
  'particleSphere',
  // Repaired reactbits — see web/src/features/branding/card-effect-catalog.ts.
  'colorBends',
  'pixelBlast',
  'plasmaWave',
  'evilEye',
  'lightPillar',
  'prismaticBurst',
  'faultyTerminal',
  'letterGlitch',
  'shapeGrid',
  'magicRings',
  'laserFlow',
  'antigravity',
] as const;
export type CardEffect = (typeof CARD_EFFECTS)[number];

/** See `BrandingSettingsInterface.cardGradientSource`. */
export const CARD_GRADIENT_SOURCES = ['concept', 'custom'] as const;
export type CardGradientSource = (typeof CARD_GRADIENT_SOURCES)[number];

/** See `BrandingSettingsInterface.brandPaletteSource`. */
export const BRAND_PALETTE_SOURCES = ['concept', 'custom'] as const;
export type BrandPaletteSource = (typeof BRAND_PALETTE_SOURCES)[number];

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

/**
 * Foreground strategy for ONE tariff card. The four subscription-card modes
 * mean exactly the same thing here, plus `inherit`, which follows the global
 * `subscriptionCardText` decision.
 *
 * `inherit` and `auto` are deliberately different values. `auto` is an explicit
 * per-plan instruction to compute contrast from that card's own artwork, which
 * is the only way to exempt a single plan while the global policy is `light`,
 * `dark` or `custom`. Collapsing the two would make that impossible to express.
 */
export const PLAN_CARD_TEXT_MODES = [
  'inherit',
  'auto',
  'light',
  'dark',
  'custom',
] as const;
export type PlanCardTextMode = (typeof PLAN_CARD_TEXT_MODES)[number];

/**
 * One per-plan tariff-card text decision. Same shape as
 * `SubscriptionCardTextSettings` so the two controls stay interchangeable; a
 * custom colour is retained only in `custom` mode and is always an opaque hex,
 * because an alpha-bearing foreground would make the rendered colour depend on
 * the artwork underneath it and break parity with the admin preview.
 */
export interface PlanCardTextSettings {
  readonly mode: PlanCardTextMode;
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
 * The plate the brand mark sits on across the cabinet's entry screens
 * (sign-in, splash, change-password, mini-app bootstrap).
 *
 *   - `glass`   — translucent surface + hairline + backdrop blur (the look
 *                 every deployment had before this setting existed).
 *   - `solid`   — the same surface, opaque, no backdrop blur. Cheaper on iOS,
 *                 where a backdrop-filtered layer is re-sampled per frame.
 *   - `outline` — hairline only, no fill.
 *   - `none`    — no plate at all; the mark sits directly on the background.
 */
export const BRAND_LOGO_FRAMES = ['glass', 'solid', 'outline', 'none'] as const;
export type BrandLogoFrame = (typeof BRAND_LOGO_FRAMES)[number];

/**
 * How the uploaded `logoUrl` is PRESENTED on the entry screens — distinct from
 * which file it is.
 *
 * `size` and `fill` are two knobs because they answer two different questions
 * and one cannot substitute for the other. `size` grows the whole tile on
 * screen; `fill` decides how much of that tile the mark occupies. An operator
 * whose SVG carries its own internal padding — the common case for a 1024×1024
 * app-icon export, whose artboard reserves a safe area around the mark — sees a
 * mark that looks small no matter how large the tile is, because `object-fit`
 * fits the artboard, padding included. Only `fill` recovers that space.
 */
export interface BrandLogoSettings {
  /** Whole-tile size multiplier on the entry screens, 1–1.75. */
  readonly size: number;
  /** Fraction of the tile the mark fills, 0.4–1. */
  readonly fill: number;
  /** The plate behind the mark. `none` removes it. */
  readonly frame: BrandLogoFrame;
  /**
   * Corner rounding of the tile as a percentage of its width (0–50; 50 is a
   * circle) — or `null`, meaning "follow the cabinet theme's item radius".
   *
   * `null` is the default because it is what the tile did before this setting:
   * its class was `rounded-3xl`, i.e. `calc(var(--radius) * 2.2)`, and
   * `--radius` is the operator's `cornerRadii.itemPx`. A fixed percentage
   * default would have rounded off a theme configured with sharp corners and
   * flattened one configured round — on the first screen every subscriber
   * sees, for every deployment that changed nothing.
   */
  readonly radius: number | null;
  /** Brand glow behind the tile, 0–1. `0` removes it. */
  readonly glow: number;
}

/**
 * Size and weight of the watermark on subscription and tariff cards. Separate
 * from `cardLogo`/`cardLogoUrl`, which choose WHICH mark; these decide how big
 * and how present it is.
 */
export interface CardLogoStyleSettings {
  /** Size multiplier relative to the card's default watermark box, 0.5–2. */
  readonly scale: number;
  /** Watermark opacity, 0.02–0.4. */
  readonly opacity: number;
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
 *   - `none`     — the cabinet's BUILT-IN background: reiwa's `<NetworkBg>`,
 *     i.e. three soft `--brand-primary` glows, a dot grid and four diagonals.
 *     Default, and the behaviour of every installation that predates this list.
 *   - `plain`    — the flat `bgPrimary` colour and nothing else.
 *   - `gradient` — a static CSS gradient (operator-built / preset / generated).
 *   - `texture`  — a static, tileable SVG pattern tinted over a base colour.
 *   - `effect`   — an animated ReactBits effect (reuses the card-effect registry).
 *
 * `none` USED TO BE DOCUMENTED HERE AS THE PLAIN COLOUR, in this comment, in
 * `AppBackgroundSettings` below and in the panel's own hint text. The cabinet
 * never did that: `StealthLayout` renders `<NetworkBg>` whenever the kind is
 * `none`, and always has. The panel preview drew the promise (nothing) while
 * the cabinet drew the code (a pattern), and the two therefore disagreed
 * precisely in the state an operator selects to check that they had turned the
 * background OFF.
 *
 * The code won. Renaming the stored value would have silently restyled every
 * installation that never touched this setting, so `none` still means what it
 * has always drawn and `plain` is the new value for what the text promised.
 *
 * ADDING A KIND TOUCHES SIX PLACES, and the cabinet's is the one with teeth:
 *   1. this list,
 *   2. `AppBackgroundDto` (validation of the admin API request),
 *   3. `readAppBackground` in `branding-settings.util.ts` (the reader),
 *   4. reiwa's snapshot guard — `isAppBackgroundKind` in
 *      `src/application/ports/public-config-persistence.port.ts`,
 *   5. reiwa's renderers (`StealthLayout` + `AppBackground`), which funnel
 *      through `resolveAppBackgroundKind`,
 *   6. the panel picker (`BRANDING_APP_BG_KINDS`), its preview and its i18n.
 *
 * Number 4 no longer validates against a copy of this list, deliberately — see
 * the note on `CARD_EFFECTS` above for the outage that made every such copy a
 * liability. A cabinet released before this panel resolves an unknown kind to
 * `none` instead of discarding the whole branding snapshot.
 */
export const APP_BACKGROUND_KINDS = [
  'none',
  'plain',
  'gradient',
  'texture',
  'effect',
] as const;
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
 * discriminator selects between the cabinet's built-in pattern (`none`), a flat
 * colour (`plain`), a static gradient, a static texture, or an animated effect.
 * Reuses the shared card-effect registry for `effect`. Mounted once at the
 * cabinet shell (a single WebGL context max for the animated mode; the static
 * modes cost nothing).
 *
 * Backward-compat: payloads written before `kind` existed carry only
 * `effect`/`props`/`opacity`; the reader infers `kind` from the effect id, and
 * resolves the no-effect case to `none` — the built-in pattern those payloads
 * have always rendered, never `plain`.
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
  /**
   * Per-plan tariff-card text policy.
   *
   * ABSENT MEANS INHERIT, and that is load-bearing rather than incidental. Every
   * installation that predates this control has no `text` key on any entry, and
   * every one of them must keep rendering exactly as it does today: absent →
   * inherit → the global `subscriptionCardText` → `auto` (its default) → the
   * cabinet's existing automatic contrast computation. Materialising a default
   * here — writing `{ mode: 'inherit' }` onto entries nobody edited, or reading
   * absence as `auto` — would either bloat every stored entry or silently detach
   * these cards from a global policy an operator had already chosen.
   *
   * Same rule the positional card slots follow (`CardEffectSlot.mode`): the
   * global control is the baseline, an explicit override changes one position.
   * `readPlanCardStyles` therefore also DROPS a stored `inherit`, so the
   * persisted payload of an operator who selected inherit is byte-identical to
   * one who never opened the control.
   */
  readonly text?: PlanCardTextSettings;
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
 * The border-radius vocabulary the Reiwa cabinet accepts, and therefore the
 * only one the panel may write OR read back.
 *
 * The cabinet guard (`reiwa/src/application/ports/public-config-persistence.port.ts`,
 * `BORDER_RADII`) refuses a snapshot carrying anything else, and a refusal
 * there is not an error anyone sees: the cabinet keeps serving its PREVIOUS
 * snapshot, so its appearance freezes on that snapshot indefinitely. The same
 * class of divergence already cost an outage on `navItems` and on
 * `cardEffect`; both are commented in that file. The value is checked twice
 * over there — once at the root, once inside each brightness snapshot
 * (`isThemeVariant`) — and either failure discards the WHOLE public config,
 * not just the radius.
 *
 * THIS LIST IS THE ONLY COPY IN THE BACKEND, deliberately. It lives here
 * rather than in `update-branding-settings.dto.ts` because both stages need
 * it and two lists that must agree is exactly the defect this guards:
 *   1. `@IsBorderRadiusClass()` in the DTO refuses the write,
 *   2. `readBorderRadius` in `branding-settings.util.ts` refuses the read, so
 *      a row that never came through the DTO — a legacy row, a restored
 *      backup, a seed, a direct DB edit, a future migration — cannot reach the
 *      cabinet either.
 *
 * `DEFAULT_BRANDING.borderRadius` must stay a member of this list: it is what
 * the reader substitutes for an unrenderable persisted value.
 *
 * A seventh member has to reach the cabinet FIRST — see the note on
 * `CARD_EFFECTS` above for why a panel released ahead of the cabinet freezes a
 * live configuration.
 */
export const BORDER_RADIUS_CLASSES = [
  'rounded-none',
  'rounded-lg',
  'rounded-xl',
  'rounded-2xl',
  'rounded-3xl',
  'rounded-full',
] as const;

export type BorderRadiusClass = (typeof BORDER_RADIUS_CLASSES)[number];

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
   * How `logoUrl` is presented on the cabinet's entry screens (tile size, how
   * much of it the mark fills, the plate behind it, its rounding and glow).
   * Defaults reproduce the pre-setting rendering exactly.
   */
  readonly brandLogo: BrandLogoSettings;

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
  /**
   * Who owns the four colours above, and therefore who wins when the root
   * values and a per-brightness theme variant disagree.
   *
   *   - `concept` — a concept preset supplies them, and its light/dark
   *     palettes apply. Generating a different palette per brightness is what
   *     a concept is FOR.
   *   - `custom` — the operator picked a colour by hand. The root quartet wins
   *     everywhere and no variant may override it.
   *
   * Same defect, same shape as `cardGradientSource` below: the panel wrote the
   * colour to the root only, the concept's snapshot overwrote it on every read
   * in the cabinet, and the operator saw their colour in the panel preview and
   * nowhere else. It cannot be fixed the way the font and the corner radii
   * were ("root always wins") — those have no per-brightness meaning at all,
   * while a palette has one exactly when a concept supplies it.
   *
   * The four colours share ONE flag on purpose: they are one palette, and
   * taking two of them from the operator and two from the concept produces a
   * combination neither designed. Legacy payloads have no source and resolve
   * as `concept`, which is exactly the previous behaviour.
   */
  readonly brandPaletteSource: BrandPaletteSource;

  /** CSS background string for the subscription card. */
  readonly cardGradient: string;
  /**
   * Who owns `cardGradient`, and therefore who wins when the root value and a
   * per-brightness theme variant disagree.
   *
   *   - `concept` — a concept preset supplies it, and its light/dark palettes
   *     apply. Generating a different gradient per brightness is what a
   *     concept is FOR.
   *   - `custom` — the operator wrote it. The root value wins everywhere and
   *     no variant may override it.
   *
   * One field used to carry both meanings with no way to tell them apart, so
   * the variant always won: an operator saved a gradient, the cabinet went on
   * drawing the concept's, on every read. Legacy payloads have no source and
   * resolve as `concept`, which is exactly the previous behaviour.
   */
  readonly cardGradientSource: CardGradientSource;
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
   * How big and how present that watermark is. Applies to both the built-in
   * glyphs and a custom `cardLogoUrl`, so the two cannot drift apart.
   */
  readonly cardLogoStyle: CardLogoStyleSettings;

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

  /**
   * Site-wide background-effect preset.
   *
   * @deprecated Superseded by `appBackground` with `kind: 'effect'`, which
   * carries the same NONE/MESH/PARTICLES/NOISE/AURORA vocabulary and is the
   * one the cabinet actually renders (a WebGL layer in
   * `reiwa/web/src/components/layout/app-background.tsx`).
   *
   * This field paints nothing, at any value. Reiwa copies it to
   * `root.dataset["bgEffect"]` in `lib/branding-document.ts` and no CSS
   * selector, component or preview reads that attribute; the admin panel has
   * no control for it either, so only theme presets ever write it. It is NOT
   * the fallback that applies while `appBackground.kind === 'none'` — that
   * case draws the cabinet's built-in `<NetworkBg>`, which does not consult
   * this value.
   *
   * Kept as a stored field: removing it needs a settings migration and buys
   * nothing. Do not wire it up.
   */
  readonly bgEffect: BgEffect;

  /**
   * Site-wide app background (`none` / `plain` / `gradient` / `texture` /
   * `effect`). `none` → the cabinet's built-in `<NetworkBg>` pattern, which is
   * the default; `plain` → the flat `bgPrimary` colour and nothing else. This
   * is the only field that selects a site-wide background; the deprecated
   * `bgEffect` above does not compete with it at any value. Additive: an
   * older reiwa build that doesn't know this field renders the existing
   * background, and one that doesn't know a newer `kind` falls back to `none`
   * rather than refusing the snapshot.
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
  // Reproduces the rendering that preceded this setting. The cabinet's entry
  // tile was `h-20 w-20 rounded-3xl` holding an `h-11 w-11` mark — 44/80 =
  // 0.55 — and its splash tile `h-24 w-24 rounded-[28px]` holding `h-14 w-14`
  // — 56/96 = 0.583. One fill ratio now serves both, so one of the two moves:
  // 0.58 keeps the splash within a third of a pixel (56 → 55.68) and grows the
  // sign-in mark by 2.4 px (44 → 46.4), which is the direction an operator
  // complaining about a small mark wants anyway. `radius: null` keeps the
  // corners following the theme, as `rounded-3xl` did.
  brandLogo: {
    size: 1,
    fill: 0.58,
    frame: 'glass',
    radius: null,
    glow: 1,
  },
  adminPwaIconUrl: null,
  primary: '#22c55e',
  primaryFg: '#0a0a0a',
  bgPrimary: '#0a0a0a',
  bgSecondary: '#171717',
  brandPaletteSource: 'concept',
  cardGradient: 'linear-gradient(135deg, #064e3b 0%, #22c55e 100%)',
  cardGradientSource: 'concept',
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
  // 0.1 is what every card drew before the setting existed. The custom-image
  // branch of the cabinet's watermark carried 0.12 in its own class while two
  // of its three call sites overrode it back to 0.10 and the third did not, so
  // a custom mark was fainter on the dashboard than on the picker. One value
  // now feeds both branches and all three call sites.
  cardLogoStyle: {
    scale: 1,
    opacity: 0.1,
  },
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
