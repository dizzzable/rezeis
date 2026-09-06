/**
 * Reads the flag a host's name already carries.
 *
 * WHY THE NAME AND NOT A FIELD. A Remnawave host has no country. The shape is
 * `{uuid, remark, address, port, tags, configProfileInboundUuid, nodes, …}` —
 * see `remnawave-host.interface`. `countryCode` exists on a NODE, and a host
 * points at nodes only through UUIDs, so deriving a host's country that way
 * means joining and then deciding what to do when the nodes disagree.
 *
 * The operator has already decided. They type the flag into the host's name,
 * and that name is what the customer sees in their VPN client today — so
 * whatever they wrote is, by definition, the right answer. A load balancer
 * named `Smart-Авто 🇪🇺` is European because its owner said so, and two hosts
 * both flagged 🇩🇪 are both German even though nothing else in the panel
 * distinguishes them.
 *
 * WHY IT STILL YIELDS A COUNTRY CODE. A flag emoji is not a picture; it is two
 * Regional Indicator letters (🇩🇪 is D followed by E). So the flag the operator
 * typed decodes straight back into the ISO code the globe needs to place a
 * marker — no lookup table, no guessing. `countryCodeToFlag` in
 * `common/services/system-events.service` builds the same pair in the other
 * direction for Telegram; this is its inverse, kept separate because that one
 * also HTML-escapes for a message body.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. `🇪🇺` decodes to `EU`, which is a valid
 * Regional Indicator pair and not a country: there is no single point on Earth
 * to put it. This util returns `EU` honestly and lets the caller find no
 * coordinate for it, rather than inventing a centroid. A balancer is not a
 * place — it is a choice between places — and drawing it in Frankfurt would
 * state something untrue about where the customer's traffic goes.
 */

/** `🇦` — the first Regional Indicator Symbol. */
const REGIONAL_INDICATOR_A = 0x1f1e6;
/** `🇿` — the last. */
const REGIONAL_INDICATOR_Z = 0x1f1ff;

/**
 * Two adjacent Regional Indicators, anywhere in the string.
 *
 * A name may carry other emoji (`⚡`, `🔥`) and may put the flag at either end;
 * only this pair is a flag. Matching a pair rather than a single indicator
 * matters — a lone indicator renders as a bare letter tile and means nothing.
 */
const FLAG_PATTERN = /[\u{1F1E6}-\u{1F1FF}]{2}/u;

/** The flag emoji in a host name, or `null` when it carries none. */
export function extractFlag(remark: string): string | null {
  const match = FLAG_PATTERN.exec(remark);
  return match ? match[0] : null;
}

/**
 * The ISO 3166-1 alpha-2 code a flag emoji spells out.
 *
 * Returns `null` for anything that is not exactly one indicator pair, which
 * includes the empty string and a name with no flag in it.
 */
export function countryCodeFromFlag(flag: string | null): string | null {
  if (!flag) return null;
  const points = [...flag].map((character) => character.codePointAt(0) ?? 0);
  if (points.length !== 2) return null;
  if (
    points.some(
      (point) => point < REGIONAL_INDICATOR_A || point > REGIONAL_INDICATOR_Z,
    )
  ) {
    return null;
  }
  const letters = points.map((point) =>
    String.fromCharCode('A'.charCodeAt(0) + point - REGIONAL_INDICATOR_A),
  );
  return letters.join('');
}

/**
 * Turns an ISO code back into a flag, for hosts whose name carries none.
 *
 * The fallback path: a host with no flag in its name borrows the country of a
 * node it runs on, and that country has to become an emoji before the customer
 * sees it. Nodes are never themselves shown — this takes the one field from
 * them that is not identifying.
 */
export function flagFromCountryCode(code: string | null): string | null {
  if (!code) return null;
  const normalized = code.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized)) return null;
  return String.fromCodePoint(
    ...[...normalized].map(
      (letter) =>
        REGIONAL_INDICATOR_A + letter.charCodeAt(0) - 'A'.charCodeAt(0),
    ),
  );
}

/**
 * The country a host should be shown as, given its name and its nodes'.
 *
 * Order is not arbitrary. The name wins because the operator wrote it on
 * purpose and the customer is already reading it; the node's code is a
 * fallback for hosts nobody has labelled. Where the nodes disagree, the first
 * one that has a code is taken — with nothing to prefer between them, a stable
 * answer beats a clever one.
 */
export function resolveHostCountry(
  remark: string,
  nodeCountryCodes: readonly string[],
): { readonly flag: string | null; readonly countryCode: string | null } {
  const flagFromName = extractFlag(remark);
  if (flagFromName) {
    return { flag: flagFromName, countryCode: countryCodeFromFlag(flagFromName) };
  }
  for (const candidate of nodeCountryCodes) {
    const flag = flagFromCountryCode(candidate);
    if (flag) return { flag, countryCode: candidate.trim().toUpperCase() };
  }
  return { flag: null, countryCode: null };
}
