/**
 * connect-page.theme
 * ──────────────────
 * The appearance an operator picked for the cabinet's connect screen.
 *
 * ── Why this exists as its own thing ─────────────────────────────────────────
 *
 * The cabinet wears one concept everywhere, chosen on the branding page. This
 * screen is where a customer is asked to leave the cabinet and do something in
 * another app, and it is the one operators wanted to be able to dress
 * separately — the way the external subscription page it replaced was dressed.
 * So the panel may send a concept along with the catalog, and when it does not,
 * the screen keeps the cabinet's own.
 *
 * ── This is one half of a mirror ─────────────────────────────────────────────
 *
 * The other half is `web/src/features/connect/connect-theme.ts` in **reiwa**,
 * which re-checks everything below before writing any of it into a live `style`
 * attribute. That is not redundancy: the two ship as separate images on
 * separate release trains, so a cabinet always has to assume its panel is a
 * different version — and the cabinet is where the value becomes CSS.
 *
 * What this side owns is the ERROR MESSAGE. A value rejected here is rejected
 * while the operator is still looking at the screen that produced it. The same
 * value rejected in the cabinet is silent: the concept simply does not apply,
 * and the report that reaches support is "I picked a theme and nothing
 * happened". So this grammar must never be LOOSER than the cabinet's, and the
 * table in `connect-page-theme.spec.ts` is the same table the cabinet's own
 * spec runs — kept in step by hand, because the two live in different
 * repositories and no compiler can see across that gap.
 */
import { z } from 'zod';

/**
 * Custom properties the connect screen reads.
 *
 * These are the CABINET'S tokens, not a second vocabulary invented here. That
 * is what makes "no theme" already correct: the screen is written against them,
 * and a concept is only a different set of answers. A name outside this list
 * would be a property the screen never reads — an operator would see their
 * choice do nothing and have no way to tell that from the feature being broken.
 */
export const CONNECT_THEME_COLOR_TOKENS = [
  'brand-primary',
  'brand-primary-fg',
  'brand-foreground',
  'brand-muted-foreground',
  'color-surface',
  'color-surface-high',
  'color-border-soft',
  'color-border-strong',
] as const;

export const CONNECT_THEME_LENGTH_TOKENS = [
  'radius-card',
  'radius-item',
  'radius-pill',
  'glass-blur',
] as const;

/** Mirrors `COLOR` in the cabinet's connect-theme. */
const COLOR = /^(?:#[\da-f]{3,8}|rgba?\([\d\s.,%/]+\)|hsla?\([\d\s.,%/deg]+\)|transparent)$/i;

/** Mirrors `LENGTH`. Bare `0` is not a length here: every token is a dimension. */
const LENGTH = /^\d+(?:\.\d+)?(?:px|rem)$/;

const BACKGROUND_MAX_LENGTH = 4_000;
const BACKGROUND_ALLOWED_CHARS = /^[\w\s#%.,()+-]*$/;
const BACKGROUND_FUNCTION = /([a-z][\w-]*)\s*\(/gi;
const BACKGROUND_FUNCTIONS = new Set([
  'linear-gradient',
  'radial-gradient',
  'conic-gradient',
  'repeating-linear-gradient',
  'repeating-radial-gradient',
  'repeating-conic-gradient',
  'rgb',
  'rgba',
  'hsl',
  'hsla',
]);

/**
 * True when the string is a background the cabinet will actually paint.
 *
 * Three independent checks, because each is blind to what the others catch: a
 * character whitelist cannot tell `linear-gradient` from `paint`, a function
 * whitelist cannot see a comment or an escape smuggling one in, and neither
 * notices an unbalanced value — which the browser will repair, but not
 * necessarily into the thing that was approved.
 *
 * The case that needs all three is a relative `url()`: no colon, no slash,
 * nothing the character check objects to, sitting beside a real gradient so the
 * "must be a gradient" rule is satisfied too. It still reaches the network, and
 * it still tells whoever serves it which customer opened this screen.
 */
export function isSafeConnectBackground(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > BACKGROUND_MAX_LENGTH) return false;
  if (!BACKGROUND_ALLOWED_CHARS.test(trimmed)) return false;
  let depth = 0;
  for (const character of trimmed) {
    if (character === '(') depth += 1;
    else if (character === ')') {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  if (depth !== 0) return false;
  for (const match of trimmed.matchAll(BACKGROUND_FUNCTION)) {
    if (!BACKGROUND_FUNCTIONS.has(match[1].toLowerCase())) return false;
  }
  return /gradient\s*\(/i.test(trimmed);
}

const colorValue = z
  .string()
  .refine((value) => COLOR.test(value.trim()), 'Not a colour the cabinet can paint');

const lengthValue = z
  .string()
  .refine((value) => LENGTH.test(value.trim()), 'Lengths are written in px or rem');

const tokensShape = {
  ...Object.fromEntries(
    CONNECT_THEME_COLOR_TOKENS.map((token) => [token, colorValue.optional()]),
  ),
  ...Object.fromEntries(
    CONNECT_THEME_LENGTH_TOKENS.map((token) => [token, lengthValue.optional()]),
  ),
} as Record<string, z.ZodOptional<z.ZodString>>;

export const connectPageThemeSchema = z
  .object({
    /**
     * Which concept this came from. Carried so the editor can show the gallery
     * with the operator's choice selected, and for nothing else — the cabinet
     * never resolves it, because the cabinet does not have the concept book.
     */
    presetId: z.string().max(120).nullable().default(null),
    tokens: z.object(tokensShape).strict(),
    backgroundColor: colorValue.nullable().default(null),
    backgroundImage: z
      .string()
      .refine(isSafeConnectBackground, 'Only gradients; no url(), var() or unknown functions')
      .nullable()
      .default(null),
    /**
     * The 4px rail down the left edge. Every concept in the book has one, and
     * it is the cheapest half of their identity, so it travels as its own value
     * rather than as one more gradient layer nobody can see the seam of.
     */
    rail: colorValue.nullable().default(null),
  })
  .strict();

export type ConnectPageTheme = z.infer<typeof connectPageThemeSchema>;

/**
 * A theme with nothing left in it is not a theme.
 *
 * It matters because the cabinet treats "present" and "absent" differently: a
 * theme reported as present with no palette would paint a concept background
 * under the cabinet's own text colours, which is the one combination nobody
 * designed. The editor's "как в кабинете" choice sends `null`, and this is the
 * check that turns a hand-emptied one into the same thing.
 */
export function isEmptyConnectTheme(theme: ConnectPageTheme): boolean {
  return (
    Object.keys(theme.tokens).length === 0 &&
    theme.backgroundColor === null &&
    theme.backgroundImage === null &&
    theme.rail === null
  );
}
