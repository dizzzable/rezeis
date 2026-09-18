import { isIPv4, isIPv6 } from 'node:net';

/**
 * The unit an address-based attempt budget counts in.
 *
 * IPv4: the address. IPv6: its /64 — one subscriber line is handed a whole
 * /64 (often a /56), so every address inside it is the same person, and a
 * budget keyed on the full address is a budget of 2^64 attempts. An
 * IPv4-mapped IPv6 address (`::ffff:192.0.2.1`, which is how a dual-stack
 * socket reports IPv4) counts as the IPv4 address it carries. Anything else
 * — no address, garbage — shares one bucket, which only ever fails closed.
 */
export function ipAttemptBucket(address: string | null | undefined): string {
  const raw = (address ?? '').trim();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(raw);
  if (mapped !== null && isIPv4(mapped[1])) return mapped[1];
  if (isIPv4(raw)) return raw;
  const withoutZone = raw.split('%', 1)[0] ?? '';
  if (!isIPv6(withoutZone)) return 'unknown';
  const hextets = expandIPv6(withoutZone);
  return hextets === null ? 'unknown' : `${hextets.slice(0, 4).join(':')}::/64`;
}

/** The eight hextets of an IPv6 address, lower-case and unpadded, or `null`. */
function expandIPv6(address: string): string[] | null {
  let text = address.toLowerCase();
  // A trailing embedded IPv4 (`::ffff:1.2.3.4`, `64:ff9b::1.2.3.4`) is two hextets.
  const embedded = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (embedded !== null) {
    const [a, b, c, d] = embedded.slice(1).map(Number);
    text = `${text.slice(0, embedded.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] === '' ? [] : halves[0].split(':');
  const tail = halves.length === 2 && halves[1] !== '' ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const all = [...head, ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => '0'), ...tail];
  return all.length === 8 ? all.map((part) => (Number.parseInt(part, 16) || 0).toString(16)) : null;
}
