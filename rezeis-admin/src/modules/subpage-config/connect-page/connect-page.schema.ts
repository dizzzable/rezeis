/**
 * connect-page.schema
 * ───────────────────
 * The catalog the cabinet's connect screen renders: which apps exist per
 * platform, how to install them, and what each button does.
 *
 * This is v2 and it is OURS. v1 was the fork's shape — a passthrough mirror of
 * `remnawave/subscription-page`, whose real validation lived downstream in that
 * (AGPL) project, so `platforms` was literally `z.record(z.string(), z.unknown())`
 * and nothing checked it at all. Once the cabinet is the only renderer there is
 * no downstream left: a broken catalog would reach a paying customer as a blank
 * screen, and the operator would hear about it from support. So everything below
 * is checked HERE, at save time, while the person who can fix it is still looking
 * at it.
 *
 * ── Four things v1 could not express ─────────────────────────────────────────
 *
 * 1. ORDER. v1 kept platforms in an object and relied on key order, which is not
 *    a contract in JSON, in Postgres `jsonb`, or in `Object.keys`. Order is
 *    operator content — which app is offered first is a decision — so it lives
 *    in an array.
 *
 * 2. APP IDENTITY. v1 identified an app only by its display name, so "remember
 *    which app this customer uses" was impossible to store: renaming "Happ" to
 *    "Happ (recommended)" would lose every remembered choice. `id` is a stable
 *    slug and is never shown.
 *
 * 3. WHAT A BUTTON DOES. v1 had `type: 'external' | 'subscriptionLink'` and one
 *    `link` field that meant a different thing for each — and, worse, meant a
 *    different thing again depending on WHERE the placeholder sat inside it.
 *    Here each kind carries only the fields it can use.
 *
 * 4. THE FALLBACK. Copying the link is not a footnote for when the deep link
 *    fails — on the donor's own page it is a wall of text at the bottom titled
 *    "if the subscription was not added". It is a first-class button kind so an
 *    operator can put it in the same card, one tap away.
 *
 * ── The encoding decision is made HERE, once ─────────────────────────────────
 *
 * `{{SUBSCRIPTION_LINK}}` means two different things depending on its position:
 *
 *     happ://add/{{SUBSCRIPTION_LINK}}                ← path: substitute raw
 *     clash://install-config?url={{SUBSCRIPTION_LINK}} ← query: percent-encode
 *
 * Substituted raw into a query parameter, the `?`, `&`, `=` and `#` inside a
 * subscription URL truncate it, and the app opens and adds nothing — which
 * reads to everyone as "the deep link is broken".
 *
 * The cabinet must NOT re-derive that rule: the panel and the cabinet ship as
 * separate images, and the same rule written on both sides of an image boundary
 * is the shape that has already drifted apart on us more than once. So the panel
 * derives `encode` at save time and stores it, and the cabinet only obeys it.
 * One rule, one place, one direction of travel.
 */
import { z } from 'zod';

// ── Bounds ───────────────────────────────────────────────────────────────────
//
// Operator-authored data that ends up in a customer's browser. Every list and
// every string is bounded, because "an operator would not do that" is not a
// guarantee and a paste accident should cost a refusal, not a payload.

export const MAX_PLATFORMS = 20;
export const MAX_APPS_PER_PLATFORM = 30;
export const MAX_STEPS_PER_APP = 12;
export const MAX_BUTTONS_PER_STEP = 6;
export const MAX_TEXT_LENGTH = 2_000;
export const MAX_URL_LENGTH = 2_000;
export const MAX_ICONS = 200;
export const MAX_ICON_BYTES = 32 * 1024;

/** The one token an operator may write into a deep-link template. */
export const SUBSCRIPTION_LINK_TOKEN = '{{SUBSCRIPTION_LINK}}';

/**
 * Platforms the cabinet can detect and offer.
 *
 * A closed list on purpose: the screen picks one automatically, and it can only
 * pick from something it knows how to detect. An operator inventing "windows11"
 * would author a section nobody is ever shown.
 */
export const PLATFORM_IDS = [
  'ios',
  'android',
  'windows',
  'macos',
  'linux',
  'androidtv',
  'appletv',
] as const;
export type PlatformId = (typeof PLATFORM_IDS)[number];

/**
 * Schemes that must never become an `href`.
 *
 * The operator authoring a template is trusted, but "trusted" is not the same as
 * "cannot make a mistake", and a template travels from the panel through the
 * database into every customer's browser. `javascript:` and `data:` in that
 * position are script execution in the cabinet's own origin.
 */
const FORBIDDEN_SCHEMES = new Set(['javascript', 'data', 'vbscript', 'file', 'blob', 'about']);

const SCHEME = /^([a-z][a-z0-9+.-]*):/i;

function schemeOf(value: string): string | null {
  const match = SCHEME.exec(value.trim());
  return match === null ? null : match[1].toLowerCase();
}

// ── Leaves ───────────────────────────────────────────────────────────────────

/**
 * One string in every language the operator filled in.
 *
 * Not every language has to be present: a half-translated catalog is a normal
 * state to save from, and the cabinet falls back to whatever it has rather than
 * showing an empty card.
 */
export const localizedTextSchema = z
  .record(z.string().regex(/^[a-z]{2}$/, 'Language must be a two-letter code'), z.string().max(MAX_TEXT_LENGTH))
  .refine(
    (value) => Object.values(value).some((text) => text.trim().length > 0),
    'At least one language must carry text',
  );

export type LocalizedText = z.infer<typeof localizedTextSchema>;

const slugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'Use lowercase letters, digits, hyphen and underscore');

const httpUrlSchema = z
  .string()
  .min(1)
  .max(MAX_URL_LENGTH)
  .refine((value) => {
    const scheme = schemeOf(value);
    return scheme === 'http' || scheme === 'https';
  }, 'A store or download link must be http(s)');

/**
 * A deep-link template: a scheme, and exactly one placeholder.
 *
 * Exactly one, because two placeholders in one template is not a shape anyone
 * meant to write and its encoding is undecidable — the second occurrence would
 * need a different rule from the first.
 */
const deepLinkTemplateSchema = z
  .string()
  .min(1)
  .max(MAX_URL_LENGTH)
  .superRefine((value, ctx) => {
    const scheme = schemeOf(value);
    if (scheme === null) {
      ctx.addIssue({ code: 'custom', message: 'A deep link must start with a scheme, e.g. happ://' });
      return;
    }
    if (FORBIDDEN_SCHEMES.has(scheme)) {
      ctx.addIssue({ code: 'custom', message: `The scheme "${scheme}:" is not allowed in a link` });
    }
    const first = value.indexOf(SUBSCRIPTION_LINK_TOKEN);
    if (first === -1) {
      ctx.addIssue({
        code: 'custom',
        message: `A deep link must contain ${SUBSCRIPTION_LINK_TOKEN}`,
      });
      return;
    }
    if (value.indexOf(SUBSCRIPTION_LINK_TOKEN, first + 1) !== -1) {
      ctx.addIssue({
        code: 'custom',
        message: `${SUBSCRIPTION_LINK_TOKEN} may appear only once`,
      });
    }
  });

/**
 * How the cabinet must substitute the subscription URL into the template.
 *
 * Derived, never authored — see {@link encodingFor}. It is stored because the
 * cabinet is a different image and must not own a copy of the rule.
 */
export const LINK_ENCODINGS = ['raw', 'component'] as const;
export type LinkEncoding = (typeof LINK_ENCODINGS)[number];

/**
 * `component` exactly when the placeholder sits in the query string.
 *
 * The test is positional and not a list of apps: a template we have never seen
 * gets the right answer, and an app that changes its format gets the right
 * answer the next time it is saved.
 */
export function encodingFor(template: string): LinkEncoding {
  const placeholder = template.indexOf(SUBSCRIPTION_LINK_TOKEN);
  if (placeholder === -1) return 'raw';
  const query = template.indexOf('?');
  return query !== -1 && query < placeholder ? 'component' : 'raw';
}

// ── Buttons ──────────────────────────────────────────────────────────────────

const externalButtonSchema = z.object({
  kind: z.literal('external'),
  label: localizedTextSchema,
  url: httpUrlSchema,
});

const deepLinkButtonSchema = z.object({
  kind: z.literal('deepLink'),
  label: localizedTextSchema,
  template: deepLinkTemplateSchema,
  /** Filled in by {@link normalizeConnectPageConfig}; an authored value is overwritten. */
  encode: z.enum(LINK_ENCODINGS).optional(),
});

/**
 * The escape hatch, as a button rather than as a paragraph.
 *
 * It carries no url of its own: the link belongs to the customer's subscription,
 * and a catalog that could name one would be a catalog that could name somebody
 * else's.
 */
const copyLinkButtonSchema = z.object({
  kind: z.literal('copyLink'),
  label: localizedTextSchema,
});

export const buttonSchema = z.discriminatedUnion('kind', [
  externalButtonSchema,
  deepLinkButtonSchema,
  copyLinkButtonSchema,
]);

export type ConnectPageButton = z.infer<typeof buttonSchema>;

// ── Steps, apps, platforms ───────────────────────────────────────────────────

export const stepSchema = z.object({
  title: localizedTextSchema,
  body: localizedTextSchema.nullable().optional(),
  iconKey: slugSchema.nullable().optional(),
  buttons: z.array(buttonSchema).max(MAX_BUTTONS_PER_STEP),
});

export type ConnectPageStep = z.infer<typeof stepSchema>;

export const appSchema = z.object({
  /** Stable, never shown. Remembering a customer's choice hangs off this. */
  id: slugSchema,
  /** A product name, deliberately not localized — "Hiddify" is "Hiddify". */
  name: z.string().min(1).max(64),
  iconKey: slugSchema.nullable().optional(),
  /** The one offered first when the screen opens. */
  featured: z.boolean().default(false),
  steps: z.array(stepSchema).max(MAX_STEPS_PER_APP),
});

export type ConnectPageApp = z.infer<typeof appSchema>;

export const platformSchema = z.object({
  id: z.enum(PLATFORM_IDS),
  title: localizedTextSchema,
  iconKey: slugSchema.nullable().optional(),
  apps: z.array(appSchema).min(1, 'A platform with no apps offers nothing').max(MAX_APPS_PER_PLATFORM),
});

export type ConnectPagePlatform = z.infer<typeof platformSchema>;

// ── The config ───────────────────────────────────────────────────────────────

export const connectPageConfigSchema = z
  .object({
    version: z.literal(2),
    /**
     * Ordered, and the order is the operator's. An object keyed by platform
     * would put the order at the mercy of whatever serializes it next.
     */
    platforms: z.array(platformSchema).max(MAX_PLATFORMS),
    /**
     * Sanitized SVG markup by key. Values arrive as authored and leave through
     * `sanitizeIconMarkup` — the panel is the only place that can be trusted to
     * do it, because it is the only place that sees the write.
     */
    icons: z.record(slugSchema, z.string().max(MAX_ICON_BYTES)).refine(
      (value) => Object.keys(value).length <= MAX_ICONS,
      `At most ${MAX_ICONS} icons`,
    ),
    /**
     * Whether "Подключить" opens this screen or keeps redirecting outward.
     *
     * It rides in the catalog rather than in the platform policy on purpose:
     * the flag and the thing it switches on then travel in one payload, behind
     * one cache and one invalidation, so they can never disagree with each
     * other for a TTL. It also needs no migration, and an operator edits the
     * switch in the same place they edit what it reveals.
     *
     * Off by default. It replaces a flow that works, so it is opted into — and
     * the off position is the rollback: no deploy, one switch.
     */
    connectScreenEnabled: z.boolean().default(false),
    /**
     * Show the raw connection keys on the screen. Off by default: inside the
     * cabinet the person is already signed in, so this stops being a
     * convenience and becomes a policy about what we put on screen.
     */
    showConnectionKeys: z.boolean().default(false),
  })
  .strict();

export type ConnectPageConfig = z.infer<typeof connectPageConfigSchema>;

// ── Cross-cutting rules zod cannot phrase ────────────────────────────────────

export interface ConnectPageIssue {
  readonly path: string;
  readonly message: string;
}

/**
 * The checks that are about the catalog as a whole rather than about one field.
 *
 * Each of these is a way to save something that parses perfectly and then shows
 * the customer nothing, or shows them the wrong thing. They are separate from
 * the zod schema because zod validates a value against a shape, and these are
 * questions about relationships between values.
 */
export function auditConnectPageConfig(config: ConnectPageConfig): ConnectPageIssue[] {
  const issues: ConnectPageIssue[] = [];
  const seenPlatforms = new Set<string>();

  for (const [pi, platform] of config.platforms.entries()) {
    const at = `platforms[${pi}]`;
    if (seenPlatforms.has(platform.id)) {
      issues.push({ path: at, message: `Platform "${platform.id}" is listed twice` });
    }
    seenPlatforms.add(platform.id);

    // Exactly one featured app: zero means the screen has to guess which app to
    // open on, and more than one means the guess is between them.
    const featured = platform.apps.filter((app) => app.featured);
    if (featured.length === 0) {
      issues.push({
        path: at,
        message: `Platform "${platform.id}" has no recommended app — the screen would not know which to open`,
      });
    } else if (featured.length > 1) {
      issues.push({
        path: at,
        message: `Platform "${platform.id}" recommends ${featured.length} apps; only one can be opened first`,
      });
    }

    const seenApps = new Set<string>();
    for (const [ai, app] of platform.apps.entries()) {
      const appAt = `${at}.apps[${ai}]`;
      // Duplicate ids inside one platform would make a remembered choice
      // ambiguous — which is exactly the case the id exists to settle.
      if (seenApps.has(app.id)) {
        issues.push({ path: appAt, message: `Two apps share the id "${app.id}"` });
      }
      seenApps.add(app.id);

      if (app.steps.length === 0) {
        issues.push({ path: appAt, message: `"${app.name}" has no steps — the card would be empty` });
      }

      // An app nobody can connect with is the failure this whole screen exists
      // to prevent, and it parses perfectly.
      const usable = app.steps.some((step) =>
        step.buttons.some((button) => button.kind === 'deepLink' || button.kind === 'copyLink'),
      );
      if (app.steps.length > 0 && !usable) {
        issues.push({
          path: appAt,
          message: `"${app.name}" has no way to hand over the subscription — add an "add to app" or "copy link" button`,
        });
      }

      for (const [si, step] of app.steps.entries()) {
        for (const [bi, button] of step.buttons.entries()) {
          if (button.kind !== 'external') continue;
          if (button.url.includes(SUBSCRIPTION_LINK_TOKEN)) {
            issues.push({
              path: `${appAt}.steps[${si}].buttons[${bi}]`,
              message: `A store link must not carry ${SUBSCRIPTION_LINK_TOKEN} — use an "add to app" button instead`,
            });
          }
        }
      }
    }

    for (const [ai, app] of platform.apps.entries()) {
      for (const key of [app.iconKey, ...app.steps.map((step) => step.iconKey)]) {
        if (key !== null && key !== undefined && !(key in config.icons)) {
          issues.push({
            path: `${at}.apps[${ai}]`,
            message: `Icon "${key}" is not in the icon library`,
          });
        }
      }
    }
    if (platform.iconKey !== null && platform.iconKey !== undefined && !(platform.iconKey in config.icons)) {
      issues.push({ path: at, message: `Icon "${platform.iconKey}" is not in the icon library` });
    }
  }

  return issues;
}

/**
 * Stamp every derived field, so nothing downstream has to work one out.
 *
 * Runs after parsing and before storing. `encode` is overwritten rather than
 * respected: it is a conclusion about the template, and a stored conclusion that
 * disagrees with its own premise is worse than no conclusion at all.
 */
export function normalizeConnectPageConfig(config: ConnectPageConfig): ConnectPageConfig {
  return {
    ...config,
    platforms: config.platforms.map((platform) => ({
      ...platform,
      apps: platform.apps.map((app) => ({
        ...app,
        steps: app.steps.map((step) => ({
          ...step,
          buttons: step.buttons.map((button) =>
            button.kind === 'deepLink' ? { ...button, encode: encodingFor(button.template) } : button,
          ),
        })),
      })),
    })),
  };
}
