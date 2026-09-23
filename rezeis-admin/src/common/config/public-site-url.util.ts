/**
 * The PANEL's public origin (`REZEIS_DOMAIN`), as an absolute URL — or `null`
 * when there is not one to speak of.
 *
 * ── What it is for, and what it is not ────────────────────────────────────
 *
 * An EMAIL has no origin to resolve a relative path against, so anything it
 * embeds has to be absolute. The broadcast's emoji pictures are uploads, and
 * uploads live on the panel, so their `src` is built on this.
 *
 * It is NOT an address to show a customer. `REZEIS_DOMAIN` is the admin
 * panel's domain, and the email footer used to print it as the letter's
 * "website" — every customer who received a letter was handed the address of
 * the operator's admin panel. A link a customer reads or follows is the
 * cabinet's: {@link resolveCabinetSiteUrl}.
 *
 * `localhost` is treated as "no public site": an image src pointing at the
 * reader's own machine is worse than the plain glyph.
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

/**
 * The .env part of the CABINET's public address — where an operator's
 * customers actually go — or `null` when neither variable is set.
 *
 * `REIWA_WEB_BASE_URL`, then `MINIAPP_CUSTOM_URL`. The ad links and the
 * letters (footer link, guest reply button, logo) do not call this: they ask
 * `ReiwaAdvertisingLinkConfigService.resolveCabinetWebBaseUrl`, which takes
 * the address the cabinet publishes first and falls back to this
 * (`advertisingConfig.webBaseUrl` is this function). Both variables ship
 * commented out, so on a default install the published address is the one
 * that counts; a caller that uses this directly sees only the .env part.
 * Never `REZEIS_DOMAIN`, and no fallback to it: the panel's address would
 * advertise the admin panel.
 *
 * Only an absolute http(s) URL counts. The value lands in an `href`, so
 * anything else — a bare host, `javascript:` — reads as not configured.
 */
export function resolveCabinetSiteUrl(): string | null {
  return (
    normalizeHttpUrl(process.env.REIWA_WEB_BASE_URL) ??
    normalizeHttpUrl(process.env.MINIAPP_CUSTOM_URL)
  );
}

/**
 * A branding upload as the cabinet serves it itself — reiwa
 * `app.get('/uploads/branding/:file')`, with a disk cache that outlives a
 * panel outage — and with the same file-name rule (`isSafeBrandingFile`).
 */
const CABINET_SERVED_UPLOAD = /^\/uploads\/branding\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * A picture a letter embeds, as an address a mail client can fetch — or `null`
 * when there is none to give it.
 *
 * Uploads are stored root-relative (`/uploads/branding/<file>`): meaningful to
 * a page on the panel's or the cabinet's origin, and to an inbox nothing at all.
 * A branding upload is fetched from the CABINET when its address is known
 * (`cabinetBase`), so no letter carries the admin domain even in an image
 * source; only when the cabinet's address is unknown does the path join the
 * panel's public site ({@link resolvePublicSiteUrl}), where uploads live.
 * Without either, no picture beats a broken one. An absolute http(s) address
 * and a `data:` image stay as they are.
 */
export function resolveEmailImageUrl(
  value: string | null | undefined,
  cabinetBase: string | null = null,
): string | null {
  const trimmed = value?.trim() ?? '';
  if (trimmed.length === 0) return null;
  if (/^(https?:\/\/|data:image\/)/i.test(trimmed)) return trimmed;
  // Root-relative only: a bare `uploads/…` or a protocol-relative `//host/…`
  // is not something the panel stores, and guessing its base would be wrong.
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return null;
  if (cabinetBase !== null && CABINET_SERVED_UPLOAD.test(trimmed) && !trimmed.includes('..')) {
    return `${cabinetBase}${trimmed}`;
  }
  const site = resolvePublicSiteUrl();
  return site === null ? null : `${site}${trimmed}`;
}

function normalizeHttpUrl(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  if (trimmed.length === 0) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}
