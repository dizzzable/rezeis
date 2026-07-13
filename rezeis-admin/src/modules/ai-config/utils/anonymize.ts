/**
 * Best-effort defense-in-depth PII/secret scrub applied to a ticket transcript
 * BEFORE it is ever sent to the LLM for "learn from tickets". It is deliberately
 * over-eager (redacts emails, links, phones, card-like/long digit runs, IPs,
 * @handles, long tokens) but cannot catch everything (e.g. free-form full
 * names); the LLM prompt is a second layer, and every generated entry is a
 * DRAFT gated behind operator review before it can reach any user. Pure + unit-tested.
 */
export function anonymizeTranscript(text: string, maxChars = 4000): string {
  return (
    text
      // Emails (Unicode-aware local-part/domain).
      .replace(/[\p{L}\p{N}.+_-]+@[\p{L}\p{N}-]+\.[\p{L}\p{N}.-]+/gu, '[email]')
      // URLs.
      .replace(/https?:\/\/\S+/gu, '[ссылка]')
      // IPv4 (before the phone rule so dotted quads aren't partially eaten).
      .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '[ip]')
      // Phone / card-like runs: 11+ digits possibly with spaces/()/-.
      .replace(/\+?\d[\d ()-]{9,}\d/g, '[номер]')
      // @handles.
      .replace(/@[A-Za-z0-9_]{3,}/g, '[username]')
      // Long opaque tokens/keys.
      .replace(/\b[A-Za-z0-9_-]{24,}\b/g, '[токен]')
      // Bare long digit runs (Telegram ids, order numbers, etc.).
      .replace(/\b\d{7,}\b/g, '[номер]')
      .slice(0, maxChars)
  );
}
