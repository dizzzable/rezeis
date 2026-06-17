/**
 * Emoji token text (pure, no React/DOM)
 * ─────────────────────────────────────
 * Splits bot copy into text + emoji-token segments and joins them back. The
 * token grammar is exactly the two delivery formats:
 *   - `:slug:`  custom-emoji pack shortcode
 *   - `{{KEY}}` semantic emoji slot placeholder
 *
 * Property: `segmentsToString(parseTokens(v)) === v` for any string — the
 * WYSIWYG editor serializes back to a byte-identical token string on save, so
 * the stored/on-wire format never changes.
 */

export type TokenKind = 'slug' | 'key'

export type TokenSegment =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'token'; readonly kind: TokenKind; readonly name: string; readonly raw: string }

/** Matches `:slug:` (lowercase/digits/underscore) or `{{KEY}}` (UPPER/digits/_). */
const TOKEN_RE = /:([a-z0-9_]+):|\{\{([A-Z0-9_]+)\}\}/g

/** Split a string into ordered text / token segments. */
export function parseTokens(value: string): TokenSegment[] {
  const segments: TokenSegment[] = []
  if (typeof value !== 'string' || value.length === 0) return segments

  let lastIndex = 0
  let match: RegExpExecArray | null
  TOKEN_RE.lastIndex = 0
  while ((match = TOKEN_RE.exec(value)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', text: value.slice(lastIndex, match.index) })
    }
    const slug = match[1]
    const key = match[2]
    if (slug !== undefined) {
      segments.push({ type: 'token', kind: 'slug', name: slug, raw: match[0] })
    } else if (key !== undefined) {
      segments.push({ type: 'token', kind: 'key', name: key, raw: match[0] })
    }
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < value.length) {
    segments.push({ type: 'text', text: value.slice(lastIndex) })
  }
  return segments
}

/** Inverse of `parseTokens` — concatenate text and the raw token strings. */
export function segmentsToString(segments: readonly TokenSegment[]): string {
  let out = ''
  for (const seg of segments) {
    out += seg.type === 'text' ? seg.text : seg.raw
  }
  return out
}

/** Build the canonical raw token for a kind + name. */
export function buildToken(kind: TokenKind, name: string): string {
  return kind === 'slug' ? `:${name}:` : `{{${name}}}`
}
