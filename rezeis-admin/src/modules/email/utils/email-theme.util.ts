import {
  BrandingSettingsInterface,
} from '../../settings/interfaces/branding-settings.interface';
import { EmailThemeColorsInterface } from '../interfaces/email.interface';

/**
 * The operator's cabinet theme, reduced to the handful of colours an email can
 * actually use.
 *
 * ── Why an email has a theme at all ───────────────────────────────────────
 *
 * Every outgoing email already carried the brand's NAME, LOGO and ACCENT — and
 * then framed them in a fixed light-grey card. So an operator whose cabinet is
 * dark, or whose surfaces are anything but #ffffff, sent mail that looked like
 * it came from a different product than the one the reader had just been using.
 *
 * ── Why only five values ──────────────────────────────────────────────────
 *
 * An inbox cannot do card effects, background shaders, corner-radius scales or
 * webfonts. Carrying the whole `BrandingThemeVariant` would be a template that
 * claims to mirror the cabinet and silently drops most of it; these five are
 * what actually survives the trip.
 */

/** Relative luminance of a `#rgb` / `#rrggbb` colour, or `null` if unparseable. */
export function luminanceOf(color: string): number | null {
  const hex = color.trim().replace(/^#/, '');
  const full =
    hex.length === 3
      ? hex
          .split('')
          .map((c) => c + c)
          .join('')
      : hex;
  if (!/^[0-9a-f]{6}$/i.test(full)) return null;
  const channel = (offset: number): number => {
    const value = parseInt(full.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

/**
 * Readable ink for a given surface.
 *
 * MEASURED, not assumed. Hard-coding a dark grey is exactly what made the old
 * layout unusable the moment a surface stopped being white — and an operator
 * who picks a dark theme is precisely the one whose mail would have become
 * black text on a near-black card.
 */
function inkFor(surface: string): { text: string; muted: string } {
  const luminance = luminanceOf(surface);
  // Unparseable (a gradient, a css variable, an rgb() string) → assume the
  // light card the layout has always used, which is what such a deployment
  // already renders.
  const isDark = luminance !== null && luminance < 0.4;
  return isDark
    ? { text: '#f4f4f5', muted: '#a1a1aa' }
    : { text: '#1f2937', muted: '#6b7280' };
}

export function emailThemeFromBranding(
  branding: BrandingSettingsInterface,
): EmailThemeColorsInterface {
  // The variant the operator set as their DEFAULT mode is the one a reader
  // recognises. `themeVariants` is null on a custom or legacy theme, and then
  // the root-level colours ARE the theme.
  const variant =
    branding.themeVariants === null
      ? null
      : branding.themeDefaultMode === 'light'
        ? branding.themeVariants.light
        : branding.themeVariants.dark;

  const background = variant?.bgPrimary ?? branding.bgPrimary;
  const surface = variant?.bgSecondary ?? branding.bgSecondary;
  const primaryFg = variant?.primaryFg ?? branding.primaryFg;
  const ink = inkFor(surface);

  return {
    background,
    surface,
    text: ink.text,
    mutedText: ink.muted,
    onPrimary: primaryFg,
  };
}
