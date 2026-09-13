/**
 * The rules the backend holds a QR style to — the colour, and the logo's
 * address and size — shared by the write guard (`QrStyleDto` in
 * `dto/update-branding-settings.dto.ts`) and the reader (`readQrStyle` in
 * `branding-settings.util.ts`).
 *
 * ONE FUNCTION FOR BOTH STAGES, for the reason `isSafeBrandingGradient` is one
 * function for both. A colour the DTO accepts and the reader then drops is
 * answered `200 OK` and reverts on the next read, with nothing anywhere to
 * point at; a colour the reader keeps and the DTO refuses is one a restored
 * backup can put in front of subscribers while no operator could ever save it.
 * `test/branding-qr-style.spec.ts` sweeps colours through both stages, and the
 * panel's `web/src/features/branding/qr-style-contract.test.ts` sweeps the
 * same colours through the cabinet's own `isUsableDark` — the rule the cabinet
 * applies when it draws.
 *
 * WHY 7:1 AND NOT WCAG'S 4.5:1. 4.5:1 is a rule for text. The cabinet measured
 * it (`reiwa/web/test/qr-style-decodes.test.ts`, through a camera model:
 * pixels that integrate light, a little defocus, a sampling grid that does not
 * line up with the modules): the classic 4.5:1 grey `#767676`, with rounded
 * modules on the long subscription link, did not decode, while black and a
 * brand navy passed the same case. A grey module blurred together with its
 * white neighbours drifts toward the binariser's threshold, and a dense link
 * has no error correction to spare for it. 7:1 — relative luminance
 * ≤ 1.05 / 7 − 0.05 = 0.1 — is the floor that test holds the palest allowed
 * grey to: `#595959` (7.00:1) passes, `#5a5a5a` (6.90:1) does not.
 *
 * REFUSED HERE, REPLACED THERE. The panel refuses a colour that is too light,
 * because the panel has an operator to tell. The cabinet's reader quietly
 * draws black instead, because its snapshot guard would throw the whole brand
 * away on the first refusal. Each is the right answer for where it sits.
 */

/** `#rgb` or `#rrggbb`. No alpha: a translucent module is whatever it lands on. */
export const QR_DARK_HEX_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** The floor, as an operator reads it: at least this many to one against white. */
export const QR_MIN_CONTRAST = 7;

/**
 * 7:1 against white ⇔ relative luminance of the dark colour ≤ this (0.1).
 * The same arithmetic as the cabinet's `MAX_DARK_LUMINANCE`, so the two sides
 * round the boundary alike.
 */
export const QR_MAX_DARK_LUMINANCE = 1.05 / QR_MIN_CONTRAST - 0.05;

/**
 * WCAG relative luminance of `#rgb` / `#rrggbb` — the arithmetic of the
 * cabinet's `relativeLuminance` in `qr-options.ts`, line for line. Callers
 * check the shape first.
 */
export function qrRelativeLuminance(hex: string): number {
  const value = hex.replace('#', '');
  const full =
    value.length === 3
      ? value
          .split('')
          .map((c) => c + c)
          .join('')
      : value.slice(0, 6);
  const channel = (pair: string): number => {
    const srgb = Number.parseInt(pair, 16) / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * channel(full.slice(0, 2)) +
    0.7152 * channel(full.slice(2, 4)) +
    0.0722 * channel(full.slice(4, 6))
  );
}

/** Contrast of a well-formed colour against the white field — 7.004 for `#595959`. */
export function qrContrastAgainstWhite(hex: string): number {
  return 1.05 / (qrRelativeLuminance(hex) + 0.05);
}

/**
 * A dark colour a scanner can still separate from the white field:
 * well-formed and 7:1 or better. Does NOT trim — both callers trim first,
 * exactly once, so the two stages judge the same string.
 */
export function isUsableQrDark(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    QR_DARK_HEX_PATTERN.test(value) &&
    qrRelativeLuminance(value) <= QR_MAX_DARK_LUMINANCE
  );
}

/**
 * THE LOGO'S ADDRESS — the cabinet's `isQrLogoSrc` (`reiwa/web/src/lib/qr-style.ts`),
 * pattern, length cap and `..` refusal alike, shared here by the write guard
 * (`QrLogoDto`) and the reader (`readQrStyle`) for the same reason the colour
 * rule above is one function for both.
 *
 * Only `/uploads/branding/<file>` with an image extension the cabinet's relay
 * serves an image type for. The cabinet inlines the logo into the code as a
 * `data:` URI, loading it same-origin through that relay, and refuses any
 * other address: an external URL would be a logo it never draws, and a `data:`
 * URI in the settings would ride inside every branding payload. The file name
 * is the relay's own rule (`isSafeBrandingFile`), and this panel's uploads
 * (`BrandingAssetUploadService`) always produce one: 32 hex digits and the
 * sniffed type's extension.
 */
export const QR_LOGO_SRC_PATTERN = /^\/uploads\/branding\/[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpe?g|webp|svg)$/i;

/** The cabinet's `LOGO_SRC_MAX_LENGTH`. */
export const QR_LOGO_SRC_MAX_LENGTH = 256;

export function isQrLogoSrc(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= QR_LOGO_SRC_MAX_LENGTH &&
    QR_LOGO_SRC_PATTERN.test(value) &&
    !value.includes('..')
  );
}

/**
 * The largest SVG a QR logo may be — the cabinet's `LOGO_SVG_MAX_BYTES`.
 *
 * The cabinet inlines an SVG logo whole, base64, into every code it draws,
 * and loads NO logo at all from a larger file, silently: the code simply
 * appears without it. So the ceiling is enforced where the operator can still
 * be told — at the upload (`BrandingAssetUploadService`, purpose `qr-logo`) —
 * rather than left for subscribers to discover. Raster logos keep the branding
 * slots' own ceiling: the cabinet redraws them to 256 px first.
 */
export const QR_LOGO_SVG_MAX_BYTES = 96 * 1024;
