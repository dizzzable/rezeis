/**
 * What a subscriber is allowed to know about the servers they can reach.
 *
 * This shape is a boundary, not a convenience. Everything the panel holds about
 * a host and its nodes — `address`, `port`, `ips[]`, the node's `name`, its
 * `activeConfigProfileUuid`, its traffic counters — is infrastructure, and a
 * customer-facing response is exactly where it must not appear. The fields
 * below are the ones a person can act on: which place, is it up, how long has
 * it been up, and which one to pick right now.
 *
 * `id` is the host UUID. It is opaque — it names nothing a stranger could
 * reach — and the cabinet needs a stable key to animate a list by.
 */
export interface SubscriberServerInterface {
  readonly id: string;
  /**
   * The host's name exactly as the operator wrote it, flag and all.
   *
   * Not reformatted and not translated: this is the same string the customer
   * already reads inside their VPN client, and the two disagreeing would be
   * worse than either wording alone.
   */
  readonly name: string;
  /** The flag emoji in `name`, or one built from a node's country. */
  readonly flag: string | null;
  /**
   * ISO 3166-1 alpha-2, decoded from that flag.
   *
   * The cabinet turns this into a point on the globe. It may be a code with no
   * single point — `EU` on a load balancer is the ordinary case — and the
   * cabinet is expected to list such a server without placing a marker rather
   * than to invent a location for it.
   */
  readonly countryCode: string | null;
  /**
   * Derived from the host's NODES, not from the host row.
   *
   * A host is a piece of configuration; it is never itself up or down. What can
   * be down is the node behind it, so this reports the nodes: `online` if any
   * is connected, `connecting` while any is coming up, `offline` when they are
   * all down, and `unknown` for a host with no node linked to it at all —
   * which is a real state in Remnawave and must not be reported as failure.
   */
  readonly status: 'online' | 'connecting' | 'offline' | 'unknown';
  /**
   * Seconds the xray process behind this host has been running, or `null`.
   *
   * This is uptime of a process, NOT a measure of availability: a node
   * restarted five minutes ago is fully working and reads five minutes here.
   * The cabinet words it accordingly — "в работе N", never "доступность N%".
   */
  readonly uptimeSeconds: number | null;
  /**
   * People currently connected through this host's nodes.
   *
   * The only load signal that exists. There is no per-customer latency
   * anywhere in this system, so "best right now" can only mean "least busy" —
   * see `recommendedServerId`.
   */
  readonly usersOnline: number | null;
}

export interface SubscriberServersInterface {
  readonly servers: readonly SubscriberServerInterface[];
  /**
   * The `id` of the least busy online server, or `null`.
   *
   * Deliberately computed here rather than in the cabinet: the rule is a
   * product decision and the two images ship separately, so leaving it to the
   * reader would let a cabinet and a panel of different ages recommend
   * different servers from the same data.
   *
   * It is emphatically not "fastest" — nothing here measures the route from a
   * given customer to a given host. It is "fewest people on it", which is the
   * honest claim the data supports.
   */
  readonly recommendedServerId: string | null;
}
