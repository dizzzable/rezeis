/**
 * Squad-set comparison shared by the plan validators and the propagation
 * fan-out, so "did the squads change" means exactly one thing on both sides.
 *
 * Order is deliberately NOT significant. `activeInternalSquads` is a membership
 * set upstream, `normalizeStringArray` already dedupes it, and a subscription's
 * `internal_squads` column can have been written from a panel read
 * (`remnawave-importer.service.ts`) in whatever order the panel listed them.
 * Comparing positionally would report a change that is not one and re-push the
 * identical state to every subscriber of the plan.
 */
export function sameSquadSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  if (rightSet.size !== new Set(left).size) return false;
  return left.every((entry) => rightSet.has(entry));
}

/** True when `left` and `right` name the same internal set and external squad. */
export function sameSquadSelection(
  left: { readonly internalSquads: readonly string[]; readonly externalSquad: string | null },
  right: { readonly internalSquads: readonly string[]; readonly externalSquad: string | null },
): boolean {
  return (
    left.externalSquad === right.externalSquad &&
    sameSquadSet(left.internalSquads, right.internalSquads)
  );
}
