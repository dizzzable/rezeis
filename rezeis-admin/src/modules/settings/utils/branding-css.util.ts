const MAX_BRANDING_GRADIENT_LENGTH = 512;

/**
 * Accepts only CSS gradient image values. Branding CSS is persisted and later
 * rendered by Reiwa, so it must never be able to start an external image
 * request or escape from a single property value.
 */
export function isSafeBrandingGradient(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const input = value.trim();
  if (
    input.length === 0 ||
    input.length > MAX_BRANDING_GRADIENT_LENGTH ||
    /(?:url|image-set|-webkit-image-set|cross-fade|element|paint)\s*\(/i.test(input) ||
    /[;{}@\\]/.test(input) ||
    /\/\*|\*\//.test(input) ||
    hasControlCharacter(input)
  ) {
    return false;
  }

  let index = 0;
  while (index < input.length) {
    while (index < input.length && /\s/.test(input[index] ?? '')) index += 1;
    const match = /^(?:(?:repeating-)?(?:linear|radial|conic)-gradient)\s*\(/i.exec(
      input.slice(index),
    );
    if (!match) return false;
    index += match[0].length;

    let depth = 1;
    while (index < input.length && depth > 0) {
      const character = input[index];
      if (character === '(') depth += 1;
      if (character === ')') depth -= 1;
      index += 1;
    }
    if (depth !== 0) return false;

    while (index < input.length && /\s/.test(input[index] ?? '')) index += 1;
    if (index === input.length) return true;
    if (input[index] !== ',') return false;
    index += 1;
  }
  return false;
}

export function isSafeBrandingGradientOrNone(value: unknown): value is string {
  return value === 'none' || isSafeBrandingGradient(value);
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}
