/**
 * The links an operator's QR logo is checked on — synthetic, but of every
 * shape the cabinet puts into a code that can carry a logo, at the lengths
 * those links really come in.
 *
 * ── Why many links and not one sample ───────────────────────────────────────
 *
 * A logo does not break or keep a code on its own: it breaks or keeps a code
 * TOGETHER WITH THE LINK. ZXing accepts a finder pattern whose runs are within
 * 50% of 1:1:3:1:1, and the one-module light moat the renderer leaves round a
 * logo is exactly a finder's light ring. A dark edge next to it is half a
 * cross-section; where the link's own modules happen to supply the other half,
 * ZXing confirms a false finder and drops a real one. The cabinet measured
 * that in both directions — a logo broke 1–10 and mended 5–7 codes in 1 200
 * random links (`reiwa/web/src/lib/qr-logo.ts`, "What geometry cannot
 * promise"). One sample link proves nothing about the next subscriber's.
 *
 * ── The shapes, from the code that builds them ──────────────────────────────
 *
 *   - `invite`  `https://<cabinet host>/register?ref=<referral code>` — the
 *     cabinet's `referrals-page.tsx` and `partner-page.tsx`; the code is a
 *     Prisma `cuid()` (`User.referralCode`), 25 characters.
 *   - `botAd`   `https://t.me/<bot>?start=ad_<code>` — `buildAdDeepLinks` in
 *     the API's `tracking-code.util.ts`; a bot username is 5–32 characters
 *     ending in `bot`, a minted code 10 characters of `[A-Za-z0-9]`.
 *   - `webAd`   `https://<cabinet host>/?campaign=ad_<code>` — the same
 *     builder's `miniAppWeb`.
 *   - `utm`     the web ad with the UTM parameters an operator can append
 *     (`utm_source`, `utm_campaign`) — the longest of the four.
 *
 * Hosts run from 10 to 40 characters, which moves every shape across the
 * symbol versions a logo can be planned on (2–6) rather than pinning it to the
 * one version a single fixture would land in.
 *
 * ── Deterministic ───────────────────────────────────────────────────────────
 *
 * Generated from a fixed seed, so every logo is judged on the SAME links: a
 * verdict is reproducible, two logos are comparable, and re-picking the same
 * file cannot turn a refusal into a pass by luck of the draw.
 */

export type QrLogoLinkShape = 'invite' | 'botAd' | 'webAd' | 'utm'

export const QR_LOGO_LINK_SHAPES: readonly QrLogoLinkShape[] = ['invite', 'botAd', 'webAd', 'utm']

export interface QrLogoCheckLink {
  readonly shape: QrLogoLinkShape
  readonly text: string
}

const LOWER = 'abcdefghijklmnopqrstuvwxyz'
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const DIGITS = '0123456789'
/** `generateTrackingCode`'s alphabet in the API. */
const TRACKING_CODE_ALPHABET = LOWER + UPPER + DIGITS
const BASE36 = LOWER + DIGITS
const TLDS = ['com', 'net', 'org', 'io', 'app', 'ru', 'me', 'pro', 'online', 'vpn'] as const
const UTM_SOURCES = ['telegram', 'instagram', 'youtube', 'vk', 'tiktok', 'partner', 'blog'] as const

/** mulberry32: small, fast and the same sequence on every engine for a given seed. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Random = () => number

const between = (random: Random, min: number, max: number): number =>
  min + Math.floor(random() * (max - min + 1))

const pick = <T>(random: Random, from: readonly T[]): T => from[Math.floor(random() * from.length)] as T

function chars(random: Random, alphabet: string, length: number): string {
  let out = ''
  for (let i = 0; i < length; i += 1) out += alphabet[Math.floor(random() * alphabet.length)]
  return out
}

/** A host name of exactly `length` characters: `label.tld`, sometimes `sub.label.tld`. */
function host(random: Random, length: number): string {
  const tld = pick(random, TLDS)
  const rest = length - tld.length - 1
  if (rest >= 12 && random() < 0.5) {
    const sub = between(random, 3, Math.min(8, rest - 4))
    return `${chars(random, LOWER, sub)}.${label(random, rest - sub - 1)}.${tld}`
  }
  return `${label(random, rest)}.${tld}`
}

/** A DNS label: letters and digits, a hyphen somewhere inside when it is long enough. */
function label(random: Random, length: number): string {
  const body = chars(random, BASE36, length)
  if (length < 6 || random() < 0.5) return `${pick(random, [...LOWER])}${body.slice(1)}`
  const at = between(random, 2, length - 3)
  return `${pick(random, [...LOWER])}${body.slice(1, at)}-${body.slice(at + 1)}`
}

/** A Telegram bot username: 5–32 characters, a letter first, `bot` last. */
function botUsername(random: Random): string {
  const length = between(random, 5, 32)
  const ending = pick(random, ['bot', 'Bot', '_bot'])
  const middle = length - ending.length - 1
  return `${pick(random, [...LOWER, ...UPPER])}${chars(random, `${LOWER}${UPPER}${DIGITS}_`, middle)}${ending}`
}

/** A Prisma `cuid()`: `c` and 24 base-36 characters. */
const cuid = (random: Random): string => `c${chars(random, BASE36, 24)}`

const adCode = (random: Random): string => `ad_${chars(random, TRACKING_CODE_ALPHABET, 10)}`

export function qrLogoCheckLink(shape: QrLogoLinkShape, random: Random): string {
  switch (shape) {
    case 'invite':
      return `https://${host(random, between(random, 10, 40))}/register?ref=${cuid(random)}`
    case 'botAd':
      return `https://t.me/${botUsername(random)}?start=${adCode(random)}`
    case 'webAd':
      return `https://${host(random, between(random, 10, 40))}/?campaign=${adCode(random)}`
    case 'utm':
      return (
        `https://${host(random, between(random, 10, 30))}/?campaign=${adCode(random)}` +
        `&utm_source=${pick(random, UTM_SOURCES)}&utm_campaign=${chars(random, `${LOWER}${DIGITS}_`, between(random, 4, 12))}`
      )
  }
}

/** `perShape` links of every shape, interleaved, from `seed`. The same arguments always give the same links. */
export function sampleQrLogoCheckLinks(perShape: number, seed: number): QrLogoCheckLink[] {
  const random = seededRandom(seed)
  const links: QrLogoCheckLink[] = []
  for (let i = 0; i < perShape; i += 1) {
    for (const shape of QR_LOGO_LINK_SHAPES) links.push({ shape, text: qrLogoCheckLink(shape, random) })
  }
  return links
}
