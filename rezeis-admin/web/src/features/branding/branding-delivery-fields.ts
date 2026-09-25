/**
 * How «Кабинет не принял часть оформления» names what the cabinet refused.
 *
 * The cabinet reports each field by its guard's key (`branding.primary`,
 * `branding.navItems[1]`, `defaultCurrency`) and a reason code
 * (`not-a-hex-colour`, `out-of-range[0.05..1]`) — see
 * `reiwa/src/application/ports/public-config-persistence.port.ts`. The notice
 * turns each into the words the operator already knows from this page: the
 * label the field carries here, the tab it is on, and the reason in plain
 * language.
 *
 * Imports NOTHING — the cabinet's cross-repository test loads this file by
 * absolute path to check that every field and reason its guard can report has
 * words here (the same rule as `branding-form-schema.ts`).
 */

/** How the notice names one field. */
export interface BrandingDeliveryFieldLabel {
  /** The i18n key of the label the field carries on this page, or of its place elsewhere. */
  readonly labelKey: string
  /** Whether the field is edited on this page — the notice then offers its tab. */
  readonly onPage: boolean
}

const onPage = (labelKey: string): BrandingDeliveryFieldLabel => ({ labelKey, onPage: true })
const elsewhere = (labelKey: string): BrandingDeliveryFieldLabel => ({ labelKey, onPage: false })

/**
 * Every field the cabinet's guard judges, by the key it reports. The page's
 * own labels where it has one; fields edited on other pages name that page.
 */
export const BRANDING_DELIVERY_FIELD_LABELS: Readonly<Record<string, BrandingDeliveryFieldLabel>> = {
  'branding.themePresetId': onPage('brandingPage.sections.presets.title'),
  'branding.themePresetVersion': onPage('brandingPage.sections.presets.title'),
  'branding.themeModePolicy': onPage('brandingPage.sections.themeMode.permissionLabel'),
  'branding.themeDefaultMode': onPage('brandingPage.sections.themeMode.defaultLabel'),
  'branding.themeVariants': onPage('brandingPage.sections.themeMode.title'),
  'branding.brandName': onPage('brandingPage.sections.identity.brandName'),
  'branding.tagline': onPage('brandingPage.sections.identity.tagline'),
  'branding.logoUrl': onPage('brandingPage.sections.identity.logoUrl'),
  'branding.pwaIconUrl': onPage('brandingPage.sections.pwaIcon.title'),
  'branding.primary': onPage('brandingPage.sections.colors.primary'),
  'branding.primaryFg': onPage('brandingPage.sections.colors.primaryFg'),
  'branding.bgPrimary': onPage('brandingPage.sections.colors.background'),
  'branding.bgSecondary': onPage('brandingPage.sections.colors.surface'),
  'branding.brandPaletteSource': onPage('brandingPage.sections.colors.title'),
  'branding.cardGradient': onPage('brandingPage.sections.card.gradient'),
  'branding.cardGradientSource': onPage('brandingPage.sections.card.gradient'),
  'branding.cardPattern': onPage('brandingPage.sections.card.pattern'),
  'branding.subscriptionCardText': onPage('brandingPage.sections.card.textMode'),
  'branding.subscriptionCardGlass': onPage('brandingPage.sections.card.glass.title'),
  'branding.cardLogo': onPage('brandingPage.sections.cardLogo.title'),
  'branding.cardLogoUrl': onPage('brandingPage.sections.cardLogo.customUrl'),
  'branding.cardEffect': onPage('brandingPage.sections.cardEffect.title'),
  'branding.cardEffectProps': onPage('brandingPage.sections.cardEffect.title'),
  'branding.cardEffectOpacity': onPage('brandingPage.sections.cardEffect.opacity'),
  'branding.cardEffectsByIndex': onPage('brandingPage.sections.cardEffectSlots.title'),
  'branding.bgEffect': onPage('brandingPage.sections.effects.bgEffect'),
  'branding.appBackground': onPage('brandingPage.sections.appBackground.title'),
  'branding.iconColorMode': onPage('brandingPage.sections.iconColors.title'),
  'branding.iconColors': onPage('brandingPage.sections.iconColors.title'),
  'branding.iconDecor': onPage('brandingPage.sections.dashboardIcons.title'),
  'branding.borderRadius': onPage('brandingPage.sections.effects.borderRadius'),
  'branding.cornerRadii': onPage('brandingPage.sections.effects.title'),
  'branding.fontFamily': onPage('brandingPage.sections.effects.fontFamily'),
  'branding.surfaceTheme': onPage('brandingPage.sections.surfaces.title'),
  'branding.planCardStyles': onPage('brandingPage.sections.planCards.title'),
  'branding.navItems': onPage('brandingPage.sections.nav.title'),
  'branding.navGap': onPage('brandingPage.sections.nav.gap.label'),
  locales: elsewhere('brandingPage.deliveryNotice.elsewhere.locales'),
  defaultLocale: elsewhere('brandingPage.deliveryNotice.elsewhere.locales'),
  defaultCurrency: elsewhere('brandingPage.deliveryNotice.elsewhere.defaultCurrency'),
  customIcons: elsewhere('brandingPage.deliveryNotice.elsewhere.customIcons'),
  botUsername: elsewhere('brandingPage.deliveryNotice.elsewhere.botUsername'),
  supportUsername: elsewhere('brandingPage.deliveryNotice.elsewhere.supportUsername'),
  platformBranding: elsewhere('brandingPage.deliveryNotice.elsewhere.platformBranding'),
  emailEnabled: elsewhere('brandingPage.deliveryNotice.elsewhere.emailEnabled'),
}

const BRANDING_PREFIX = 'branding.'

/**
 * The field a reported key is about: `branding.navItems[1]` → `branding.navItems`,
 * `branding.themeVariants.subscriptionCardText` → `branding.themeVariants`,
 * `customIcons[0]` → `customIcons`.
 */
export function brandingDeliveryFieldOf(path: string): string {
  const inBranding = path.startsWith(BRANDING_PREFIX)
  const rest = inBranding ? path.slice(BRANDING_PREFIX.length) : path
  const name = rest.split(/[.[]/, 1)[0] ?? rest
  return inBranding ? `${BRANDING_PREFIX}${name}` : name
}

/** The form field of a branding key (`branding.primary` → `primary`); `null` off this page. */
export function brandingFormFieldOf(field: string): string | null {
  return field.startsWith(BRANDING_PREFIX) ? field.slice(BRANDING_PREFIX.length) : null
}

/**
 * One entry of a field the cabinet takes entry by entry (reiwa
 * `PUBLIC_CONFIG_KEYED_FIELDS`, 25.09.2026): a refused entry keeps its own
 * previous value, everything else in the field goes live, and the report names
 * the entry by its own path — `branding.planCardStyles.<planId>`,
 * `branding.iconDecor.<key>`, `customIcons[i]`, `branding.cardEffectsByIndex[i]`,
 * `branding.navItems[i]`. The notice names that entry — the plan, the icon, the
 * item — not only the field it is in. `position` counts from 1.
 */
export type BrandingDeliveryEntry =
  | { readonly kind: 'plan'; readonly planId: string }
  | { readonly kind: 'icon'; readonly iconKey: string }
  | { readonly kind: 'customIcon'; readonly position: number }
  | { readonly kind: 'cardSlot'; readonly position: number }
  | { readonly kind: 'navItem'; readonly position: number }

const PLAN_STYLE_PREFIX = 'branding.planCardStyles.'
const ICON_DECOR_PREFIX = 'branding.iconDecor.'
const LIST_ENTRY = /^(customIcons|branding\.cardEffectsByIndex|branding\.navItems)\[(\d+)\]/

/**
 * The entry `path` names, or `null` when it names a whole field. A map entry's
 * key is the REST of the path: a plan id is the panel's to choose and may hold
 * a `.` or a `[`, so it is never split further.
 */
export function brandingDeliveryEntryOf(path: string): BrandingDeliveryEntry | null {
  if (path.startsWith(PLAN_STYLE_PREFIX)) {
    const planId = path.slice(PLAN_STYLE_PREFIX.length)
    return planId === '' ? null : { kind: 'plan', planId }
  }
  if (path.startsWith(ICON_DECOR_PREFIX)) {
    const iconKey = path.slice(ICON_DECOR_PREFIX.length)
    return iconKey === '' ? null : { kind: 'icon', iconKey }
  }
  const listed = LIST_ENTRY.exec(path)
  if (listed === null) return null
  const position = Number(listed[2]) + 1
  if (listed[1] === 'customIcons') return { kind: 'customIcon', position }
  if (listed[1] === 'branding.cardEffectsByIndex') return { kind: 'cardSlot', position }
  return { kind: 'navItem', position }
}

/**
 * The `id` a reported value names — a custom icon's, a menu item's — or `null`.
 * The value is the entry as JSON, cut at 120 characters, so it is searched for
 * the key rather than parsed; a quoted `"id"` inside a string is escaped there
 * and never matches.
 */
export function brandingDeliveryEntryIdOf(value: string): string | null {
  const match = /"id"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(value)
  if (match === null) return null
  try {
    return JSON.parse(`"${match[1] ?? ''}"`) as string
  } catch {
    return match[1] ?? null
  }
}

/**
 * The reasons a refused ENTRY carries — the field's own codes, worded for the
 * one entry the notice now names («оформление этой карточки…», not «…одной из
 * тарифных карточек…»).
 */
export const BRANDING_DELIVERY_ENTRY_REASONS: readonly string[] = [
  'not-a-valid-plan-card-style-map',
  'not-a-valid-icon-decor-map',
  'not-a-valid-custom-icon',
  'not-a-valid-card-effect-slot',
  'not-a-valid-nav-item',
  'duplicate-destination-id',
]

const ENTRY_REASONS = new Set(BRANDING_DELIVERY_ENTRY_REASONS)

/** How the notice words a reason: an i18n key, and what it interpolates. */
export interface BrandingDeliveryReasonText {
  readonly key: string
  readonly values?: Readonly<Record<string, string>>
}

/** Every reason the cabinet's guard gives, as it spells it. */
export const BRANDING_DELIVERY_REASONS: readonly string[] = [
  'not-an-object',
  'not-an-array',
  'empty',
  'contains-a-blank-entry',
  'not-a-non-empty-string',
  'not-listed-in-locales',
  'not-a-preset-id',
  'not-a-preset-version',
  'not-an-allowed-value',
  'not-a-valid-theme-variant-pair',
  'not-a-string-or-null',
  'not-an-allowed-image-url',
  'not-a-hex-colour',
  'not-a-safe-css-gradient',
  'not-a-safe-css-gradient-or-null',
  'not-a-valid-card-text-policy',
  'does-not-match-the-root-card-text-policy',
  'not-a-valid-glass-layer',
  'not-a-string',
  'not-an-effect-id',
  'not-a-valid-card-effect-slot',
  'not-a-valid-app-background',
  'not-a-hex-colour-map',
  'not-a-valid-icon-decor-map',
  'not-a-valid-corner-radius-set',
  'not-a-valid-surface-theme',
  'not-a-valid-custom-icon',
  'not-a-valid-platform-branding',
  'not-a-boolean',
  'not-a-valid-plan-card-style-map',
  'not-a-valid-nav-item',
  'duplicate-destination-id',
]

const KNOWN_REASONS = new Set(BRANDING_DELIVERY_REASONS)
const OUT_OF_RANGE = /^out-of-range\[(-?[\d.]+)\.\.(-?[\d.]+)\]$/
const TOO_MANY = /^too-many-entries\[max=(\d+)\]$/

/**
 * The words for a reason code. The two codes that carry their bounds are
 * read apart; a code this panel has never heard of — a newer cabinet — gets a
 * plain "not accepted" rather than a raw code.
 */
export function brandingDeliveryReasonText(reason: string): BrandingDeliveryReasonText {
  const range = OUT_OF_RANGE.exec(reason)
  if (range) {
    return { key: 'brandingPage.deliveryNotice.reasons.outOfRange', values: { min: range[1] ?? '', max: range[2] ?? '' } }
  }
  const tooMany = TOO_MANY.exec(reason)
  if (tooMany) {
    return { key: 'brandingPage.deliveryNotice.reasons.tooManyEntries', values: { max: tooMany[1] ?? '' } }
  }
  return KNOWN_REASONS.has(reason)
    ? { key: `brandingPage.deliveryNotice.reasons.${reason}` }
    : { key: 'brandingPage.deliveryNotice.reasons.unknown' }
}

/** The words for a reason on a refused entry: the entry's own where it has some, else the field's. */
export function brandingDeliveryEntryReasonText(reason: string): BrandingDeliveryReasonText {
  return ENTRY_REASONS.has(reason)
    ? { key: `brandingPage.deliveryNotice.entryReasons.${reason}` }
    : brandingDeliveryReasonText(reason)
}

export const BRANDING_DELIVERY_QUERY_KEY = ['admin', 'branding', 'delivery'] as const

/**
 * When, after a successful save, the page asks the panel again. The first
 * lands after the webhook's usual second; the last after two of the cabinet's
 * 20-second polls, for a webhook that was lost.
 */
export const DELIVERY_RECHECKS_AFTER_SAVE_MS: readonly number[] = [2_000, 6_000, 12_000, 20_000, 30_000, 42_000]

/** One field the cabinet kept at its previous value. */
export interface BrandingDeliveryRejectedField {
  readonly path: string
  readonly reason: string
  readonly value: string
}

/**
 * The fields out of the endpoint's answer — `{ report: { rejected } }` — and
 * nothing for anything else. Lenient on purpose: the notice is advice, and an
 * answer it cannot read must leave the page as it is.
 */
export function readBrandingDeliveryNotice(data: unknown): readonly BrandingDeliveryRejectedField[] {
  const report = (data as { report?: unknown } | null | undefined)?.report
  const rejected = (report as { rejected?: unknown } | null | undefined)?.rejected
  if (!Array.isArray(rejected)) return []
  return rejected.filter(
    (entry): entry is BrandingDeliveryRejectedField =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as Record<string, unknown>).path === 'string' &&
      typeof (entry as Record<string, unknown>).reason === 'string' &&
      typeof (entry as Record<string, unknown>).value === 'string',
  )
}
