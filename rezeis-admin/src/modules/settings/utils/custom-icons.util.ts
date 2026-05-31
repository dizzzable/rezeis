/**
 * Reads/normalizes the `Settings.customIcons` JSON column into a typed list of
 * `CustomIconInterface`. Invalid entries are dropped; the list is capped at
 * `CUSTOM_ICONS_MAX`. Kept defensive so a hand-edited or partially-migrated
 * row never crashes a read.
 */

import { CUSTOM_ICONS_MAX, CustomIconInterface } from '../interfaces/custom-icon.interface';

const HEX_PATTERN = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export function readCustomIcons(value: unknown): CustomIconInterface[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: CustomIconInterface[] = [];
  for (const entry of value.slice(0, CUSTOM_ICONS_MAX)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const id = record['id'];
    const url = record['url'];
    if (typeof id !== 'string' || id.length === 0) continue;
    if (typeof url !== 'string' || url.length === 0) continue;
    const name = record['name'];
    const color = record['color'];
    out.push({
      id,
      url,
      name: typeof name === 'string' && name.length > 0 ? name.slice(0, 64) : id,
      color: typeof color === 'string' && HEX_PATTERN.test(color) ? color : null,
    });
  }
  return out;
}
