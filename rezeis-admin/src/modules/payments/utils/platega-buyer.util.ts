/**
 * Who pays, as Platega asks to be told on every create — a one-off payment on
 * either endpoint and a subscription alike. `metadata` is mandatory there since
 * its documentation of 30.10 and 04.11.2026, and the operator was handed the
 * same rules as a memo («памятка почты», 08.11.2026).
 *
 *  - `user_email` names the buyer, not the payment: Platega knows the buyer and
 *    their history by it. The same value on every payment of one buyer — a new
 *    address per order makes each payment look like a new buyer's.
 *  - `userId` is our own id of the buyer. Some shop categories must send it,
 *    and without it there Platega's antifraud is off and the shop may be
 *    switched off; sending it everywhere costs nothing.
 *
 * `user_email` follows Platega's three recipes, in this order:
 *  1. The Telegram account: `{telegramId}@telegram.org`. The numeric id never
 *     changes, and most buyers come from the bot — whatever address they type
 *     in later, their history stays one.
 *  2. The buyer's own address, unchanged: `User.email`, then the web
 *     account's — the address the panel mails receipts to.
 *  3. Our id of the buyer at a known mail domain: `{userId}@mail.ru`.
 */

export const PLATEGA_TELEGRAM_EMAIL_DOMAIN = 'telegram.org';
export const PLATEGA_FALLBACK_EMAIL_DOMAIN = 'mail.ru';

export interface PlategaBuyer {
  readonly id: string;
  readonly telegramId: bigint | null;
  readonly email: string | null;
  readonly webAccountEmail: string | null;
}

export interface PlategaBuyerMetadata {
  readonly user_email: string;
  readonly userId: string;
}

/** RFC 5321's limit on a whole address. */
const MAX_EMAIL_LENGTH = 254;
/** One `@`, something on each side, a dot in the domain, no spaces: Platega's «проверьте формат адреса». */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function plategaBuyerMetadata(buyer: PlategaBuyer): PlategaBuyerMetadata {
  return { user_email: plategaUserEmail(buyer), userId: buyer.id };
}

export function plategaUserEmail(buyer: PlategaBuyer): string {
  if (buyer.telegramId !== null && buyer.telegramId > 0n) {
    return `${buyer.telegramId.toString()}@${PLATEGA_TELEGRAM_EMAIL_DOMAIN}`;
  }
  for (const candidate of [buyer.email, buyer.webAccountEmail]) {
    const address = candidate?.trim() ?? '';
    if (address.length <= MAX_EMAIL_LENGTH && EMAIL_SHAPE.test(address)) {
      return address;
    }
  }
  return `${buyer.id}@${PLATEGA_FALLBACK_EMAIL_DOMAIN}`;
}
