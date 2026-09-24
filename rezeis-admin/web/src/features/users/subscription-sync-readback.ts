/**
 * WHAT ↻ DID WITH A SUBSCRIPTION IN THE TERM MODEL — the `readback` block of
 * `POST /admin/users/subscriptions/:id/sync`, as the card reads it.
 *
 * In the durable term model a Remnawave read never writes the limits, and
 * writes the expiry only when nothing the panel pushed is newer than the read;
 * a profile holding other limits gets the assigned ones sent back. The server
 * judges that in the units it pushes in, which this card cannot reproduce, so
 * for such a subscription the SERVER's verdict decides what is said about the
 * limits — not the card's own comparison of the panel's reading with the row.
 *
 * Absent outside the model, and from a backend older than the block: the card
 * then says what it always said.
 *
 * A MODULE OF ITS OWN for the reasons `subscription-sync-refusals.ts` gives:
 * `subscription-sync-readback.test.tsx` compares the list below with the
 * backend's own `SUBSCRIPTION_SYNC_PANEL_LIMITS`, and exporting it from the
 * four-thousand-line component would cost that file a react-refresh warning.
 * Hand-written, NOT imported from the backend: nothing the production build
 * compiles may reach into `src/` (`build-isolation.test.ts`).
 */
import { isRecord } from '@/lib/api-utils'

/** Every verdict this build has words for. */
export const SYNC_PANEL_LIMITS_VERDICTS = [
  'IN_STEP',
  'PUT_BACK',
  'OUTRANKED',
  'PROFILE_DELETED',
  'SHARED_PROFILE',
  'UNLINKED',
] as const

export type SyncPanelLimitsVerdict = (typeof SYNC_PANEL_LIMITS_VERDICTS)[number]

/** The verdicts that leave Remnawave holding other limits, with a reason the card names. */
export const LIMITS_NOT_SENT_BACK: ReadonlySet<SyncPanelLimitsVerdict> = new Set([
  'PROFILE_DELETED',
  'SHARED_PROFILE',
  'UNLINKED',
])

export interface SyncReadback {
  /**
   * `null` for a verdict this build has no words for — a backend newer than
   * the card. The card then compares the limits itself, as it always did.
   */
  readonly panelLimits: SyncPanelLimitsVerdict | null
  /** Only an explicit `false` says the expiry was not taken. */
  readonly expiryTaken: boolean
  /** `PUT_BACK` only: what is being sent back. */
  readonly limitsPutBack: {
    /** Whole gigabytes; `null` is unlimited. */
    readonly trafficLimit: number | null
    /** `<= 0` is unlimited. */
    readonly deviceLimit: number
  } | null
}

const KNOWN = new Set<string>(SYNC_PANEL_LIMITS_VERDICTS)

function isKnownVerdict(value: unknown): value is SyncPanelLimitsVerdict {
  return typeof value === 'string' && KNOWN.has(value)
}

function readLimitsPutBack(value: unknown): SyncReadback['limitsPutBack'] {
  if (!isRecord(value)) return null
  const { trafficLimit, deviceLimit } = value
  const traffic = trafficLimit === null || (typeof trafficLimit === 'number' && Number.isFinite(trafficLimit))
  const devices = typeof deviceLimit === 'number' && Number.isFinite(deviceLimit)
  return traffic && devices ? { trafficLimit: trafficLimit as number | null, deviceLimit: deviceLimit as number } : null
}

/** The `readback` block, or `null` when the answer has none. */
export function readSyncReadback(value: unknown): SyncReadback | null {
  if (!isRecord(value)) return null
  const limitsPutBack = readLimitsPutBack(value.limitsPutBack)
  const verdict = isKnownVerdict(value.panelLimits) ? value.panelLimits : null
  return {
    // A put-back the card cannot name the limits of is not described at all:
    // the card's own comparison says more than a sentence with a hole in it.
    panelLimits: verdict === 'PUT_BACK' && limitsPutBack === null ? null : verdict,
    expiryTaken: value.expiryTaken !== false,
    limitsPutBack: verdict === 'PUT_BACK' ? limitsPutBack : null,
  }
}
