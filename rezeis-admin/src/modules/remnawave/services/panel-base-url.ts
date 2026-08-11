/**
 * How `REMNAWAVE_HOST` + `REMNAWAVE_PORT` become the upstream base URL.
 *
 * The rule used to be one line — "a dot means a public domain" — and that is
 * wrong for the whole family of addresses that contain dots and are not domains:
 * `10.0.0.5`, `127.0.0.1`, `api.localhost`. Those resolved to `https://<host>`,
 * i.e. port 443 with TLS, and the configured port was discarded without a word.
 * A plain-HTTP panel on 8080 was then simply unreachable, and the only trace was
 * `connect ECONNREFUSED 10.0.0.5:443` in the logs — which names a port the
 * operator never wrote down anywhere.
 *
 * The classification below is deliberately the same one
 * `resolveReiwaPublicUrl` already applies on the reiwa side: a literal address
 * is not a public DNS name and cannot carry an ordinary certificate.
 *
 * WHAT CHANGES FOR AN EXISTING DEPLOYMENT: only a PRIVATE address literal with
 * a port — `10.0.0.5:8080`, `127.0.0.1:8080` — which now goes to plain HTTP on
 * that port instead of `https://<ip>`. Domains are untouched, docker service
 * names are untouched, and a routable IP is still HTTPS: a port is honoured
 * only where plain HTTP cannot leave the private network, because the
 * alternative would newly put `REMNAWAVE_TOKEN` on the wire in clear.
 *
 * A private literal with NO port also keeps resolving to HTTPS, exactly as
 * before: there is no port to build a plain-HTTP URL from, and going dark on a
 * deployment that works today would be a worse answer than the one it has.
 */

/** Four dot-separated decimal octets, each 0-255. Nothing else. */
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/**
 * `localhost` and anything under it. `*.localhost` is reserved by RFC 6761 and
 * resolves to the loopback, so it is a local target however many dots it has.
 */
const LOCALHOST = /^localhost$|\.localhost$/i;

/**
 * Address ranges that cannot leave the machine or the private network:
 * loopback, RFC 1918, link-local, IPv6 loopback / unique-local / link-local.
 *
 * The split matters because honouring the port means speaking plain HTTP, and
 * plain HTTP inside a compose network or a LAN is ordinary while plain HTTP to
 * a routable address puts the panel token on the public internet in clear.
 */
const PRIVATE_IPV4 =
  /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/;
const PRIVATE_IPV6 = /^\[?(::1|f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:)/i;

/** What kind of thing the operator put in the host field. */
export type PanelHostKind =
  /** A docker/compose service name: no dots, resolvable only inside the network. */
  | 'service'
  /**
   * An address that cannot leave the machine or the private network —
   * loopback, RFC 1918, link-local, `localhost`, IPv6 loopback / ULA. Plain
   * HTTP here never crosses anything untrusted.
   */
  | 'privateLiteral'
  /**
   * Anything reachable from the public internet: a real DNS name, or a routable
   * IP literal. Both terminate TLS at 443 behind somebody's proxy, and neither
   * may be downgraded to plain HTTP — see {@link resolvePanelBaseUrl}.
   */
  | 'public';

/**
 * Splits a host that carries its own port — `panel.example.com:8443`,
 * `10.0.0.5:8080`. `REMNAWAVE_HOST` is validated as a bare non-empty string, so
 * operators do write these and the old resolver handled them by accident: it
 * only tested for a dot, and `https://panel.example.com:8443` is a valid URL.
 *
 * Exactly one colon with digits after it. A bare IPv6 literal has at least two,
 * and a bracketed one starts with `[`, so neither is mistaken for this.
 */
function splitEmbeddedPort(host: string): { readonly host: string; readonly port: number } | null {
  if (host.startsWith('[')) return null;
  const parts = host.split(':');
  if (parts.length !== 2) return null;
  const [name, port] = parts;
  if (name.length === 0 || !/^\d+$/.test(port)) return null;
  const parsed = Number.parseInt(port, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? { host: name, port: parsed } : null;
}

export function classifyPanelHost(host: string): PanelHostKind {
  // An embedded port is classified by the NAME in front of it. Without this,
  // `panel.example.com:8443` took the IPv6 branch below, got bracketed, and
  // produced `https://[panel.example.com:8443]` — not a URL at all, so every
  // request from such a deployment failed at the transport.
  const embedded = splitEmbeddedPort(host);
  if (embedded !== null) return classifyPanelHost(embedded.host);
  // IPv6 arrives either bare (`::1`) or already bracketed (`[::1]`). Two or more
  // colons cannot appear in a DNS name or a docker service name.
  if (host.includes(':')) return PRIVATE_IPV6.test(host) ? 'privateLiteral' : 'public';
  if (LOCALHOST.test(host)) return 'privateLiteral';
  if (IPV4.test(host)) return PRIVATE_IPV4.test(host) ? 'privateLiteral' : 'public';
  return host.includes('.') ? 'public' : 'service';
}

/**
 * An IPv6 literal has to be bracketed inside a URL, or the colons are read as
 * the port separator. Bracketing an already-bracketed value would produce
 * `[[::1]]`, so this is idempotent.
 */
function forUrl(host: string): string {
  if (!host.includes(':')) return host;
  return host.startsWith('[') ? host : `[${host}]`;
}

export interface PanelBaseUrlResolution {
  /** `null` means "not configured" — the caller must not fall back to a guess. */
  readonly url: string | null;
  /**
   * A combination that resolved to something the operator probably did not
   * intend. Logged ONCE per service instance, never per request: `getBaseUrl`
   * runs on every call, and a warning on a hot path is a warning nobody reads.
   */
  readonly warning: string | null;
}

/**
 * Resolves the base URL, and says when the answer deserves an explanation.
 *
 * Pure: no logger, no config object, no I/O — so the table of cases is testable
 * as a table, and the one place that logs can stay a single latch.
 */
export function resolvePanelBaseUrl(
  host: string | null,
  port: number | null,
): PanelBaseUrlResolution {
  if (host === null || host.trim().length === 0) {
    return { url: null, warning: null };
  }
  const trimmed = host.trim();
  const kind = classifyPanelHost(trimmed);
  const embedded = splitEmbeddedPort(trimmed);

  if (embedded !== null) {
    // The host already says where to knock. Use it verbatim — no bracketing, no
    // appended port — and pick the scheme from what the NAME is: a private
    // target speaks plain HTTP, anything routable keeps TLS.
    const scheme = kind === 'public' ? 'https' : 'http';
    return {
      url: `${scheme}://${trimmed}`,
      warning:
        port === null || port === embedded.port
          ? null
          : `Remnawave: REMNAWAVE_HOST "${trimmed}" already carries port ${embedded.port}, so ` +
            `REMNAWAVE_PORT ${port} is ignored and the panel is addressed at ${scheme}://${trimmed}.`,
    };
  }

  if (kind === 'public') {
    // TLS is not negotiable for anything routable. Honouring the port here
    // would mean plain HTTP across the internet carrying REMNAWAVE_TOKEN — and
    // it would be a NEW hole, because such a host resolved to `https://` before
    // and merely failed to connect. "Does not connect" is a better failure than
    // "connects in the clear", so the port is refused and said out loud.
    return {
      url: `https://${forUrl(trimmed)}`,
      warning:
        port === null
          ? null
          : `Remnawave: REMNAWAVE_HOST "${trimmed}" is reachable from the public internet, so ` +
            `REMNAWAVE_PORT ${port} is ignored and the panel is addressed at ` +
            `https://${forUrl(trimmed)} (port 443). Plain HTTP is only used for a private ` +
            'address; put the panel behind a domain or a reverse proxy on 443.',
    };
  }

  if (port !== null) {
    // Private target: the operator named a port, and plain HTTP here never
    // leaves the host or the private network.
    return { url: `http://${forUrl(trimmed)}:${port}`, warning: null };
  }

  // No port. A service name cannot be reached without one, which is what
  // `isConfigured()` has always reported for this case.
  if (kind === 'service') {
    return {
      url: null,
      warning:
        `Remnawave: REMNAWAVE_HOST "${trimmed}" looks like a service name but REMNAWAVE_PORT ` +
        'is not set, so the integration is treated as unconfigured.',
    };
  }

  // A literal address with no port. Kept on HTTPS because that is what this
  // resolved to before, and a deployment terminating TLS at an IP would
  // otherwise go dark on an upgrade.
  return {
    url: `https://${forUrl(trimmed)}`,
    warning:
      `Remnawave: REMNAWAVE_HOST "${trimmed}" is an address literal and REMNAWAVE_PORT is not ` +
      `set, so the panel is addressed at https://${forUrl(trimmed)} (port 443). Set the port ` +
      'if the panel is served over plain HTTP.',
  };
}
