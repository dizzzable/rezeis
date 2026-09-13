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
   * `separator` for a section header, `server` for everything else.
   *
   * Remnawave has no header concept, so operators fake one with an ordinary
   * host whose remark is a heading — "⬇️ Все | Локации ⬇️" — and VPN apps draw
   * it as a row reading "n/a". Nothing about such a host tells it apart from a
   * real one, so the operator says which hosts they are by tagging them
   * `REZEIS:SEPARATOR` in Remnawave (see `SEPARATOR_TAG` in
   * `subscriber-servers.service.ts`).
   *
   * A separator row is the operator's words and nothing else: `name` is the
   * remark, and `description`, `flag`, `countryCode`, `uptimeSeconds` and
   * `usersOnline` are all `null`, with `status` `unknown`. It is never matched
   * to a node and never recommended, and a header with no server under it is
   * not sent at all.
   *
   * Those empty fields are also what makes the field safe to add. A cabinet
   * older than it drops `kind` at its own boundary, and what is left is the
   * grey "no data" row that host has always been drawn as, minus its badge.
   */
  readonly kind: 'server' | 'separator';
  /**
   * The host's name exactly as the operator wrote it, flag and all.
   *
   * Not reformatted and not translated: this is the same string the customer
   * already reads inside their VPN client, and the two disagreeing would be
   * worse than either wording alone.
   */
  readonly name: string;
  /**
   * The host's `serverDescription`, for the cabinet to show as a badge under
   * the name — or `null` when there is nothing worth a badge.
   *
   * This is the field that was once shown AS the name, and the correction is
   * written down here because both readings of it sound reasonable until you
   * look at a VPN client. Incy draws a host as its `remark` in large type with
   * the `serverDescription` in a coloured chip underneath: "Germany - 1" over
   * "ОСНОВНОЙ | СЕРВЕР", "Latvia - 1" over "ОСНОВНОЙ | СЕРВЕР". Operators write
   * it as a CATEGORY, so it repeats across hosts by design. Used as the name, a
   * real operator's list read "ОСНОВНОЙ | СЕРВЕР" five times over five
   * different countries, and a subscriber sent the screenshot.
   *
   * `null` also when it merely repeats the name, so a host whose operator
   * copied one field into the other does not show its name twice.
   */
  readonly description: string | null;
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
