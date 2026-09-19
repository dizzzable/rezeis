/**
 * Which kind of ownership refusal a `notOwned` row is.
 *
 * The server refuses to link or merge a panel profile unless the `reiwa_id`
 * line of its description PROVES the customer (`assertPanelProfileOwnership`
 * in `src/modules/profile-sync/profile-sync.processor.ts`), and it reports all
 * three ways that can fail under one code, `notOwned`:
 *
 *  • the line names ANOTHER customer — the profile is somebody else's, leave it;
 *  • there is NO such line, or
 *  • the lines name DIFFERENT customers — nothing proves whose it is, and the
 *    way forward is the opposite of "leave it": check it, and prove it.
 *
 * The first keeps `notOwned`; the other two become {@link OWNER_UNPROVEN}, a
 * DISPLAY kind with its own label and remedy. It is read from the reason the
 * server sends with the row, which `assertPanelProfileOwnership` builds from
 * fixed words. The server suite runs THIS function on what that one actually
 * throws (`test/owner-proof-server-contract.spec.ts`), so a reword on either
 * side goes red there; it transpiles this file on its own, so keep it free of
 * imports. `owner-proof.test.tsx` pins this side with copies of the server's
 * sentences. A reason this build cannot read stays `notOwned`: the row is
 * still shown, with the server's words beside it.
 */
export const OWNER_UNPROVEN = 'ownerUnproven'

const UNPROVEN_REASON = /has no 'reiwa_id: <id>' line|names more than one owner/

export function ownerProofKind(kind: string, reason: string | null): string {
  return kind === 'notOwned' && reason !== null && UNPROVEN_REASON.test(reason)
    ? OWNER_UNPROVEN
    : kind
}
