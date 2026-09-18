import { networkInterfaces } from 'node:os';

import { systemLookupAll, type LookupAll } from '../../../common/net/outbound-url';

/**
 * What the automation actions ask of the network, gathered behind one token so
 * a spec can answer it without a resolver or a network card.
 *
 * Not a security dependency in itself: every decision about what may be dialled
 * or blocked is made in code that reads these answers. Absent from a container
 * (a spec that builds the registry by hand), the system versions are used.
 */
export const AUTOMATION_NETWORK_PROBES = Symbol('AUTOMATION_NETWORK_PROBES');

export interface AutomationNetworkProbes {
  /** Every address a host name resolves to. */
  readonly lookupAll: LookupAll;
  /** Every address of the machine the panel runs on. */
  readonly localAddresses: () => readonly string[];
  /**
   * The host names of the panel itself and of the services that call it: the
   * panel's own domain, the cabinet, the subscription page. Their addresses are
   * where the panel's own traffic comes from when the stack is split across
   * hosts, so `block_ip` must not list them.
   */
  readonly serviceHosts: () => readonly string[];
}

export const SYSTEM_NETWORK_PROBES: AutomationNetworkProbes = {
  lookupAll: systemLookupAll,
  localAddresses: () =>
    Object.values(networkInterfaces()).flatMap((entries) =>
      (entries ?? []).map((entry) => entry.address),
    ),
  serviceHosts: () =>
    [
      process.env.REZEIS_DOMAIN,
      // The same fallback every consumer of this variable dials.
      (process.env.REIWA_URL ?? '').trim() || 'http://reiwa:5000',
      process.env.REZEIS_SUBPAGE_URL,
    ]
      .map(hostOf)
      .filter((host): host is string => host !== null),
};

/** The host in a URL, or in a bare `host[:port]` as `REZEIS_DOMAIN` is written. */
export function hostOf(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim();
  if (trimmed.length === 0) return null;
  try {
    const url = new URL(trimmed.includes('://') ? trimmed : `http://${trimmed}`);
    const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
    return host.length === 0 ? null : host;
  } catch {
    return null;
  }
}
