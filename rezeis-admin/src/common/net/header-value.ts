/**
 * What an HTTP header value may hold: exactly what Node's HTTP layer accepts.
 *
 * RFC 9110 §5.5 `field-value`: visible ASCII (VCHAR, 0x21-0x7E), the space and
 * the horizontal tab between them, and `obs-text` (0x80-0xFF). Node checks the
 * same set before it sends (`checkInvalidHeaderChar` in `_http_common`) and
 * throws `ERR_INVALID_CHAR` for anything else — a line break, a control
 * character, or a letter above 0xFF such as any Cyrillic one. JavaScript
 * strings are UTF-16, so "above 0xFF" is simply a code unit above 0xFF.
 *
 * Checked where a header is saved, so an operator hears about it while looking
 * at the form, and again where it is sent, for one saved before this existed.
 */
export function isHeaderFieldValue(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const allowed = code === 0x09 || (code >= 0x20 && code <= 0x7e) || (code >= 0x80 && code <= 0xff);
    if (!allowed) return false;
  }
  return true;
}

/** The refusal, worded once for the save and the run. */
export const HEADER_FIELD_VALUE_RULE =
  'may hold only what an HTTP header can carry: printable ASCII and Latin-1 characters on one line — no line breaks, no Cyrillic';

/** The error codes Node's HTTP layer throws for a header value it refuses. */
export const INVALID_HEADER_ERROR_CODES: ReadonlySet<string> = new Set([
  'ERR_INVALID_CHAR',
  'ERR_HTTP_INVALID_HEADER_VALUE',
]);
