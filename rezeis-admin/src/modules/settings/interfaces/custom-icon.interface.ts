/**
 * A single operator-uploaded custom icon, reusable across the panel and the
 * reiwa cabinet.
 *
 * The `url` points at an uploaded asset served under `/uploads/icons/<file>`
 * (relative to the admin host). `color` is an optional hex tint applied via a
 * CSS mask so a single monochrome glyph can be recoloured per use site; when
 * `null`, the icon renders in its own colours (e.g. a multicolour PNG/SVG).
 */
export interface CustomIconInterface {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly color: string | null;
}

/** Maximum number of custom icons an operator can store. */
export const CUSTOM_ICONS_MAX = 200;
