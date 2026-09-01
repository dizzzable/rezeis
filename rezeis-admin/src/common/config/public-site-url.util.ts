/**
 * The operator's public site, as an absolute origin — or `null` when there is
 * not one to speak of.
 *
 * ── Why this is shared ────────────────────────────────────────────────────
 *
 * Two callers need the same answer for the same reason: an EMAIL has no origin
 * to resolve a relative path against, so anything it links or embeds has to be
 * absolute. The email footer derived this inline, and the broadcast's emoji
 * pictures need exactly the same derivation — written twice they would drift,
 * and the symptom would be broken images in some emails and not others.
 *
 * `localhost` is treated as "no public site": a link a reader cannot open is
 * worse than no link, and an image src pointing at their own machine is worse
 * than the plain glyph.
 */
export function resolvePublicSiteUrl(): string | null {
  const domain = process.env.REZEIS_DOMAIN?.trim() ?? '';
  if (domain.length === 0 || domain === 'localhost') return null;
  if (/^https?:\/\//i.test(domain)) return domain.replace(/\/+$/, '');
  // A bare hostname with a dot is a real domain; anything else is a container
  // name on an internal network, which no reader can reach.
  if (!domain.includes('.')) return null;
  return `https://${domain}`.replace(/\/+$/, '');
}
